/**
 * Tool output pruning utilities for compaction.
 */

import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { AgentMessage, AgentToolCall } from "../types";
import { estimateTokens } from "./compaction";
import type { SessionEntry, SessionMessageEntry } from "./entries";
import { invalidateMessageCache } from "./message-cache";
import { collectToolCallsById, isProtectedToolResult, type ProtectedToolMatcher } from "./tool-protection";

export interface PruneConfig {
	/** Keep the most recent tool output tokens intact. */
	protectTokens: number;
	/** Only prune if total savings meets this threshold. */
	minimumSavings: number;
	/** Tool-result protection matchers. String entries protect every result from that tool; predicates may inspect the paired tool call. */
	protectedTools: ProtectedToolMatcher[];
	/** Useless-flagged results bypass the protect window (see {@link USELESS_NOTICE}). Default true. */
	pruneUseless?: boolean;
	/**
	 * Compaction boundary: the `firstKeptEntryId` of the latest compaction on
	 * the branch. Entries at indices BEFORE this id are summarized away and never
	 * sent to the model, so mutating them only churns persisted history without
	 * shrinking the prompt — they are skipped. Undefined = no compaction (the
	 * whole branch is sent).
	 */
	keepBoundaryId?: string;
	/**
	 * Prompt-cache guard. When set, a tool result whose all-message suffix
	 * (tokens of every message after it) EXCEEDS this is part of the warm,
	 * already-sent cache prefix: mutating it forces the provider to re-write the
	 * whole suffix (cacheWrite premium). Results in that prefix are left for
	 * compaction or shake, which rebuild the cache, to reclaim. Undefined means
	 * no cache guard.
	 */
	cacheWarmSuffixTokens?: number;
}

export const DEFAULT_PRUNE_CONFIG: PruneConfig = {
	protectTokens: 40_000,
	minimumSavings: 20_000,
	protectedTools: [],
	pruneUseless: true,
};

export interface PruneResult {
	prunedCount: number;
	tokensSaved: number;
}

/** Exact placeholder written over an elided useless tool result. */
export const USELESS_NOTICE = "[Uneventful result elided]";

const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;
const DEFAULT_IDLE_FLUSH_MS = 30 * 60_000;

function createPrunedNotice(tokens: number): string {
	return `[Output truncated - ${tokens} tokens]`;
}

/**
 * Generic age-based pruning floor. Below this, blanking a result to
 * `[Output truncated - N tokens]` recovers nothing — the placeholder itself
 * costs ~8 tokens, so a sub-floor result grows the context (and churns the
 * prompt cache) instead of shrinking it. Useless results use their own
 * no-savings check.
 */
const MIN_PRUNE_TOKENS = 50;

function getToolResultMessage(entry: SessionEntry): ToolResultMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as AgentMessage;
	if (message.role !== "toolResult") return undefined;
	return message as ToolResultMessage;
}

function estimatePrunedSavings(tokens: number, notice: string): number {
	const noticeTokens = Math.ceil(notice.length / 4);
	return Math.max(0, tokens - noticeTokens);
}

/**
 * For each entry index, the estimated token total of all *message* entries
 * strictly after it — how much prompt-cache content the provider must re-write
 * (cacheWrite premium) if that entry is mutated in place. Used to keep prune
 * mutations inside the cheap-to-recache tail.
 */
function computeMessageSuffixTokens(entries: readonly SessionEntry[]): number[] {
	const suffix = new Array<number>(entries.length);
	let accumulated = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		suffix[i] = accumulated;
		const entry = entries[i];
		if (entry.type === "message") accumulated += estimateTokens(entry.message as AgentMessage);
	}
	return suffix;
}

/**
 * Resolve the array index of the compaction boundary (`keepBoundaryId`). Entries
 * before this index are summarized away by the latest compaction and never sent,
 * so prune passes must not mutate them. Returns 0 when there is no boundary (no
 * compaction → whole branch is sent) or the id is absent from `entries`.
 */
function resolveBoundaryIndex(entries: readonly SessionEntry[], keepBoundaryId: string | undefined): number {
	if (keepBoundaryId === undefined) return 0;
	const index = entries.findIndex(entry => entry.id === keepBoundaryId);
	return index < 0 ? 0 : index;
}

interface PruneCandidate {
	entry: SessionMessageEntry;
	message: ToolResultMessage;
	/** Index of the entry within the `entries` array. */
	index: number;
	tokens: number;
}

/**
 * Collect tool results their tool flagged contextually useless (zero matches,
 * elapsed wait): unpruned, non-error, unprotected, and large
 * enough that blanking to {@link USELESS_NOTICE} actually saves tokens.
 * Returned in message order.
 */
function collectUselessResults(
	entries: readonly SessionEntry[],
	toolCallsById: ReadonlyMap<string, AgentToolCall>,
	protectedTools: readonly ProtectedToolMatcher[],
): PruneCandidate[] {
	const candidates: PruneCandidate[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (message?.useless !== true || message.prunedAt !== undefined || message.isError === true) continue;
		if (isProtectedToolResult(message, toolCallsById.get(message.toolCallId), protectedTools)) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (estimatePrunedSavings(tokens, USELESS_NOTICE) <= 0) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, index: i, tokens });
	}
	return candidates;
}

/**
 * Prune tool results that the tool marked contextually useless. The pass is
 * cache-aware: it only rewrites a cheap tail, or the whole live region after
 * the provider cache has gone cold. Entries before the latest compaction
 * boundary are already summarized away and never rewritten.
 */
export interface UselessPruneConfig {
	/** Prune a candidate now when all later messages total at most this many estimated tokens. Default 8 000. */
	suffixTokenLimit?: number;
	/** Treat the provider cache as cold after this idle period. Default 30 minutes. */
	idleFlushMs?: number;
	/** Clock override for tests. */
	now?: number;
	/** Latest compaction boundary; earlier entries are summarized away. */
	keepBoundaryId?: string;
	/** Tool-result protection matchers. */
	protectedTools: readonly ProtectedToolMatcher[];
}

export function pruneUselessToolResults(entries: SessionEntry[], config: UselessPruneConfig): PruneResult {
	const toolCallsById = collectToolCallsById(entries);
	const candidates = collectUselessResults(entries, toolCallsById, config.protectedTools);
	if (candidates.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const now = config.now ?? Date.now();
	let lastMessageTimestamp: number | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const timestamp = (entry.message as AgentMessage).timestamp;
		if (typeof timestamp === "number") lastMessageTimestamp = timestamp;
		break;
	}
	const idle =
		lastMessageTimestamp !== undefined && now - lastMessageTimestamp >= (config.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS);
	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const toPrune = idle
		? candidates.filter(candidate => candidate.index >= boundaryIndex)
		: (() => {
				const suffixTokenLimit = config.suffixTokenLimit ?? DEFAULT_SUFFIX_TOKEN_LIMIT;
				const suffixTokens = computeMessageSuffixTokens(entries);
				return candidates.filter(
					candidate => candidate.index >= boundaryIndex && suffixTokens[candidate.index] <= suffixTokenLimit,
				);
			})();
	if (toPrune.length === 0) return { prunedCount: 0, tokensSaved: 0 };

	const prunedAt = Date.now();
	let tokensSaved = 0;
	for (const candidate of toPrune) {
		candidate.message.content = [{ type: "text", text: USELESS_NOTICE }];
		candidate.message.prunedAt = prunedAt;
		invalidateMessageCache(candidate.message as AgentMessage);
		tokensSaved += estimatePrunedSavings(candidate.tokens, USELESS_NOTICE);
	}
	return { prunedCount: toPrune.length, tokensSaved };
}

export function pruneToolOutputs(entries: SessionEntry[], config: PruneConfig = DEFAULT_PRUNE_CONFIG): PruneResult {
	let accumulatedTokens = 0;
	let tokensSaved = 0;
	let prunedCount = 0;

	const candidates: Array<{ entry: SessionMessageEntry; tokens: number; useless: boolean }> = [];
	const toolCallsById = collectToolCallsById(entries);
	const uselessMessages =
		config.pruneUseless !== false
			? new Set(
					collectUselessResults(entries, toolCallsById, config.protectedTools).map(candidate => candidate.message),
				)
			: undefined;

	const boundaryIndex = resolveBoundaryIndex(entries, config.keepBoundaryId);
	const cacheWarmSuffixTokens = config.cacheWarmSuffixTokens;
	// All-message suffix per index, only when the cache guard is armed.
	const messageSuffix = cacheWarmSuffixTokens === undefined ? undefined : computeMessageSuffixTokens(entries);

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getToolResultMessage(entry);
		if (!message) continue;

		const tokens = estimateTokens(message as AgentMessage);
		const isProtected = isProtectedToolResult(message, toolCallsById.get(message.toolCallId), config.protectedTools);

		if (message.prunedAt !== undefined) {
			accumulatedTokens += tokens;
			continue;
		}

		// Prompt-cache guard: a result whose all-message suffix exceeds the
		// warm-cache window sits in the already-sent cached prefix — mutating it
		// re-writes the whole suffix (cacheWrite premium). Entries before the
		// compaction boundary are summarized away (never sent). Both are skipped
		// before any prune decision, so a deep cached copy is left for compaction or
		// shake to reclaim when it rebuilds the cache.
		const inWarmPrefix =
			messageSuffix !== undefined && cacheWarmSuffixTokens !== undefined && messageSuffix[i] > cacheWarmSuffixTokens;
		if (inWarmPrefix || i < boundaryIndex) {
			accumulatedTokens += tokens;
			continue;
		}

		// Results marked useless bypass the age-based protect window, but the
		// cache guard above still leaves deep cached copies untouched.
		const useless = uselessMessages?.has(message) ?? false;
		const tooSmall = tokens < MIN_PRUNE_TOKENS;
		if (!useless && (accumulatedTokens < config.protectTokens || isProtected || tooSmall)) {
			accumulatedTokens += tokens;
			continue;
		}

		candidates.push({ entry: entry as SessionMessageEntry, tokens, useless });
		accumulatedTokens += tokens;
	}

	for (const candidate of candidates) {
		tokensSaved += estimatePrunedSavings(
			candidate.tokens,
			candidate.useless ? USELESS_NOTICE : createPrunedNotice(candidate.tokens),
		);
	}

	if (tokensSaved < config.minimumSavings || candidates.length === 0) {
		return { prunedCount: 0, tokensSaved: 0 };
	}

	const prunedAt = Date.now();
	for (const candidate of candidates) {
		const message = candidate.entry.message as ToolResultMessage;
		const notice = candidate.useless ? USELESS_NOTICE : createPrunedNotice(candidate.tokens);
		message.content = [{ type: "text", text: notice }];
		message.prunedAt = prunedAt;
		invalidateMessageCache(message as AgentMessage);
		prunedCount++;
	}

	return { prunedCount, tokensSaved };
}

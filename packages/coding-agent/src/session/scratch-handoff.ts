import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { isEnoent, prompt } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import scratchHandoffTemplate from "../prompts/system/scratch-handoff.md" with { type: "text" };
import scratchHandoffCloseoutTemplate from "../prompts/system/scratch-handoff-closeout.md" with { type: "text" };
import scratchHandoffResumeTemplate from "../prompts/system/scratch-handoff-resume.md" with { type: "text" };

import { resolveToCwd } from "../tools/path-utils";

import { createCustomMessage } from "./messages";
import type { SessionEntry } from "./session-entries";

export const SCRATCH_HANDOFF_READ_CUSTOM_TYPE = "scratch-handoff-read";
export const SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE = "scratch-handoff-write";
export const SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE = "scratch-handoff-closeout";

export interface ScratchHandoffSettings {
	enabled: boolean;
	rootDir: string | undefined;
}

export interface ScratchHandoffContext {
	/** Path the agent should use in tool calls. */
	displayPath: string;
	/** Absolute path used by the runtime to create/read the file. */
	absolutePath: string;
	/** Developer instruction block appended to the system prompt. */
	prompt: string;
	/** Current scratch file body provided as continuation state. */
	scratchText: string;
	/** Whether the scratch file already exists. */
	exists: boolean;
	/** Parent session scratch file, linked from subagent scratch files. */
	parentDisplayPath?: string;
}

export interface ScratchHandoffPathSelection {
	/** Explicit scratch file used for this session, including paths restored from persisted session state. */
	scratchFile?: string;
	/** Parent session scratch file carried across resumed subagent sessions. */
	parentScratchDisplayPath?: string;
}

export function scratchHandoffDate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

export function resolveScratchHandoffPath(input: {
	cwd: string;
	rootDir: string | undefined;
	sessionId: string;
	agentId?: string;
	scratchFile?: string;
	date?: Date;
}): { displayPath: string; absolutePath: string } {
	const explicitPath = input.scratchFile?.trim();
	if (explicitPath) {
		return {
			displayPath: explicitPath.split(path.sep).join("/"),
			absolutePath: resolveToCwd(explicitPath, input.cwd),
		};
	}
	const rootDir = input.rootDir?.trim() || "agent";
	const safeSessionId = input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	const safeAgentId = input.agentId?.trim().replace(/[^a-zA-Z0-9._-]/g, "-") || safeSessionId;
	const fileName = safeAgentId === safeSessionId ? `${safeSessionId}.org` : `${safeAgentId}-${safeSessionId}.org`;
	const displayPath = path.join(rootDir, scratchHandoffDate(input.date), fileName).split(path.sep).join("/");
	const absolutePath = resolveToCwd(displayPath, input.cwd);
	return { displayPath, absolutePath };
}

interface ScratchTodoSubtree {
	objective: string;
	nextAction: string;
}

function fieldValue(lines: readonly string[], label: string): string {
	const prefix = `- ${label}:`;
	const index = lines.findIndex(line => line.startsWith(prefix));
	if (index < 0) return "";
	const values = [lines[index].slice(prefix.length).trim()];
	for (let cursor = index + 1; cursor < lines.length; cursor++) {
		const line = lines[cursor];
		if (/^-\s+\S[^:]*:/.test(line)) break;
		if (/^\s+(?:[-+*]|\d+\.)\s+\S/.test(line)) values.push(line.trim());
		else if (line.trim()) break;
	}
	return values.filter(Boolean).join("\n");
}

/** Parse one unambiguous root TODO and its direct field body. */
function activeScratchTodo(text: string): ScratchTodoSubtree | undefined {
	const lines = text.split(/\r?\n/);
	const roots: number[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (/^\*\s+TODO\s+\S/.test(lines[index])) roots.push(index);
	}
	if (roots.length !== 1) return undefined;
	const start = roots[0] + 1;
	let end = lines.length;
	for (let index = start; index < lines.length; index++) {
		if (/^\*+\s+(?:TODO|DONE)\s+\S/.test(lines[index])) {
			end = index;
			break;
		}
	}
	const body = lines.slice(start, end);
	return {
		objective: fieldValue(body, "Objective"),
		nextAction: fieldValue(body, "Next action"),
	};
}

/** True when the active root TODO contains resumable state. */
export function scratchHandoffHasContent(text: string): boolean {
	const todo = activeScratchTodo(text);
	return todo !== undefined && (todo.objective.length > 0 || todo.nextAction.length > 0);
}

/** True when one active root TODO has its own objective and next action. */
export function scratchHandoffIsComplete(text: string): boolean {
	const todo = activeScratchTodo(text);
	return todo !== undefined && todo.objective.length > 0 && todo.nextAction.length > 0;
}

/**
 * Continuity state of the scratch document for one maintenance pass.
 *
 * - `verified`: resumable content that already covers every message in the delta
 *   window, so it can anchor composed native or standard compaction.
 * - `stale`: resumable content with work recorded after the last scratch write.
 *   The attached delta and the closeout instruction carry that work; this is the
 *   ordinary state whenever context pressure arrives before a closeout turn.
 * - `unusable`: the document lacks the objective, open TODO, or next action an
 *   autonomous resume needs, so the model must rebuild it.
 */
export type ScratchContinuityState = "verified" | "stale" | "unusable";

/** Classify scratch continuity from document content and recorded write state. */
export function resolveScratchContinuityState(input: {
	scratchText: string;
	/** A closeout turn wrote the document during this maintenance episode. */
	closeoutWriteCompleted: boolean;
	/** The current branch records at least one write to this scratch path. */
	hasRecordedWrite: boolean;
	/** Session work landed after the newest recorded write. */
	hasDelta: boolean;
}): ScratchContinuityState {
	if (!scratchHandoffIsComplete(input.scratchText)) return "unusable";
	if (input.closeoutWriteCompleted) return "verified";
	return input.hasRecordedWrite && !input.hasDelta ? "verified" : "stale";
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scratchHandoffDetails(details: unknown): ScratchHandoffPathSelection | undefined {
	if (!isRecord(details)) return undefined;
	const record = details;
	const scratchFile = nonEmptyString(record.path);
	const parentScratchDisplayPath = nonEmptyString(record.parentPath);
	if (!scratchFile && !parentScratchDisplayPath) return undefined;
	return { scratchFile, parentScratchDisplayPath };
}

export function latestPersistedScratchHandoffPathSelection(
	entries: readonly SessionEntry[],
): ScratchHandoffPathSelection | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom_message" || entry.customType !== SCRATCH_HANDOFF_READ_CUSTOM_TYPE) continue;
		const selection = scratchHandoffDetails(entry.details);
		if (selection?.scratchFile) return selection;
	}
	return undefined;
}

export function resolveScratchHandoffPathSelection(input: {
	entries: readonly SessionEntry[];
	scratchFile?: string;
	parentScratchDisplayPath?: string;
}): ScratchHandoffPathSelection {
	const persisted = latestPersistedScratchHandoffPathSelection(input.entries);
	const explicitParent = nonEmptyString(input.parentScratchDisplayPath);
	return {
		scratchFile: nonEmptyString(input.scratchFile) ?? (explicitParent ? undefined : persisted?.scratchFile),
		parentScratchDisplayPath: explicitParent ?? persisted?.parentScratchDisplayPath,
	};
}

export type ScratchHandoffMessageConverter = (messages: AgentMessage[]) => Message[];

function sessionEntryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type !== "custom_message") return undefined;
	if (entry.customType === SCRATCH_HANDOFF_READ_CUSTOM_TYPE) return undefined;
	return createCustomMessage(
		entry.customType,
		entry.content,
		entry.display,
		entry.details,
		entry.timestamp,
		entry.attribution,
	);
}

/** Smallest inline delta the recent-context budget ever allows. */
export const SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS = 2_048;
/** Share of the context window an inline delta may consume. */
export const SCRATCH_HANDOFF_RECENT_CONTEXT_WINDOW_FRACTION = 0.1;
/** Maximum scratch-body prefix injected after compaction or resume. */
export const SCRATCH_HANDOFF_BODY_MAX_TOKENS = 2_048;

export interface ScratchHandoffBodyPreview {
	text: string;
	truncated: boolean;
}

/** Keep a token-safe beginning; detailed history remains readable from disk. */
export function scratchHandoffBodyPreview(
	text: string,
	maxTokens = SCRATCH_HANDOFF_BODY_MAX_TOKENS,
): ScratchHandoffBodyPreview {
	if (countTokens(text) <= maxTokens) return { text, truncated: false };
	const lines = text.split(/(?<=\n)/);
	let low = 0;
	let high = lines.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (countTokens(lines.slice(0, middle).join("")) <= maxTokens) low = middle;
		else high = middle - 1;
	}
	if (low > 0) return { text: lines.slice(0, low).join("").trimEnd(), truncated: true };

	const codepoints = Array.from(text);
	low = 0;
	high = codepoints.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (countTokens(codepoints.slice(0, middle).join("")) <= maxTokens) low = middle;
		else high = middle - 1;
	}
	return { text: codepoints.slice(0, low).join(""), truncated: true };
}

/**
 * scratchHandoffRecentContextBudget sizes the inline delta carried past a
 * handoff.
 *
 * Everything in the rebuilt context is a new prefix paid at full price, so an
 * unbounded inline delta re-buys the context the handoff exists to release.
 * Applies to serialized text only: a SnapCompact archive of the same delta is
 * bounded by its own frame budget and carries far more work per prefix token,
 * so it is never trimmed against this number.
 */
export function scratchHandoffRecentContextBudget(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS;
	return Math.max(
		SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS,
		Math.floor(contextWindow * SCRATCH_HANDOFF_RECENT_CONTEXT_WINDOW_FRACTION),
	);
}

/**
 * Index of the first entry the latest compaction kept. Entries before it left
 * the model context at that boundary, so the delta window must never reach back
 * across it even when no scratch write has been recorded since.
 */
function latestCompactionBoundaryIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const keptIndex = entries.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
		return keptIndex >= 0 ? keptIndex : index + 1;
	}
	return 0;
}

/** First entry of the work not yet represented in the scratch document. */
function scratchHandoffDeltaStartIndex(entries: readonly SessionEntry[], scratchPath?: string): number {
	let start = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE) continue;
		if (scratchPath && (!isRecord(entry.data) || entry.data.path !== scratchPath)) continue;
		start = index + 1;
		break;
	}
	return Math.max(start, latestCompactionBoundaryIndex(entries));
}

/** Work recorded after the scratch document was last written. */
export interface ScratchHandoffDelta {
	/**
	 * The complete delta. Use it for representations that carry their own bound
	 * and compress well, such as a SnapCompact archive.
	 */
	text: string;
	/**
	 * The delta trimmed to the caller's token budget, for inline prefix text.
	 * Equal to {@link text} when the delta already fits.
	 */
	bounded: string;
}

/** Keep the newest complete messages whose serialized conversation fits. */
function trimDeltaToBudget(messages: Message[], maxTokens: number): { kept: Message[]; dropped: number } {
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) return { kept: messages, dropped: 0 };
	let start = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages.slice(index);
		if (countTokens(snapcompact.serializeConversation(candidate)) > maxTokens) break;
		start = index;
	}
	return { kept: messages.slice(start), dropped: start };
}

function tailWithinTokenBudget(text: string, maxTokens: number, prefix: string): string {
	if (countTokens(`${prefix}${text}`) <= maxTokens) return `${prefix}${text}`;
	if (countTokens(prefix) > maxTokens) {
		const prefixCodepoints = Array.from(prefix);
		let prefixLow = 0;
		let prefixHigh = prefixCodepoints.length;
		while (prefixLow < prefixHigh) {
			const middle = Math.ceil((prefixLow + prefixHigh) / 2);
			if (countTokens(prefixCodepoints.slice(0, middle).join("")) <= maxTokens) prefixLow = middle;
			else prefixHigh = middle - 1;
		}
		return prefixCodepoints.slice(0, prefixLow).join("");
	}
	const codepoints = Array.from(text);
	let low = 0;
	let high = codepoints.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = `${prefix}${codepoints.slice(codepoints.length - middle).join("")}`;
		if (countTokens(candidate) <= maxTokens) low = middle;
		else high = middle - 1;
	}
	return `${prefix}${codepoints.slice(codepoints.length - low).join("")}`;
}

export function buildScratchHandoffRecentContext(input: {
	entries: readonly SessionEntry[];
	pendingMessages?: readonly AgentMessage[];
	scratchPath?: string;
	convertToLlm: ScratchHandoffMessageConverter;
	/** Token ceiling for {@link ScratchHandoffDelta.bounded}; unbounded when omitted. */
	maxTokens?: number;
}): ScratchHandoffDelta | undefined {
	const pendingMessages = input.pendingMessages ?? [];
	const messages = input.convertToLlm([
		...input.entries
			.slice(scratchHandoffDeltaStartIndex(input.entries, input.scratchPath))
			.map(sessionEntryMessage)
			.filter((message): message is AgentMessage => message !== undefined),
		...pendingMessages,
	]);
	const text = snapcompact.serializeConversation(messages).trim();
	if (text.length === 0) return undefined;
	const maxTokens = input.maxTokens ?? Number.POSITIVE_INFINITY;
	let { kept, dropped } = trimDeltaToBudget(messages, maxTokens);
	if (dropped === 0) return { text, bounded: text };

	let serializedKept = snapcompact.serializeConversation(kept).trim();
	let prefix = "";
	while (true) {
		const omitted =
			kept.length === 0
				? `${dropped} message${dropped === 1 ? "" : "s"}; newest message exceeded the inline budget`
				: `${dropped} older message${dropped === 1 ? "" : "s"}`;
		prefix = `[Older session context dropped: ${omitted} omitted. Re-derive missing detail from workspace or linked artifacts; never assume it.]\n\n`;
		if (kept.length === 0 || countTokens(`${prefix}${serializedKept}`) <= maxTokens) break;
		kept = kept.slice(1);
		dropped++;
		serializedKept = snapcompact.serializeConversation(kept).trim();
	}
	const bounded = kept.length > 0 ? `${prefix}${serializedKept}` : tailWithinTokenBudget(text, maxTokens, prefix);
	return { text, bounded };
}

export async function buildScratchHandoffContext(input: {
	cwd: string;
	rootCwd?: string;
	sessionId: string;
	agentId?: string;
	scratchFile?: string;
	settings: ScratchHandoffSettings;
	parentScratchDisplayPath?: string;
	date?: Date;
}): Promise<ScratchHandoffContext | undefined> {
	if (!input.settings.enabled && !input.scratchFile?.trim() && !input.parentScratchDisplayPath?.trim())
		return undefined;
	const { displayPath, absolutePath } = resolveScratchHandoffPath({
		cwd: input.rootCwd ?? input.cwd,
		rootDir: input.settings.rootDir,
		sessionId: input.sessionId,
		agentId: input.agentId,
		scratchFile: input.scratchFile,
		date: input.date,
	});
	let scratchText = "";
	let exists = true;
	try {
		scratchText = (await fs.readFile(absolutePath, "utf8")).trim();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		exists = false;
	}
	return {
		displayPath,
		absolutePath,
		parentDisplayPath: input.parentScratchDisplayPath,
		prompt: prompt.render(scratchHandoffTemplate, {
			displayPath,
			sessionId: input.sessionId,
			parentDisplayPath: input.parentScratchDisplayPath,
			exists,
		}),
		scratchText,
		exists,
	};
}

export function renderScratchHandoffCloseoutMessage(displayPath: string, create = false): string {
	return prompt.render(scratchHandoffCloseoutTemplate, {
		displayPath,
		create,
		toolName: create ? "write" : "edit",
	});
}

/**
 * Build the first model-visible message after scratch compaction or process
 * resume. It directs the model to select only skills needed by immediate work,
 * continue from the scratch org TODO state, and avoid restarting.
 */
export function renderScratchHandoffResumeMessage(input: {
	displayPath: string;
	scratchText: string;
	parentDisplayPath?: string;
	recentContextText?: string;
	recentContextSnapcompactFrames?: number;
	scratchTruncated?: boolean;
	scratchMissing?: boolean;
}): string {
	return prompt.render(scratchHandoffResumeTemplate, {
		...input,
		recentContextText: input.recentContextText?.trim(),
	});
}

export function renderScratchHandoffSyntheticRead(context: ScratchHandoffContext): string {
	const preview = scratchHandoffBodyPreview(context.scratchText);
	return renderScratchHandoffResumeMessage({
		displayPath: context.displayPath,
		scratchMissing: !context.exists,
		scratchText: preview.text,
		scratchTruncated: preview.truncated,
		parentDisplayPath: context.parentDisplayPath,
	});
}

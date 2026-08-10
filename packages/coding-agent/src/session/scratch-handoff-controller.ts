/** Scratch handoff continuity for an active coding-agent session. */

import * as fs from "node:fs";

import {
	type Agent,
	type AgentContext,
	type AgentMessage,
	type AgentPreModelCallResult,
	countTokens,
} from "@oh-my-pi/pi-agent-core";
import {
	AGGRESSIVE_SHAKE_CONFIG,
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	collectShakeRegions,
	compactionContextTokens,
	effectiveReserveTokens,
	estimateTokens,
	resolveThresholdTokens,
	type ShakeRegion,
	shouldCompact,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Context, Message, Model } from "@oh-my-pi/pi-ai";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { Settings } from "../config/settings";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { AutoCompactionReason } from "../extensibility/shared-events";
import type { NonMessageTokenSource } from "../modes/utils/context-usage";
import { computeNonMessageTokens, estimateToolSchemaTokens } from "../modes/utils/context-usage";
import { resolveToCwd } from "../tools/path-utils";
import { shouldRunScratchHandoffMaintenance } from "./compaction-strategy";
import type { CustomMessage } from "./messages";
import {
	buildScratchHandoffRecentContext,
	renderScratchHandoffCloseoutMessage,
	renderScratchHandoffResumeMessage,
	resolveScratchContinuityState,
	SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE,
	SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
	SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
	type ScratchContinuityState,
	type ScratchHandoffDelta,
	scratchHandoffBodyPreview,
	scratchHandoffRecentContextBudget,
} from "./scratch-handoff";
import type { SessionContext } from "./session-context";
import { getLatestCompactionEntry } from "./session-context";
import type { ScratchCompactionModes } from "./session-entries";
import { COMPACTION_CHECK_NONE, type CompactionCheckResult } from "./session-maintenance";
import type { SessionManager } from "./session-manager";
import type { ShakeMode, ShakeResult } from "./shake-types";

/**
 * Headroom reserved for the closeout instruction itself. The trigger has to
 * leave room for the prompt that asks for the pencils-down turn, or the turn
 * that would write the scratch document is the turn that overflows.
 */
const SCRATCH_HANDOFF_CLOSEOUT_MIN_HEADROOM_TOKENS = 4_096;

/** Prepared scratch continuity payload for one maintenance pass. */
export interface PreparedScratchHandoffContext {
	content: CustomMessage["content"];
	tokensBefore: number;
	state: ScratchContinuityState;
}

/** Pre-provider stop recorded when one more closeout turn would overflow. */
export interface PreProviderScratchHandoffStop {
	contextTokens: number;
	contextWindow: number;
	promptBudget: number;
	scratchPath: string;
	thresholdTokens: number;
}

/** Capabilities borrowed from the owning AgentSession. */
export interface ScratchHandoffHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	model(): Model | undefined;
	nonMessageTokenSource(): NonMessageTokenSource;
	getContextUsage(options?: { contextWindow?: number }): ContextUsage | undefined;
	estimateStoredContextTokens(): number;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	convertToLlmForSideRequest(messages: AgentMessage[]): Message[];
	buildDisplaySessionContext(): SessionContext;
	resetAdvisorRuntimes(): void;
	closeCodexProviderSessionsForHistoryRewrite(): void;
	markPrefixReset(): void;
	/** Clear per-turn asides, scheduled hidden turns, and todo reminder state at a scratch boundary. */
	resetTurnStateForScratchBoundary(): void;
	waitForIdle(): Promise<void>;
	promptCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">,
	): Promise<void>;
	queueCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details" | "attribution">,
		deliverAs: "steer" | "followUp",
		queueChipText?: string,
	): Promise<void>;
	runAutoCompaction(
		reason: AutoCompactionReason,
		willRetry: boolean,
		deferred: boolean,
		allowDefer: boolean,
		options: { autoContinue?: boolean; triggerContextTokens?: number },
	): Promise<CompactionCheckResult>;
	/** Settles the pending `message_end` persistence tail before a branch rewrite. */
	messageEndPersistenceTail(): Promise<void>;
	shakeElidePlaceholder(region: ShakeRegion, index: number, artifactId: string | undefined): string;
	applyShakeRegions(
		mode: Exclude<ShakeMode, "images">,
		regions: ShakeRegion[],
		requireArtifact?: boolean,
	): Promise<ShakeResult>;
}

/** Construction-time scratch identity for this session. */
export interface ScratchHandoffControllerOptions {
	/** Path the agent uses in IPython cells; absent when scratch handoff is off. */
	displayPath: string | undefined;
	/** Base directory for relative scratch paths inherited by child sessions. */
	rootCwd: string | undefined;
	/** Parent scratch file linked from this session's scratch file. */
	parentDisplayPath: string | undefined;
}

/**
 * Owns the scratch continuity document: write tracking, the pencils-down
 * closeout turn, and the scratch-anchored context rebuild that replaces an
 * LLM-authored handoff when a scratch document is active.
 */
/**
 * Named progress points a scratch pass reports to its owner. The controller does
 * not know about trace identity; the maintenance owner correlates these.
 */
export type ScratchHandoffPhase =
	| "scratch-target-resolved"
	| "scratch-read-injected"
	| "scratch-session-compacted"
	| "scratch-session-rebuilt";

/** Reports a phase as it completes; supplied by the owner running the pass. */
export type ScratchHandoffPhaseReporter = (phase: ScratchHandoffPhase) => Promise<void>;

export class ScratchHandoffController {
	readonly #host: ScratchHandoffHost;
	#displayPath: string | undefined;
	readonly #rootCwd: string | undefined;
	#parentDisplayPath: string | undefined;
	#preProviderStop: PreProviderScratchHandoffStop | undefined;
	#closeout:
		| {
				scratchPath: string;
				baselineScratchText: string | undefined;
				baselineWriteCount: number;
				writeCompleted: boolean;
				/** One-shot: later tool continuations in the closeout MUST keep their results. */
				toolResultElisionPending: boolean;
				triggerContextTokens?: number;
				reason: AutoCompactionReason;
		  }
		| undefined;

	constructor(host: ScratchHandoffHost, options: ScratchHandoffControllerOptions) {
		this.#host = host;
		this.#displayPath = options.displayPath;
		this.#rootCwd = options.rootCwd;
		this.#parentDisplayPath = options.parentDisplayPath;
	}

	get displayPath(): string | undefined {
		return this.#displayPath;
	}

	get rootCwd(): string | undefined {
		return this.#rootCwd;
	}

	get parentDisplayPath(): string | undefined {
		return this.#parentDisplayPath;
	}

	/** Whether a scratch continuity document backs this session. */
	get isActive(): boolean {
		return this.#displayPath !== undefined;
	}

	/** Whether a closeout turn is staged for the current maintenance episode. */
	get hasStagedCloseout(): boolean {
		return this.#closeout !== undefined;
	}

	/** Reason recorded when the current closeout was staged. */
	get stagedCloseoutReason(): AutoCompactionReason | undefined {
		return this.#closeout?.reason;
	}

	/** Discard the staged closeout after a maintenance pass consumed it. */
	clearCloseout(): void {
		this.#closeout = undefined;
	}

	#scratchExists(scratchPath: string): boolean {
		try {
			return fs.existsSync(resolveToCwd(scratchPath, this.#host.sessionManager.getCwd()));
		} catch {
			return false;
		}
	}

	/**
	 * requestCloseoutForBudgetStop runs one bounded pencils-down turn when the
	 * current context still leaves room for the handoff prompt.
	 */
	async requestCloseoutForBudgetStop(triggerContextTokens?: number): Promise<boolean> {
		const scratchPath = this.#displayPath;
		if (scratchPath === undefined) return false;
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (contextWindow <= 0) return false;
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const closeoutTriggerTokens = this.closeoutTriggerTokens(contextWindow, compactionSettings, scratchPath);
		if (closeoutTriggerTokens <= 0) return false;
		const contextTokens = compactionContextTokens(
			this.#host.getContextUsage({ contextWindow })?.tokens ?? 0,
			this.#host.estimateStoredContextTokens(),
		);
		if (contextTokens > closeoutTriggerTokens) return false;
		return this.requestCloseout(triggerContextTokens ?? contextTokens, true);
	}

	#writeCount(scratchPath: string): number {
		let count = 0;
		for (const entry of this.#host.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE) continue;
			if (!isRecord(entry.data) || entry.data.path !== scratchPath) continue;
			count++;
		}
		return count;
	}

	#scratchText(scratchPath: string): string | undefined {
		try {
			return fs.readFileSync(resolveToCwd(scratchPath, this.#host.sessionManager.getCwd()), "utf8");
		} catch {
			return undefined;
		}
	}

	/** Record a successful IPython closeout cell when it changed the scratch document. */
	recordToolExecutionEnd(toolName: string, isError: boolean): void {
		const closeout = this.#closeout;
		if (isError || toolName !== "ipython" || !closeout || closeout.writeCompleted) return;
		const scratchText = this.#scratchText(closeout.scratchPath);
		if (scratchText === undefined || scratchText === closeout.baselineScratchText) return;
		this.#host.sessionManager.appendCustomEntry(SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE, { path: closeout.scratchPath });
		closeout.writeCompleted = true;
	}

	/**
	 * Work recorded after the last scratch write. `bounded` is what may go into
	 * the rebuilt prefix as text; `text` is the full delta for SnapCompact, which
	 * bounds itself by frame budget and carries far more work per prefix token.
	 */
	#recentContext(pendingMessages: readonly AgentMessage[] = []): ScratchHandoffDelta | undefined {
		return buildScratchHandoffRecentContext({
			entries: this.#host.sessionManager.getBranch(),
			scratchPath: this.#displayPath,
			pendingMessages,
			maxTokens: scratchHandoffRecentContextBudget(this.#host.model()?.contextWindow ?? 0),
			convertToLlm: messages => this.#host.convertToLlmForSideRequest(messages),
		});
	}

	/** Stage a closeout for `scratchPath`; returns false when one is already staged. */
	stageCloseout(scratchPath: string, triggerContextTokens: number | undefined, reason: AutoCompactionReason): boolean {
		const existing = this.#closeout;
		if (existing?.scratchPath === scratchPath) {
			if (
				triggerContextTokens !== undefined &&
				(existing.triggerContextTokens === undefined || triggerContextTokens > existing.triggerContextTokens)
			) {
				existing.triggerContextTokens = triggerContextTokens;
			}
			return false;
		}
		this.#closeout = {
			scratchPath,
			baselineScratchText: this.#scratchText(scratchPath),
			baselineWriteCount: this.#writeCount(scratchPath),
			writeCompleted: false,
			toolResultElisionPending: true,
			triggerContextTokens,
			reason,
		};
		return true;
	}

	async requestCloseout(
		triggerContextTokens?: number,
		runImmediately = false,
		reason: AutoCompactionReason = "threshold",
	): Promise<boolean> {
		const scratchPath = this.#displayPath;
		if (scratchPath === undefined) return false;
		const created = this.stageCloseout(scratchPath, triggerContextTokens, reason);
		if (!created) {
			if (runImmediately) await this.#host.waitForIdle();
			return true;
		}
		const create = !this.#scratchExists(scratchPath);
		const message = {
			customType: SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE,
			content: renderScratchHandoffCloseoutMessage(scratchPath, create),
			display: true,
			attribution: "agent" as const,
			details: { path: scratchPath, triggerContextTokens },
		};
		if (runImmediately) {
			await this.#host.promptCustomMessage(message);
		} else {
			await this.#host.queueCustomMessage(message, "steer", `scratch handoff: update ${scratchPath}`);
		}
		return true;
	}

	/**
	 * Complete a staged closeout once the model stops. Returns undefined when no
	 * closeout is staged so the caller falls through to its ordinary threshold
	 * decision.
	 */
	async finishCloseoutIfReady(
		assistantMessage: AssistantMessage,
		allowDefer: boolean,
		autoContinue: boolean,
	): Promise<CompactionCheckResult | undefined> {
		const closeout = this.#closeout;
		if (!closeout) return undefined;
		if (assistantMessage.stopReason === "toolUse") return COMPACTION_CHECK_NONE;
		if (this.#writeCount(closeout.scratchPath) > closeout.baselineWriteCount) {
			closeout.writeCompleted = true;
		} else {
			this.#host.emitNotice(
				"warning",
				`scratch handoff closeout did not update ${closeout.scratchPath}; handing off anyway with recent session context after the last scratch write.`,
				"compaction",
			);
		}
		return await this.#host.runAutoCompaction(closeout.reason, false, false, allowDefer, {
			autoContinue: closeout.reason === "manual" ? false : autoContinue,
			triggerContextTokens: closeout.triggerContextTokens,
		});
	}

	/**
	 * Manual `/compact` clean-break path: run the ordinary scratch closeout turn,
	 * then compact the current session around the updated handoff under a `manual`
	 * maintenance reason. Waiting for tracked post-turn work keeps the command
	 * active through the context rebuild. No auto-continue: the operator issued
	 * `/compact` and drives the next task turn.
	 */
	async runManualCompaction(): Promise<CompactionResult> {
		const scratchPath = this.#displayPath;
		if (scratchPath === undefined) {
			throw new Error("Scratch handoff is not active for this session.");
		}
		const tokensBefore = this.#host.getContextUsage()?.tokens ?? 0;
		if (this.#scratchExists(scratchPath)) {
			const prepared = await this.prepareContext();
			if (prepared.state === "verified") {
				await this.compactSession([], { native: false, standard: false }, prepared);
			} else {
				await this.requestCloseout(tokensBefore, true, "manual");
				await this.#host.waitForIdle();
			}
		} else {
			await this.requestCloseout(tokensBefore, true, "manual");
			await this.#host.waitForIdle();
		}
		const compactionEntry = getLatestCompactionEntry(this.#host.sessionManager.getBranch());
		if (!compactionEntry) {
			throw new Error("Scratch handoff compaction did not complete.");
		}
		return {
			summary: `Scratch handoff: compacted the current session around ${scratchPath}.`,
			firstKeptEntryId: compactionEntry.firstKeptEntryId,
			tokensBefore,
		};
	}

	async #messageContent(pendingMessages: readonly AgentMessage[] = []): Promise<{
		content: CustomMessage["content"];
		state: ScratchContinuityState;
	}> {
		const model = this.#host.model();
		if (this.#displayPath) {
			try {
				const scratchPath = resolveToCwd(this.#displayPath, this.#host.sessionManager.getCwd());
				const scratchText = fs.readFileSync(scratchPath, "utf8").trim();
				const scratchPreview = scratchHandoffBodyPreview(scratchText);
				const delta = this.#recentContext(pendingMessages);
				const state = resolveScratchContinuityState({
					scratchText,
					closeoutWriteCompleted: this.#closeout?.writeCompleted === true,
					hasRecordedWrite: this.#writeCount(this.#displayPath) > 0,
					hasDelta: delta !== undefined,
				});
				// SnapCompact carries the COMPLETE delta: frames are bounded by their
				// own budget and cost a fraction of the same work as text, so trimming
				// before it would drop work the successor then re-reads for no saving.
				if (delta && model?.input.includes("image")) {
					try {
						const shape = snapcompact.resolveShape(model, this.#host.settings.get("snapcompact.shape"));
						const maxFrames = Math.min(
							snapcompact.providerImageBudget(model.provider),
							snapcompact.maxFramesForDataBudget(),
						);
						const result = await snapcompact.compact<Message>(
							{
								firstKeptEntryId: "scratch-handoff-context",
								messagesToSummarize: [
									{
										role: "user",
										content: [{ type: "text", text: delta.text }],
										timestamp: Date.now(),
									},
								],
								turnPrefixMessages: [],
								tokensBefore: countTokens(delta.text),
								fileOps: snapcompact.createFileOps(),
							},
							{ model, shape, maxFrames, dimToolResults: false },
						);
						const archive = snapcompact.getPreservedArchive(result.preserveData);
						if (archive) {
							return {
								content: [
									{
										type: "text",
										text: renderScratchHandoffResumeMessage({
											displayPath: this.#displayPath,
											parentDisplayPath: this.#parentDisplayPath,
											scratchText: scratchPreview.text,
											scratchTruncated: scratchPreview.truncated,
											recentContextSnapcompactFrames: archive.frames.length,
										}),
									},
									{ type: "text", text: result.summary },
									...snapcompact.historyBlocks(archive, {
										maxFrameDataBytes: snapcompact.FRAME_DATA_BYTES_BUDGET,
									}),
								],
								state,
							};
						}
					} catch (error) {
						logger.warn("Failed to compact scratch handoff delta with SnapCompact; preserving text", {
							error: String(error),
							scratchPath: this.#displayPath,
						});
					}
				}
				// Text fallback: this delta lands in the rebuilt prefix uncompressed and
				// is re-billed on every request of the next segment, so it takes the
				// inline budget.
				return {
					content: [
						{
							type: "text",
							text: renderScratchHandoffResumeMessage({
								displayPath: this.#displayPath,
								parentDisplayPath: this.#parentDisplayPath,
								scratchText: scratchPreview.text,
								scratchTruncated: scratchPreview.truncated,
								recentContextText: delta?.bounded,
							}),
						},
					],
					state,
				};
			} catch (error) {
				logger.warn("Failed to build current scratch handoff payload; using launch snapshot", {
					error: String(error),
					scratchPath: this.#displayPath,
				});
			}
		}
		const messages = this.#host.agent.state.messages;
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role === "custom" && message.customType === SCRATCH_HANDOFF_READ_CUSTOM_TYPE) {
				return { content: message.content, state: "unusable" };
			}
		}
		return {
			content: [
				{
					type: "text",
					text: `Current scratch continuity state is in ${this.#displayPath ?? "(unknown)"}. Continue from that scratch file and the live launch prompt.`,
				},
			],
			state: "unusable",
		};
	}

	/**
	 * Build the scratch continuity payload for one maintenance pass.
	 *
	 * A `stale` document is the ordinary state when context pressure arrives
	 * before a closeout turn: the attached delta and the closeout instruction
	 * appended by {@link appendContext} carry that work, so it stays silent. Only
	 * an `unusable` document needs the model to rebuild the TODO, and only that
	 * case is worth the operator's attention.
	 */
	async prepareContext(
		pendingMessages: readonly AgentMessage[] = [],
		reportPhase?: ScratchHandoffPhaseReporter,
	): Promise<PreparedScratchHandoffContext> {
		const scratch = await this.#messageContent(pendingMessages);
		let content = scratch.content;
		if (scratch.state === "unusable") {
			const warning =
				"Scratch continuity is missing or incomplete. Rebuild the scratch TODO (objective, open TODO, next action) from the state below before continuing task work.";
			this.#host.emitNotice("warning", warning, "compaction");
			content = [
				{ type: "text", text: warning },
				...(typeof content === "string" ? [{ type: "text" as const, text: content }] : content),
			];
		}
		const tokensBefore = this.#host.getContextUsage()?.tokens ?? 0;
		await reportPhase?.("scratch-target-resolved");
		await this.#host.sessionManager.flush();
		return { content, tokensBefore, state: scratch.state };
	}

	async appendContext(
		scratch: { content: CustomMessage["content"]; tokensBefore: number },
		createCompactionBoundary: boolean,
		scratchCompaction: ScratchCompactionModes,
		reportPhase?: ScratchHandoffPhaseReporter,
	): Promise<void> {
		const scratchEntryId = this.#host.sessionManager.appendCustomMessageEntry(
			SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
			scratch.content,
			false,
			{ path: this.#displayPath, parentPath: this.#parentDisplayPath },
			"agent",
		);
		if (createCompactionBoundary) {
			this.#host.sessionManager.appendCompaction(
				"Continue from the scratch handoff state preserved after this compaction.",
				"Scratch handoff",
				scratchEntryId,
				scratch.tokensBefore,
				undefined,
				undefined,
				undefined,
				scratchCompaction,
			);
		}
		const closeout = this.#closeout;
		if (closeout && !closeout.writeCompleted) {
			this.#host.sessionManager.appendCustomMessageEntry(
				SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE,
				renderScratchHandoffCloseoutMessage(closeout.scratchPath, !this.#scratchExists(closeout.scratchPath)),
				true,
				{ path: closeout.scratchPath, triggerContextTokens: closeout.triggerContextTokens },
				"agent",
			);
		}
		await this.#host.sessionManager.ensureOnDisk();
		this.#host.resetTurnStateForScratchBoundary();
		await reportPhase?.("scratch-read-injected");
		await reportPhase?.("scratch-session-compacted");
	}

	async compactSession(
		pendingMessages: readonly AgentMessage[] = [],
		scratchCompaction: ScratchCompactionModes = { native: false, standard: false },
		prepared?: { content: CustomMessage["content"]; tokensBefore: number },
		reportPhase?: ScratchHandoffPhaseReporter,
	): Promise<void> {
		const scratch = prepared ?? (await this.prepareContext(pendingMessages, reportPhase));
		await this.appendContext(scratch, true, scratchCompaction, reportPhase);
		this.rebuildLiveContext();
		await reportPhase?.("scratch-session-rebuilt");
	}

	/** Replay the rebuilt branch into the agent and drop context caches it invalidates. */
	rebuildLiveContext(): void {
		const sessionContext = this.#host.buildDisplaySessionContext();
		this.#host.agent.replaceMessages(sessionContext.messages);
		this.#host.resetAdvisorRuntimes();
		this.#host.closeCodexProviderSessionsForHistoryRewrite();
		this.#host.markPrefixReset();
	}

	#estimateLiveRequestContextTokens(context: AgentContext, contextWindow: number): number {
		const opts = { excludeEncryptedReasoning: true } as const;
		const liveEstimate =
			computeNonMessageTokens(this.#host.nonMessageTokenSource()) +
			context.messages.reduce((sum, msg) => sum + estimateTokens(msg, opts), 0);
		return compactionContextTokens(this.#host.getContextUsage({ contextWindow })?.tokens ?? 0, liveEstimate);
	}

	#estimateProviderRequestContextTokens(context: Context, contextWindow: number): number {
		const opts = { excludeEncryptedReasoning: true } as const;
		const liveEstimate =
			(context.systemPrompt ?? []).reduce((sum, part) => sum + countTokens(part), 0) +
			estimateToolSchemaTokens(context.tools ?? []) +
			context.messages.reduce((sum, message) => sum + estimateTokens(message, opts), 0);
		return compactionContextTokens(this.#host.getContextUsage({ contextWindow })?.tokens ?? 0, liveEstimate);
	}

	closeoutTriggerTokens(contextWindow: number, compactionSettings: CompactionSettings, scratchPath: string): number {
		const promptBudget = Math.max(0, contextWindow - effectiveReserveTokens(contextWindow, compactionSettings));
		if (promptBudget <= 0) return 0;
		const closeoutTokens = Math.max(
			countTokens(renderScratchHandoffCloseoutMessage(scratchPath, !this.#scratchExists(scratchPath))),
			SCRATCH_HANDOFF_CLOSEOUT_MIN_HEADROOM_TOKENS,
		);
		return Math.max(0, promptBudget - closeoutTokens);
	}

	shouldRequestCloseout(
		contextTokens: number,
		contextWindow: number,
		compactionSettings: CompactionSettings,
		scratchPath: string,
	): boolean {
		const triggerTokens = this.closeoutTriggerTokens(contextWindow, compactionSettings, scratchPath);
		return triggerTokens > 0 && contextTokens >= triggerTokens;
	}

	async #elideRecentToolResultsForScratchCloseout(
		context: AgentContext,
		contextWindow: number,
		promptBudget: number,
		contextTokens: number,
	): Promise<number | undefined> {
		const lastAssistant = context.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		const providerTokens = lastAssistant ? calculateContextTokens(lastAssistant.usage) : 0;
		if (providerTokens > promptBudget) return undefined;

		await this.#host.messageEndPersistenceTail();
		const branchEntries = this.#host.sessionManager.getBranch();
		const regions = collectShakeRegions(branchEntries, {
			...AGGRESSIVE_SHAKE_CONFIG,
			fenceMinTokens: Number.MAX_SAFE_INTEGER,
			keepBoundaryId: getLatestCompactionEntry(branchEntries)?.firstKeptEntryId,
		}).filter((region): region is Extract<ShakeRegion, { kind: "toolResult" }> => region.kind === "toolResult");
		if (regions.length === 0) return undefined;

		// Rewrite from the tail backward so the changed boundary lands as late as
		// possible and the provider can reuse the longest byte-identical cached prefix.
		const targetSavings = contextTokens - promptBudget;
		const selected: ShakeRegion[] = [];
		let estimatedSavings = 0;
		for (let index = regions.length - 1; index >= 0 && estimatedSavings < targetSavings; index--) {
			const region = regions[index];
			selected.push(region);
			estimatedSavings += Math.max(
				0,
				region.tokens - countTokens(this.#host.shakeElidePlaceholder(region, selected.length - 1, "artifact")),
			);
		}
		selected.reverse();

		const result = await this.#host.applyShakeRegions("elide", selected, true);
		if (result.toolResultsDropped === 0 || result.artifactId === undefined) return undefined;

		context.messages.splice(0, context.messages.length, ...this.#host.agent.state.messages);
		const reducedTokens = this.#estimateLiveRequestContextTokens(context, contextWindow);
		const outcome =
			reducedTokens <= promptBudget
				? "to preserve the scratch closeout turn"
				: "but the scratch closeout turn still exceeds the prompt budget";
		this.#host.emitNotice(
			"info",
			`Elided ${result.toolResultsDropped} recent tool result${result.toolResultsDropped === 1 ? "" : "s"} (~${result.tokensFreed.toLocaleString()} tokens) to artifact://${result.artifactId} ${outcome}.`,
			"compaction",
		);
		return reducedTokens;
	}

	/** Take and clear the pre-provider stop recorded for the just-finished run. */
	takePreProviderStop(): PreProviderScratchHandoffStop | undefined {
		const stop = this.#preProviderStop;
		this.#preProviderStop = undefined;
		return stop;
	}

	async prepareBeforeProviderContext(context: AgentContext): Promise<void> {
		const closeout = this.#closeout;
		if (closeout?.toolResultElisionPending !== true) return;
		closeout.toolResultElisionPending = false;
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (contextWindow <= 0) return;
		const compactionSettings = this.#host.settings.getGroup("compaction");
		const promptBudget = Math.max(0, contextWindow - effectiveReserveTokens(contextWindow, compactionSettings));
		if (promptBudget <= 0) return;
		const contextTokens = this.#estimateLiveRequestContextTokens(context, contextWindow);
		if (contextTokens <= promptBudget) return;
		await this.#elideRecentToolResultsForScratchCloseout(context, contextWindow, promptBudget, contextTokens);
	}

	async stopBeforeOversizedRequest(context: Context): Promise<AgentPreModelCallResult> {
		const scratchPath = this.#displayPath;
		if (!scratchPath) return;
		const contextWindow = this.#host.model()?.contextWindow ?? 0;
		if (contextWindow <= 0) return;

		const compactionSettings = this.#host.settings.getGroup("compaction");
		if (
			!compactionSettings.enabled ||
			!shouldRunScratchHandoffMaintenance({
				strategy: compactionSettings.strategy,
				model: this.#host.model(),
				remoteEnabled: compactionSettings.remoteEnabled,
				remoteStreamingV2Enabled: compactionSettings.remoteStreamingV2Enabled,
			})
		) {
			return;
		}
		const reserveTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		const promptBudget = Math.max(0, contextWindow - reserveTokens);
		if (promptBudget <= 0) return;
		const contextTokens = this.#estimateProviderRequestContextTokens(context, contextWindow);
		const thresholdTokens = resolveThresholdTokens(contextWindow, compactionSettings);
		if (!shouldCompact(contextTokens, contextWindow, compactionSettings) && contextTokens <= promptBudget) return;
		if (this.#closeout && contextTokens <= promptBudget) {
			logger.debug("Allowing scratch-handoff closeout request before reset", {
				contextTokens,
				contextWindow,
				promptBudget,
				scratchPath,
			});
			return;
		}

		this.#preProviderStop = {
			contextTokens,
			contextWindow,
			promptBudget,
			scratchPath,
			thresholdTokens,
		};
		logger.info("Starting direct scratch handoff before oversized closeout request", {
			contextTokens,
			contextWindow,
			promptBudget,
			reserveTokens,
			thresholdTokens,
			scratchPath,
		});
		this.#host.emitNotice(
			"info",
			`Context reached ${contextTokens.toLocaleString()} tokens; one more scratch-closeout model turn would exceed the prompt budget, so starting scratch handoff directly from ${scratchPath}.`,
			"compaction",
		);
		return {
			stop: true,
			reason: "scratch-handoff-context-threshold",
		};
	}
}

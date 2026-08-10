import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type Component, Loader, TERMINAL } from "@oh-my-pi/pi-tui";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../../commit/utils";
import { settings } from "../../config/settings";
import { createIpythonCellJournalDetail } from "../../ipython/journal";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import { IpythonCellMessageComponent } from "../../modes/components/ipython-cell-message";
import { MaintenanceTraceCard } from "../../modes/components/maintenance-trace-card";
import { TodoReminderComponent } from "../../modes/components/todo-reminder";
import { TtsrNotificationComponent } from "../../modes/components/ttsr-notification";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { getSymbolTheme, theme } from "../../modes/theme/theme";
import type { InteractiveModeContext, TodoPhase } from "../../modes/types";
import type { AgentSessionEvent } from "../../session/agent-session";
import { isSilentAbort, readQueueChipText, resolveAbortLabel } from "../../session/messages";
import { buildEffectiveIdleThreshold } from "../../session/session-metadata";
import { previewLine, shortenPath, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { SpeechEnhancer } from "../../tts/speech-enhancer";
import { vocalizer } from "../../tts/vocalizer";
import { setTerminalTitleState } from "../../utils/title-generator";
import { createAssistantMessageComponent } from "../utils/interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { isWarpCliAgentProtocolActive } from "../warp-events";
import { StreamingRevealController } from "./streaming-reveal";

type AgentSessionEventKind = AgentSessionEvent["type"];

const IRC_MESSAGE_VISIBLE_TTL_MS = 10_000;
/**
 * Concurrent IRC cards allowed in the transcript's live region. Cards land
 * below a still-live block (a running task), where they cannot commit to
 * native scrollback (commits are prefix-only) — every visible card inflates
 * the live region and pushes the live block's uncommitted rows above the
 * window top, where they are neither on screen nor in history. A swarm burst
 * (several agents coordinating at once) must therefore stay bounded: the
 * oldest live-region card retires as soon as a new one would exceed the cap.
 */
const MAX_LIVE_IRC_CARDS = 4;

/** Formats a remaining duration as a compact `1h 23m 04s` / `4m 12s` / `38s` countdown. */
function formatResumeCountdown(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (value: number) => value.toString().padStart(2, "0");
	if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
	if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
	return `${seconds}s`;
}

type AgentSessionEventHandlers = {
	[E in AgentSessionEventKind]: (event: Extract<AgentSessionEvent, { type: E }>) => Promise<void>;
};

export class EventController {
	#maintenanceTraceCards = new Map<string, MaintenanceTraceCard>();
	#ipythonCells = new Map<string, IpythonCellMessageComponent>();
	#pendingIpythonActEvents = new Map<string, Extract<AgentSessionEvent, { type: "act_event" }>[]>();
	#renderedCustomMessages = new Set<string>();
	#lastAssistantComponent: AssistantMessageComponent | undefined = undefined;
	// Assistant component whose turn-ending error is currently mirrored in the
	// pinned banner. Its inline `Error: …` line is suppressed while pinned and
	// restored when the banner clears at the next `agent_start` (see
	// #handleMessageEnd / #handleAgentStart).
	#pinnedErrorComponent: AssistantMessageComponent | undefined = undefined;
	#retrySupersededAssistantComponents = new Map<string, AssistantMessageComponent>();
	#retrySupersededAssistantQueue: AssistantMessageComponent[] = [];
	// Set when `auto_retry_start` fires and cleared by `auto_retry_end` (both
	// outcomes) — true for exactly the window a retry is outstanding. Gates
	// `sendErrorNotification`: the wire-level `agent_end` for a retryable
	// failure is coalesced with every other attempt in the same saga while the
	// prompt is in flight (see `AgentSession#emitSessionEvent`), so the single
	// `agent_end` that survives to reach this controller can be either a
	// mid-retry blip or the final settle — only the retry lifecycle events
	// (never deferred) can tell them apart.
	#retryPending = false;
	#idleCompactionTimer?: NodeJS.Timeout;
	#ircExpiryTimers = new Map<string, NodeJS.Timeout>();
	// Insertion-ordered IRC cards not yet retired; values are the transcript
	// components each card contributed (see #retireIrcCard for the guard).
	#liveIrcCards = new Map<string, Component[]>();
	// Most recent TTSR notification block. A new ttsr_triggered event merges its
	// rules into this block while it is still the (live-region) transcript tail.
	#lastTtsrNotification: TtsrNotificationComponent | undefined = undefined;
	#streamingReveal: StreamingRevealController;
	#prevHideThinking = false;
	#handlers: AgentSessionEventHandlers;
	#terminalProgressActive = false;
	// Coalescing window for `message_update` events at the subscription boundary.
	// `message_update` carries the CUMULATIVE assistant message (every update
	// re-lists all content blocks), so when a burst of deltas arrives faster than
	// this window only the latest snapshot needs to rebuild streaming state — the
	// intermediate rebuilds are redundant work. The TUI already caps the paint
	// rate via its own render cadence; this caps the per-token handler work that
	// feeds it. Speech stays intact: `#vocalizeDelta` runs at ARRIVAL for every
	// delta before the snapshot is coalesced away.
	#pendingMessageUpdate: Extract<AgentSessionEvent, { type: "message_update" }> | undefined = undefined;
	#messageUpdateTimer: NodeJS.Timeout | undefined = undefined;
	/** Tail of the serialized dispatch chain; see #runSerialized. */
	#dispatchTail: Promise<void> = Promise.resolve();
	/** Whether a chained run is currently in flight (awaiting its own awaits). */
	#dispatchInFlight = false;
	// Deltas already fed to speech at arrival by the coalescer. `#handleMessageUpdate`
	// also vocalizes so the direct `handleEvent` path (tests, session focus replay)
	// keeps working — the WeakSet makes the coalesced path speak each delta exactly
	// once instead of twice.
	#vocalizedMessageUpdates = new WeakSet<object>();
	static readonly #MESSAGE_UPDATE_COALESCE_MS = 33;

	constructor(private ctx: InteractiveModeContext) {
		// Enhanced speech (`speech.enhanced`) rewrites blocks through the
		// tiny/smol role with this session's registry and credentials; the
		// vocalizer falls back to mechanical cleanup when unset. Tolerates
		// partial contexts (tests, minimal embeddings) by wiring null.
		const session = ctx.session;
		vocalizer.setEnhancer(
			session?.modelRegistry && session.agent && session.settings
				? new SpeechEnhancer({
						settings: session.settings,
						registry: session.modelRegistry,
						sessionId: session.sessionId,
						metadataResolver: provider => session.agent.metadataForProvider(provider),
					})
				: null,
		);
		this.#streamingReveal = new StreamingRevealController({
			getSmoothStreaming: () => this.ctx.settings.get("display.smoothStreaming"),
			getHideThinkingBlock: () => this.ctx.effectiveHideThinkingBlock,
			getProseOnlyThinking: () => this.ctx.proseOnlyThinking,
			requestRender: component => this.ctx.ui.requestComponentRender(component),
		});
		this.#handlers = {
			agent_start: e => this.#handleAgentStart(e),
			agent_end: e => this.#handleAgentEnd(e),
			turn_start: async () => {},
			turn_end: async e => this.#handleTurnEnd(e),
			message_start: e => this.#handleMessageStart(e),
			message_update: e => this.#handleMessageUpdate(e),
			message_end: e => this.#handleMessageEnd(e),
			ipython_cell_start: e => this.#handleIpythonCellStart(e),
			ipython_cell_update: e => this.#handleIpythonCellUpdate(e),
			ipython_cell_end: e => this.#handleIpythonCellEnd(e),
			act_event: e => this.#handleActEvent(e),
			tool_execution_start: async () => {},
			tool_execution_update: async () => {},
			tool_execution_end: e => this.#handleToolExecutionEnd(e),
			auto_compaction_start: e => this.#handleAutoCompactionStart(e),
			auto_compaction_end: e => this.#handleAutoCompactionEnd(e),
			llm_usage: async () => {},
			compaction_measurement: async () => {},
			maintenance_trace_start: async e => this.#handleMaintenanceTraceStart(e),
			maintenance_trace_phase: async e => this.#handleMaintenanceTracePhase(e),
			maintenance_trace_delta: async e => this.#handleMaintenanceTraceDelta(e),
			maintenance_trace_end: async e => this.#handleMaintenanceTraceEnd(e),
			auto_retry_start: e => this.#handleAutoRetryStart(e),
			auto_retry_end: e => this.#handleAutoRetryEnd(e),
			retry_fallback_applied: e => this.#handleRetryFallbackApplied(e),
			retry_fallback_succeeded: e => this.#handleRetryFallbackSucceeded(e),
			ttsr_triggered: e => this.#handleTtsrTriggered(e),
			todo_reminder: e => this.#handleTodoReminder(e),
			todo_auto_clear: e => this.#handleTodoAutoClear(e),
			irc_message: e => this.#handleIrcMessage(e),
			notice: e => this.#handleNotice(e),
			model_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
			},
			thinking_level_changed: async () => {
				this.ctx.statusLine.invalidate();
				this.ctx.updateEditorBorderColor();
				const hideThinking = this.ctx.effectiveHideThinkingBlock;
				// Only do the expensive full resetDisplay when the effective
				// visibility actually changed. Auto-classification (e.g. high→medium)
				// emits thinking_level_changed without changing visibility — a full
				// terminal replay for those would be disruptive.
				if (hideThinking === this.#prevHideThinking) {
					this.ctx.ui.requestRender();
					return;
				}
				this.#prevHideThinking = hideThinking;
				// Propagate visibility to existing rendered messages.
				for (const child of this.ctx.chatContainer.children) {
					if (child instanceof AssistantMessageComponent) {
						child.setHideThinkingBlock(hideThinking);
					}
				}
				if (this.ctx.streamingComponent && this.ctx.streamingMessage) {
					this.ctx.streamingComponent.setHideThinkingBlock(hideThinking);
					this.#streamingReveal.resyncVisibility();
				}
				this.ctx.ui.resetDisplay();
			},
			goal_updated: async () => {},
			steering_received: async () => {},
		} satisfies AgentSessionEventHandlers;
	}

	dispose(): void {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#streamingReveal.stop();
		this.#cancelIdleCompaction();
		this.#setTerminalProgress(false);
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
		this.#ipythonCells.clear();
		this.#pendingIpythonActEvents.clear();
	}

	subscribeToAgent(): void {
		// Serialize non-update dispatch behind any in-flight handler run:
		// AgentSession.#emit fires listeners fire-and-forget (it does not await
		// listener promises), so without this a rapid stream tail
		// (message_update → message_end → agent_end) could let a later callback
		// overtake the coalesced flush's handler mid-await — agent_end removing
		// `streamingComponent` before #handleMessageEnd finalizes and records
		// the final message (issue #7443 follow-up). When the tail has settled,
		// dispatch stays synchronous: the flush's streaming rebuild runs before
		// the listener's first await, preserving the timing the coalescing
		// tests assert on. `message_update` enqueue is itself synchronous and
		// needs no serialization.
		this.ctx.unsubscribe = this.ctx.session.subscribe(async (event: AgentSessionEvent) => {
			// Coalesce the cumulative `message_update` deltas of a streaming turn
			// into at most one handler run per window. `#handleMessageUpdate` is
			// synchronous, so without this every token re-runs the whole
			// streaming rebuild (splitAssistantMessageToolTimeline, reveal
			// setTarget, per-block tool-call reconciliation) even though the TUI
			// paints at most ~30fps — at 40-100 tps the handler work then
			// dominates the CPU profile of an idle-looking streaming session
			// (issue #7443). Only the latest snapshot is meaningful; non-update
			// events flush the pending snapshot first so ordering is preserved.
			if (event.type === "message_update") {
				this.#enqueueMessageUpdate(event);
				return;
			}
			await this.#runSerialized(async () => {
				await this.#flushPendingMessageUpdate();
				await this.handleEvent(event);
			});
		});
	}

	/**
	 * Run `run` in the serialized dispatch chain: every run is its own link on
	 * the tail, so a burst of events queued behind an in-flight run start one
	 * after the other, never concurrently. This closes two races (issue #7443
	 * follow-up): a rapid stream tail (message_update → message_end →
	 * agent_end) cannot overtake the coalesced flush mid-await — agent_end
	 * removing `streamingComponent` before #handleMessageEnd finalizes and
	 * records the final message — and two+ events landing in the same window
	 * cannot all resume from one shared await and dispatch in parallel. When
	 * the chain is drained, `run` starts synchronously (no intermediate
	 * microtask), preserving the synchronous-flush timing the coalescing
	 * tests assert on. A rejection propagates to the caller (the session's
	 * fire-and-forget emit) and the next event starts a fresh chain link
	 * instead of being dropped.
	 */
	async #runSerialized(run: () => Promise<void>): Promise<void> {
		if (this.#dispatchInFlight) {
			// Queue behind the CURRENT tail: the next run starts only after
			// the previous one settles. Each waiter gets its own link, so a
			// burst cannot fan out from the same shared await.
			const link = this.#dispatchTail.then(
				() => run(),
				() => run(),
			);
			this.#dispatchTail = link;
			void link.then(
				() => {
					// Only the tail owner clears the flag: a later chained
					// link clears it when it settles as the tail.
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
				() => {
					if (this.#dispatchTail === link) this.#dispatchInFlight = false;
				},
			);
			await link;
			return;
		}
		this.#dispatchInFlight = true;
		const link = run();
		this.#dispatchTail = link;
		void link.then(
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
			() => {
				if (this.#dispatchTail === link) this.#dispatchInFlight = false;
			},
		);
		await link;
	}

	/**
	 * Queue a streaming `message_update` for the next coalesced handler run.
	 * Speech is per-delta, so the delta is vocalized at arrival before the
	 * snapshot is (possibly) superseded by a newer one.
	 */
	#enqueueMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		// Speech is per-delta: every delta is spoken at arrival even when its
		// cumulative snapshot is later superseded and never rebuilt.
		this.#vocalizeDelta(event);
		this.#vocalizedMessageUpdates.add(event);
		this.#pendingMessageUpdate = event;
		if (this.#messageUpdateTimer) return;
		this.#messageUpdateTimer = setTimeout(() => {
			this.#messageUpdateTimer = undefined;
			// Mirror AgentSession.#emit: attach a catch so a streaming rebuild
			// failure surfaces as a logged warning instead of a process-level
			// unhandled rejection (the timer path has no listener to attach one).
			// Runs inside the serialized dispatch chain so a message_end /
			// agent_end landing mid-window cannot overtake this flush (issue
			// #7443 follow-up).
			void this.#runSerialized(async () => {
				await this.#flushPendingMessageUpdate();
			}).catch(err => {
				logger.warn("Message update flush rejected", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, EventController.#MESSAGE_UPDATE_COALESCE_MS);
	}

	/**
	 * Run the coalesced `message_update` handler on the latest pending snapshot
	 * (dropping any superseded intermediates) and clear the queue. Safe to call
	 * more than once; no-ops when nothing is pending.
	 */
	async #flushPendingMessageUpdate(): Promise<void> {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		const event = this.#pendingMessageUpdate;
		if (!event) return;
		this.#pendingMessageUpdate = undefined;
		await this.handleEvent(event);
	}
	/**
	 * Clear every transcript-anchored/turn-scoped piece of state. Used by the
	 * session focus proxy when re-pointing the transcript at another session:
	 * components, timers, and stream-reveal state all reference the previous
	 * session's transcript and must not bleed into the new one.
	 */
	resetTranscriptAnchors(): void {
		if (this.#messageUpdateTimer) {
			clearTimeout(this.#messageUpdateTimer);
			this.#messageUpdateTimer = undefined;
		}
		this.#pendingMessageUpdate = undefined;
		this.#renderedCustomMessages.clear();
		this.#lastAssistantComponent = undefined;
		this.#pinnedErrorComponent = undefined;
		this.#retryPending = this.ctx.viewSession.isRetrying;
		this.#cancelIdleCompaction();
		for (const timer of this.#ircExpiryTimers.values()) {
			clearTimeout(timer);
		}
		this.#ircExpiryTimers.clear();
		this.#liveIrcCards.clear();
		this.#lastTtsrNotification = undefined;
		this.#streamingReveal.stop();
	}

	async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ctx.isInitialized) {
			await this.ctx.init();
		}

		// Each handler explicitly requests a render (or leaves it out, when it
		// changed nothing visible). A blanket pre-render fired on every event —
		// including the ~hundreds of `message_update` deltas per streaming turn —
		// doubled the paint rate: the pre-render's frame fires while the handler
		// is awaiting, then the handler's own final requestRender schedules a
		// second identical frame. Removing it lets the render cadence follow real
		// state changes rather than event volume (issue #4353).
		const run = this.#handlers[event.type] as (e: AgentSessionEvent) => Promise<void>;
		await run(event);
	}

	#setTerminalProgress(active: boolean): void {
		if (active) {
			if (this.#terminalProgressActive || this.ctx.settings?.get("terminal.showProgress") !== true) return;
			this.ctx.ui.terminal.setProgress(true);
			this.#terminalProgressActive = true;
			return;
		}
		if (!this.#terminalProgressActive) return;
		this.ctx.ui.terminal.setProgress(false);
		this.#terminalProgressActive = false;
	}

	#trackRetrySupersededAssistantComponent(component: AssistantMessageComponent | undefined): void {
		if (!component) return;
		const persistenceKey = component.messagePersistenceKey();
		if (persistenceKey) this.#retrySupersededAssistantComponents.set(persistenceKey, component);
		if (!this.#retrySupersededAssistantQueue.includes(component)) {
			this.#retrySupersededAssistantQueue.push(component);
		}
	}

	#takeRetrySupersededAssistantComponent(persistenceKey: string | undefined): AssistantMessageComponent | undefined {
		if (persistenceKey) {
			const component = this.#retrySupersededAssistantComponents.get(persistenceKey);
			if (component) {
				this.#retrySupersededAssistantComponents.delete(persistenceKey);
				this.#retrySupersededAssistantQueue = this.#retrySupersededAssistantQueue.filter(
					item => item !== component,
				);
				return component;
			}
		}
		while (this.#retrySupersededAssistantQueue.length > 0) {
			const component = this.#retrySupersededAssistantQueue.shift();
			if (!component) continue;
			const key = component.messagePersistenceKey();
			if (key && this.#retrySupersededAssistantComponents.get(key) !== component) continue;
			if (key) this.#retrySupersededAssistantComponents.delete(key);
			return component;
		}
		return undefined;
	}

	#clearRetrySupersededAssistantComponents(): void {
		this.#retrySupersededAssistantComponents.clear();
		this.#retrySupersededAssistantQueue = [];
	}

	async #handleAgentStart(_event: Extract<AgentSessionEvent, { type: "agent_start" }>): Promise<void> {
		this.#lastAssistantComponent = undefined;
		// Restore the previous turn's inline error in the transcript before dropping
		// the banner, so the error stays in history once the banner is gone.
		this.#pinnedErrorComponent?.setErrorPinned(false);
		this.#pinnedErrorComponent = undefined;
		this.ctx.clearPinnedError();
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		this.#cancelIdleCompaction();
		this.ctx.statusLine.markActivityStart();
		this.#setTerminalProgress(true);
		this.ctx.ensureLoadingAnimation();
		setTerminalTitleState("working");
		this.ctx.ui.requestRender();
	}

	async #handleMessageStart(event: Extract<AgentSessionEvent, { type: "message_start" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.message.role === "hookMessage" || event.message.role === "custom") {
			const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
			if (this.#renderedCustomMessages.has(signature)) {
				return;
			}
			this.#renderedCustomMessages.add(signature);
			this.ctx.addMessageToChat(event.message);
			// Queued custom-message chips are derived from the agent queue; refresh the
			// pending bar when the queued custom is consumed so the chip disappears
			// immediately.
			if (event.message.role === "custom" && readQueueChipText(event.message.details)) {
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "user") {
			vocalizer.clear();
			const textContent = this.ctx.getUserMessageText(event.message);
			const imageBlocks =
				typeof event.message.content === "string"
					? []
					: event.message.content.filter(
							(content): content is ImageContent =>
								content.type === "image" &&
								typeof content.data === "string" &&
								typeof content.mimeType === "string",
						);
			const imageCount = imageBlocks.length;
			const signature = `${textContent}\u0000${imageCount}`;

			const wasOptimistic = this.ctx.optimisticUserMessageSignature === signature;
			const matchedLocalSubmission = this.ctx.locallySubmittedUserSignatures.delete(signature);
			const replacesOptimistic =
				this.ctx.optimisticUserMessageSignature !== undefined && !wasOptimistic && !matchedLocalSubmission;
			const wasLocallySubmitted = matchedLocalSubmission || wasOptimistic || replacesOptimistic;
			if (wasOptimistic) {
				this.ctx.clearOptimisticUserMessage();
			} else if (replacesOptimistic) {
				this.ctx.replaceOptimisticUserMessage(event.message);
			} else {
				// Append synchronously: #emit dispatches to this listener fire-and-forget
				// (see AgentSession.#emit), so any await between the user message_start and
				// addMessageToChat lets later events (assistant message_start, tool execution
				// start/end) append their components first and scramble transcript order /
				// live-region block boundaries. addMessageToChat materializes clickable image
				// links via the synchronous putBlobSync fallback, so no await is needed here.
				this.ctx.addMessageToChat(event.message);
			}

			// Clear the editor only when the submission did not originate from a
			// local submission (optimistic or queued-while-streaming). Both local
			// paths already cleared the editor at submit time; clearing again here
			// would race with the user typing the next prompt while the previous
			// large redraw lands and erase their in-progress draft (#783).
			if (!event.message.synthetic) {
				if (!wasLocallySubmitted) {
					this.ctx.editor.setText("");
				}
				this.ctx.updatePendingMessagesDisplay();
			}
			this.ctx.ui.requestRender();
		} else if (event.message.role === "fileMention") {
			this.ctx.addMessageToChat(event.message);
			this.ctx.ui.requestRender();
		} else if (event.message.role === "assistant") {
			this.ctx.streamingComponent = createAssistantMessageComponent(this.ctx);
			this.ctx.streamingMessage = event.message;
			this.ctx.chatContainer.addChild(this.ctx.streamingComponent);
			this.#streamingReveal.begin(
				this.ctx.streamingComponent,
				splitAssistantMessageToolTimeline(this.ctx.streamingMessage).beforeTools,
			);
			this.ctx.ui.requestRender();
		}
	}

	async #handleIrcMessage(event: Extract<AgentSessionEvent, { type: "irc_message" }>): Promise<void> {
		const signature = `${event.message.role}:${event.message.customType}:${event.message.timestamp}`;
		if (this.#renderedCustomMessages.has(signature)) {
			return;
		}
		this.#renderedCustomMessages.add(signature);
		const components = this.ctx.addMessageToChat(event.message);
		this.#scheduleIrcExpiry(signature, components);
		this.#enforceIrcCardCap(signature);
		this.ctx.ui.requestRender();
	}

	#scheduleIrcExpiry(signature: string, components: Component[]): void {
		if (components.length === 0 || this.#ircExpiryTimers.has(signature)) return;
		const timer = setTimeout(() => {
			this.#ircExpiryTimers.delete(signature);
			this.#retireIrcCard(signature);
		}, IRC_MESSAGE_VISIBLE_TTL_MS);
		timer.unref?.();
		this.#ircExpiryTimers.set(signature, timer);
		this.#liveIrcCards.set(signature, components);
	}

	/**
	 * Remove an expired/evicted IRC card — but only while it still sits below a
	 * live block, where its rows cannot have entered native scrollback. Once
	 * everything above it has finalized, its rows may already be committed;
	 * removing them then is an interior deletion of the committed prefix, which
	 * the engine can only repair by recommitting every row below the gap —
	 * exactly the duplicated-block artifact this guard exists to prevent. Such
	 * a card simply stays: it is final history, and the window scrolls past it.
	 */
	#retireIrcCard(signature: string): void {
		const components = this.#liveIrcCards.get(signature);
		this.#liveIrcCards.delete(signature);
		if (!components) return;
		let removed = false;
		for (const component of components) {
			if (!this.ctx.chatContainer.isBlockUncommitted(component)) continue;
			this.ctx.chatContainer.removeChild(component);
			removed = true;
		}
		if (removed) this.ctx.ui.requestRender();
	}

	/** Evict oldest live-region cards beyond {@link MAX_LIVE_IRC_CARDS}. */
	#enforceIrcCardCap(latestSignature: string): void {
		while (this.#liveIrcCards.size > MAX_LIVE_IRC_CARDS) {
			const oldest = this.#liveIrcCards.keys().next().value;
			if (oldest === undefined || oldest === latestSignature) return;
			const timer = this.#ircExpiryTimers.get(oldest);
			if (timer) {
				clearTimeout(timer);
				this.#ircExpiryTimers.delete(oldest);
			}
			this.#retireIrcCard(oldest);
		}
	}

	async #handleNotice(event: Extract<AgentSessionEvent, { type: "notice" }>): Promise<void> {
		const message = event.source ? `${event.source}: ${event.message}` : event.message;
		if (event.level === "error") {
			this.ctx.showError(message);
		} else if (event.level === "warning") {
			this.ctx.showWarning(message);
		} else {
			this.ctx.showStatus(message);
		}
	}

	/**
	 * Speak streamed assistant output as a side effect of the turn. The mode
	 * decides which deltas feed the vocalizer (the vocalizer re-checks enabled):
	 * assistant|all speak text; all also speaks thinking; yield speaks nothing
	 * live (the final message is spoken at turn end).
	 */
	#vocalizeDelta(event: Extract<AgentSessionEvent, { type: "message_update" }>): void {
		if (!settings.get("speech.enabled")) return;
		const mode = settings.get("speech.mode");
		const delta = event.assistantMessageEvent;
		if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
			vocalizer.pushDelta(delta.delta);
		} else if (delta.type === "thinking_delta" && mode === "all") {
			vocalizer.pushDelta(delta.delta);
		}
	}

	/**
	 * End-of-turn vocalization: final mode speaks the final assistant message in
	 * one shot here (the only mode that is post-hoc); every other mode just makes
	 * sure the live buffer's trailing partial gets flushed.
	 */
	#handleTurnEnd(event: Extract<AgentSessionEvent, { type: "turn_end" }>): void {
		if (!settings.get("speech.enabled")) return;
		if (settings.get("speech.mode") !== "final") {
			vocalizer.flush();
			return;
		}
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "aborted") return; // interrupted: never speak the aborted partial
		const text = extractTextContent(event.message);
		if (text) vocalizer.speak(text);
	}

	async #handleMessageUpdate(event: Extract<AgentSessionEvent, { type: "message_update" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (!this.#vocalizedMessageUpdates.delete(event)) {
			this.#vocalizeDelta(event);
		}
		if (!this.ctx.streamingComponent || event.message.role !== "assistant") return;
		const unlockedThinkingVisibility = this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		this.ctx.streamingMessage = event.message;
		this.#streamingReveal.setTarget(splitAssistantMessageToolTimeline(event.message).beforeTools);
		this.ctx.ui.requestRender();
	}

	async #handleMessageEnd(event: Extract<AgentSessionEvent, { type: "message_end" }>): Promise<void> {
		if (event.message.role === "user") return;
		const unlockedThinkingVisibility =
			event.message.role === "assistant" && this.ctx.noteDisplayableThinkingContent(event.message);
		if (unlockedThinkingVisibility && this.ctx.streamingComponent) {
			this.ctx.streamingComponent.setHideThinkingBlock(this.ctx.effectiveHideThinkingBlock);
			this.#streamingReveal.resyncVisibility();
		}
		if (event.message.role === "assistant" && settings.get("speech.enabled")) {
			if (event.message.stopReason === "aborted") vocalizer.clear();
			else if (settings.get("speech.mode") === "assistant" || settings.get("speech.mode") === "all")
				vocalizer.flush();
		}
		if (!this.ctx.streamingComponent || event.message.role !== "assistant") {
			this.ctx.ui.requestRender();
			return;
		}
		this.ctx.streamingMessage = event.message;
		this.#streamingReveal.stop();
		const aborted = event.message.stopReason === "aborted";
		const silentlyAborted = aborted && isSilentAbort(event.message);
		const ttsrSilenced = aborted && this.ctx.viewSession.isTtsrAbortPending;
		if (aborted && !silentlyAborted && !ttsrSilenced) {
			this.ctx.streamingMessage.errorMessage = resolveAbortLabel(event.message, this.ctx.viewSession.retryAttempt);
		}
		const displayMessage: AssistantMessage =
			silentlyAborted || ttsrSilenced ? { ...event.message, stopReason: "stop" } : event.message;
		const timeline = splitAssistantMessageToolTimeline(displayMessage);
		this.ctx.streamingComponent.updateContent(timeline.beforeTools);
		const usage = event.message.usage;
		if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
			if (settings.get("display.cacheMissMarker")) {
				const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
				if (invalidation) this.ctx.streamingComponent.setCacheInvalidation(invalidation);
			}
			this.ctx.lastAssistantUsage = usage;
		}
		this.ctx.streamingComponent.markTranscriptBlockFinalized();
		let lastAssistantComponent: AssistantMessageComponent = this.ctx.streamingComponent;
		for (const segment of timeline.afterToolCalls.values()) {
			if (!assistantHasVisibleContent(segment)) continue;
			const component = createAssistantMessageComponent(this.ctx);
			component.updateContent(segment);
			component.markTranscriptBlockFinalized();
			this.ctx.chatContainer.addChild(component);
			lastAssistantComponent = component;
		}
		this.#lastAssistantComponent = lastAssistantComponent;
		if (settings.get("display.showTokenUsage") && assistantUsageIsBilled(event.message.usage)) {
			this.ctx.chatContainer.addChild(
				createUsageRowBlock(
					event.message.usage,
					event.message.duration,
					event.message.ttft,
					event.message.timestamp,
				),
			);
		}
		if (displayMessage === event.message) {
			this.ctx.transcriptMessageComponents.set(event.message, this.ctx.streamingComponent);
		}
		this.ctx.streamingComponent = undefined;
		this.ctx.streamingMessage = undefined;
		if (event.message.stopReason === "error" && event.message.errorMessage && !isSilentAbort(event.message)) {
			this.#lastAssistantComponent.setErrorPinned(true);
			this.#pinnedErrorComponent = this.#lastAssistantComponent;
			this.ctx.showPinnedError(event.message.errorMessage);
		}
		this.ctx.statusLine.invalidate();
		this.ctx.ui.requestRender();
	}
	async #handleIpythonCellStart(event: Extract<AgentSessionEvent, { type: "ipython_cell_start" }>): Promise<void> {
		const { presentation } = event;
		const cellId = presentation.cellId;
		if (!cellId || this.#ipythonCells.has(cellId)) return;
		this.#ensureWorkingLoaderWhileStreaming();
		const component = new IpythonCellMessageComponent(
			{
				code: presentation.code,
				origin: presentation.origin,
			},
			mimeType => this.ctx.viewSession.getIpythonMimeRenderer(mimeType),
		);
		component.setExpanded(this.ctx.toolOutputExpanded);
		for (const update of presentation.updates) component.applyUpdate(update);
		this.#ipythonCells.set(cellId, component);
		for (const event of this.#pendingIpythonActEvents.get(cellId) ?? []) component.appendActEvent(event);
		this.#pendingIpythonActEvents.delete(cellId);
		this.ctx.chatContainer.addChild(component);
		this.ctx.ui.requestRender();
	}

	async #handleIpythonCellUpdate(event: Extract<AgentSessionEvent, { type: "ipython_cell_update" }>): Promise<void> {
		const { presentation } = event;
		const cellId = presentation.cellId;
		if (!cellId) return;
		let component = this.#ipythonCells.get(cellId);
		if (!component) {
			await this.#handleIpythonCellStart({ type: "ipython_cell_start", presentation });
			component = this.#ipythonCells.get(cellId);
			if (!component) return;
			return;
		}
		const update = presentation.updates.at(-1);
		if (update) component.applyUpdate(update);
		this.ctx.ui.requestRender();
	}

	async #handleIpythonCellEnd(event: Extract<AgentSessionEvent, { type: "ipython_cell_end" }>): Promise<void> {
		const { presentation } = event;
		let component = this.#ipythonCells.get(presentation.cellId);
		if (!component) {
			component = new IpythonCellMessageComponent(createIpythonCellJournalDetail(presentation), mimeType =>
				this.ctx.viewSession.getIpythonMimeRenderer(mimeType),
			);
			component.setExpanded(this.ctx.toolOutputExpanded);
			this.ctx.chatContainer.addChild(component);
		} else {
			component.complete(createIpythonCellJournalDetail(presentation));
		}
		for (const event of this.#pendingIpythonActEvents.get(presentation.cellId) ?? []) component.appendActEvent(event);
		this.#pendingIpythonActEvents.delete(presentation.cellId);
		this.#ipythonCells.delete(presentation.cellId);
		this.ctx.ui.requestRender();
	}

	async #handleActEvent(event: Extract<AgentSessionEvent, { type: "act_event" }>): Promise<void> {
		const component = this.#ipythonCells.get(event.outerToolCallId);
		if (component) component.appendActEvent(event);
		else {
			const pending = this.#pendingIpythonActEvents.get(event.outerToolCallId) ?? [];
			if (
				pending.length < 256 &&
				!pending.some(entry => entry.actId === event.actId && entry.sequence >= event.sequence)
			) {
				pending.push(event);
				this.#pendingIpythonActEvents.set(event.outerToolCallId, pending);
			}
		}
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleToolExecutionEnd(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): Promise<void> {
		this.#ensureWorkingLoaderWhileStreaming();
		if (event.toolName !== "todo") return;
		if (!event.isError) {
			const details = event.result.details as { phases?: TodoPhase[] } | undefined;
			if (details?.phases) this.ctx.setTodos(details.phases);
			return;
		}
		const textContent = event.result.content.find(
			(content: { type: string; text?: string }) => content.type === "text",
		)?.text;
		const detail = textContent ? previewLine(sanitizeText(textContent), TRUNCATE_LENGTHS.LINE) : "";
		this.ctx.showWarning(
			`Todo update failed${detail ? `: ${detail}` : ". Progress may be stale until todo succeeds."}`,
		);
	}
	async #handleAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		// A superseded agent_end: the agent is already streaming a fresh turn, so
		// this event belongs to a turn that has already been replaced. The session
		// dispatches to listeners fire-and-forget across an async extension-emit hop
		// (#emitSessionEvent), so an interrupted turn's agent_end can land AFTER the
		// resumed turn's agent_start (e.g. any post-turn agent.continue()). Running
		// the turn-end teardown now would stop the loader the live turn just created,
		// leaving "Working…" gone while the agent keeps running. The live turn owns
		// the loader and finalizes it at its own agent_end (isStreaming === false by
		// then). Mirrors the collab guest's !isStreaming loader reconciler.
		if (this.ctx.session.isStreaming) return;
		// A non-terminal settle (`isTerminal: false`) is a scheduling pause, not the
		// end of the run: an unsuppressed async job (a `/vibe` worker turn, a bash
		// `async` job, etc.) will re-wake the loop when its result is delivered.
		// `AgentSession` tags this on the deferred event (see `#hasPendingAsyncWake`
		// in agent-session.ts). Skip the idle title/loader teardown so the tab keeps
		// reading "working"; the later terminal `agent_end` performs it. Still flush
		// a deferred model switch
		// the current stream ends, and `#finishAgentEnd` is otherwise its only flush
		// site, so the automatic continuation would otherwise run on the old
		// model/thinking level until the terminal settle.
		if (event.isTerminal === false) {
			return;
		}
		setTerminalTitleState("idle");

		await this.#finishAgentEnd(event);
	}

	async #finishAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): Promise<void> {
		this.#setTerminalProgress(false);
		this.ctx.statusLine.markActivityEnd();
		this.#streamingReveal.stop();
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		if (this.ctx.streamingComponent) {
			this.ctx.chatContainer.removeChild(this.ctx.streamingComponent);
			this.ctx.streamingComponent = undefined;
			this.ctx.streamingMessage = undefined;
		}
		this.ctx.flushPendingCommandOutput();
		this.#lastAssistantComponent = undefined;
		this.ctx.ui.requestRender();
		this.#scheduleIdleCompaction();
		this.sendErrorNotification(event);
		this.sendCompletionNotification(event);
	}

	/**
	 * Tear down the live "Working…" loader: stop its animation timer AND clear the
	 * reference. A transient overlay (auto-compaction / auto-retry) can remove the
	 * loader from the container while leaving `ctx.loadingAnimation` set, so the
	 * resumed turn's `agent_start` →
	 * `ensureLoadingAnimation()` (guarded by `if (!this.loadingAnimation)`) skipped
	 * re-adding it and the spinner vanished while the agent kept streaming. Nulling
	 * the reference here lets the next `agent_start` recreate and re-attach it.
	 */
	#stopWorkingLoader(): void {
		if (this.ctx.loadingAnimation) {
			this.ctx.loadingAnimation.stop();
			this.ctx.loadingAnimation = undefined;
		}
	}

	/**
	 * Restore the live "Working…" loader when a streaming event lands after a
	 * transient status overlay cleared the container. Focus mode dispatches events
	 * for `viewSession`, so key the reconciler on that session, not the main one.
	 */
	#ensureWorkingLoaderWhileStreaming(): void {
		if (!this.ctx.viewSession.isStreaming) return;
		if (this.ctx.autoCompactionLoader || this.ctx.retryLoader) return;
		this.ctx.ensureLoadingAnimation();
	}

	/**
	 * Trailing Esc hint for live maintenance loaders. While a subagent is
	 * focused, Esc returns to main instead of cancelling its maintenance
	 * (#2819), so the loader drops the hint entirely rather than advertise a
	 * cancel that no longer happens. Includes the leading space so the focused
	 * label carries no dangling whitespace.
	 */
	#maintenanceEscHint(): string {
		return this.ctx.focusedAgentId ? "" : " (esc to cancel)";
	}

	#maintenanceTraceVisibility(): "loader" | "assistant" | "debug" {
		return this.ctx.settings.get("compaction.maintenanceTrace");
	}

	#shouldShowMaintenanceTraceCard(): boolean {
		return this.#maintenanceTraceVisibility() !== "loader";
	}

	#handleMaintenanceTraceStart(event: Extract<AgentSessionEvent, { type: "maintenance_trace_start" }>): void {
		if (!this.#shouldShowMaintenanceTraceCard()) return;
		this.#maintenanceTraceCards.get(event.traceId)?.finish();
		const card = new MaintenanceTraceCard({
			action: event.action,
			reason: event.reason,
			fallbackCause: event.fallbackCause,
			targetPath: event.targetPath,
			canCancel: this.#maintenanceEscHint() !== "",
		});
		this.#maintenanceTraceCards.set(event.traceId, card);
		this.ctx.present(card);
	}

	#handleMaintenanceTracePhase(event: Extract<AgentSessionEvent, { type: "maintenance_trace_phase" }>): void {
		const card = this.#maintenanceTraceCards.get(event.traceId);
		card?.updatePhase(event.phase, event.targetPath);
		if (event.action !== "scratch-handoff" || !this.ctx.autoCompactionLoader) return;
		this.ctx.autoCompactionLoader.setMessage(
			`${this.#scratchHandoffTracePhaseLabel(event.phase)}${this.#scratchHandoffTraceTarget(event.targetPath)}…${this.#maintenanceEscHint()}`,
		);
		this.ctx.ui.requestRender();
	}

	#handleMaintenanceTraceDelta(event: Extract<AgentSessionEvent, { type: "maintenance_trace_delta" }>): void {
		if (!this.#shouldShowMaintenanceTraceCard()) return;
		this.#maintenanceTraceCards.get(event.traceId)?.appendTraceDelta(event.content, event.delta);
	}

	#handleMaintenanceTraceEnd(event: Extract<AgentSessionEvent, { type: "maintenance_trace_end" }>): void {
		const card = this.#maintenanceTraceCards.get(event.traceId);
		if (!card) return;
		if (!this.ctx.chatContainer.children.includes(card)) {
			this.ctx.present(card);
		}
		card.complete(event.terminalResult, {
			errorMessage: event.errorMessage,
			willRetry: event.willRetry,
			debugLogRef: event.debugLogRef,
		});
		this.#maintenanceTraceCards.delete(event.traceId);
	}

	#scratchHandoffTracePhaseLabel(
		eventPhase: Extract<AgentSessionEvent, { type: "maintenance_trace_phase" }>["phase"],
	): string {
		switch (eventPhase) {
			case "scratch-target-resolved":
				return "Context pressure: scratch target resolved";
			case "scratch-session-compacted":
				return "Context pressure: scratch session compacted";
			case "scratch-read-injected":
				return "Context pressure: scratch state loaded";
			case "scratch-session-rebuilt":
				return "Context pressure: session rebuilt";
			case "scratch-todo-synced":
				return "Context pressure: todos synced";
			case "action-fallback":
				return "Context pressure: maintenance fallback";
		}
	}

	#scratchHandoffTraceTarget(targetPath: string | undefined): string {
		if (!targetPath) return "";
		return ` (${previewLine(shortenPath(targetPath), TRUNCATE_LENGTHS.SHORT)})`;
	}

	async #handleAutoCompactionStart(
		event: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>,
	): Promise<void> {
		this.#cancelIdleCompaction();
		this.#setTerminalProgress(true);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		const reasonText =
			event.reason === "overflow"
				? "Context overflow detected, "
				: event.reason === "incomplete"
					? "Response incomplete, "
					: event.reason === "idle"
						? "Idle "
						: "";
		const actionLabel = this.#maintenanceActionLabel(event.action);
		const prefix = event.action === "scratch-handoff" ? "Context pressure: " : reasonText;
		this.ctx.autoCompactionLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("accent", spinner),
			text => theme.fg("muted", text),
			`${prefix}${actionLabel}…${this.#maintenanceEscHint()}`,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.autoCompactionLoader);
		this.ctx.ui.requestRender();
	}

	#maintenanceActionLabel(action: Extract<AgentSessionEvent, { type: "auto_compaction_start" }>["action"]): string {
		switch (action) {
			case "handoff":
				return "Auto-handoff";
			case "shake":
				return "Auto-shake";
			case "snapcompact":
				return "Auto-snapcompact";
			case "scratch-handoff":
				return "syncing scratch";
			case "context-full":
				return "Auto context-full maintenance";
		}
	}

	async #handleAutoCompactionEnd(event: Extract<AgentSessionEvent, { type: "auto_compaction_end" }>): Promise<void> {
		this.#cancelIdleCompaction();
		this.#setTerminalProgress(false);
		if (this.ctx.autoCompactionLoader) {
			this.ctx.autoCompactionLoader.stop();
			this.ctx.autoCompactionLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		const isHandoffAction = event.action === "handoff";
		const isShakeAction = event.action === "shake";
		const isSnapcompactAction = event.action === "snapcompact";
		const isScratchHandoffAction = event.action === "scratch-handoff";
		if (event.aborted) {
			this.ctx.showStatus(
				isScratchHandoffAction
					? "Scratch handoff cancelled"
					: isHandoffAction
						? "Auto-handoff cancelled"
						: isShakeAction
							? "Auto-shake cancelled"
							: isSnapcompactAction
								? "Auto-snapcompact cancelled"
								: "Auto context-full maintenance cancelled",
			);
		} else if (isShakeAction) {
			// Shake produces no CompactionResult; rebuild on success, suppress benign skips.
			// The fallback path (`errorMessage` set, `skipped` false) means shake reclaimed
			// some tokens before deciding the threshold still wasn't cleared — rebuild so
			// the chat reflects the dropped regions even though a context-full pass follows.
			if (event.errorMessage) {
				if (!event.skipped) {
					this.ctx.rebuildChatFromMessages();
					this.ctx.statusLine.invalidate();
					this.ctx.ui.requestRender();
				}
				this.ctx.showWarning(event.errorMessage);
			} else if (!event.skipped) {
				this.ctx.lastAssistantUsage = undefined;
				this.ctx.rebuildChatFromMessages();
				this.ctx.statusLine.invalidate();
				this.ctx.ui.requestRender();
				this.ctx.showStatus("Auto-shake completed");
			}
		} else if (event.result) {
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.rebuildChatFromMessages({ reuseSettledComponents: true });
			this.ctx.statusLine.invalidate();
			// When history collapses behind the summary divider, the frame
			// shrinks far below the committed row count; without clearing, the
			// differential renderer's "duplication, never loss" resync repaints
			// the whole collapsed transcript (welcome box included) BELOW the
			// stale pre-compaction scrollback. Compaction is an intentional
			// transcript replacement then — same as auto-handoff below. With
			// collapse disabled the rebuilt transcript keeps the full history,
			// so the resync handles it and scrollback stays.
			if (settings.get("display.collapseCompacted")) {
				this.ctx.ui.requestRender(true, { clearScrollback: true });
			} else {
				this.ctx.ui.requestRender();
			}
		} else if (event.errorMessage) {
			this.ctx.showWarning(event.errorMessage);
		} else if (isScratchHandoffAction) {
			// Hidden Boss scratch-handoff is operator-visible only while it is active;
			// success should not leave a transcript breadcrumb or resemble a user turn.
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		} else if (isHandoffAction) {
			this.ctx.clearTransientSessionUi();
			this.ctx.lastAssistantUsage = undefined;
			this.ctx.renderInitialMessages();
			this.ctx.statusLine.invalidate();
			await this.ctx.reloadTodos();
			this.ctx.ui.requestRender(true, { clearScrollback: true });
			this.ctx.showStatus("Auto-handoff completed");
		} else if (event.skipped) {
			// Benign skip: no model selected, no candidate models available, or nothing
			// to compact yet. Not a failure — suppress the warning.
		} else if (isSnapcompactAction) {
			this.ctx.showWarning("Auto-snapcompact maintenance failed; continuing without maintenance");
		} else {
			this.ctx.showWarning("Auto context-full maintenance failed; continuing without maintenance");
		}
		await this.ctx.flushCompactionQueue({ willRetry: event.willRetry });
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryStart(event: Extract<AgentSessionEvent, { type: "auto_retry_start" }>): Promise<void> {
		this.#retryPending = true;
		this.#trackRetrySupersededAssistantComponent(this.#lastAssistantComponent);
		this.#stopWorkingLoader();
		this.ctx.statusContainer.disposeChildren();
		if (AIError.is(event.errorId, AIError.Flag.ThinkingLoop)) {
			// The retry path drops the failed assistant from runtime context. Do not
			// restore its inline Error row; just unpin the fixed-region banner so the
			// retry UI is the visible state.
			this.#pinnedErrorComponent = undefined;
			this.ctx.clearPinnedError();
		}
		const delaySeconds = Math.round(event.delayMs / 1000);
		const escHint = this.#maintenanceEscHint();
		const resetAtMs = event.usageResetAtMs;
		// When every account is rate-limited and a concrete reset is known, show a
		// live countdown to auto-resume; the function message re-evaluates each
		// spinner tick so the remaining time ticks down without further events.
		const message =
			resetAtMs !== undefined
				? () => `All accounts rate-limited. Resuming in ${formatResumeCountdown(resetAtMs - Date.now())}…${escHint}`
				: `Retrying (${event.attempt}/${event.maxAttempts}) in ${delaySeconds}s…${escHint}`;
		this.ctx.retryLoader = new Loader(
			this.ctx.ui,
			spinner => theme.fg("warning", spinner),
			text => theme.fg("muted", text),
			message,
			getSymbolTheme().spinnerFrames,
		);
		this.ctx.statusContainer.addChild(this.ctx.retryLoader);
		this.ctx.ui.requestRender();
	}

	async #handleAutoRetryEnd(event: Extract<AgentSessionEvent, { type: "auto_retry_end" }>): Promise<void> {
		this.#retryPending = false;
		if (this.ctx.retryLoader) {
			this.ctx.retryLoader.stop();
			this.ctx.retryLoader = undefined;
			this.ctx.statusContainer.disposeChildren();
		}
		if (event.success) {
			let appliedRecovered = false;
			for (const recovered of event.recoveredErrors ?? []) {
				const component = this.#takeRetrySupersededAssistantComponent(recovered.persistenceKey);
				if (!component) continue;
				component.applyRetryRecovery(recovered.retryRecovery);
				if (this.#pinnedErrorComponent === component) this.#pinnedErrorComponent = undefined;
				appliedRecovered = true;
			}
			if (appliedRecovered || (event.recoveredErrors?.length ?? 0) > 0) {
				this.ctx.clearPinnedError();
			}
			this.#clearRetrySupersededAssistantComponents();
		} else {
			this.#clearRetrySupersededAssistantComponents();
			this.ctx.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
		}
		this.#ensureWorkingLoaderWhileStreaming();
		this.ctx.ui.requestRender();
	}

	async #handleRetryFallbackApplied(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>,
	): Promise<void> {
		this.ctx.showWarning(`Fallback: ${event.from} -> ${event.to}`);
	}

	async #handleRetryFallbackSucceeded(
		event: Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>,
	): Promise<void> {
		this.ctx.showStatus(`Fallback succeeded on ${event.model}`);
	}

	async #handleTtsrTriggered(event: Extract<AgentSessionEvent, { type: "ttsr_triggered" }>): Promise<void> {
		// Consecutive notifications (e.g. per-tool matches from one assistant
		// message) merge into the previous block instead of stacking. Mutating an
		// existing block is only safe while none of its rows have entered native
		// scrollback — committed rows are immutable visual history and a grown
		// block would shift them.
		const previous = this.#lastTtsrNotification;
		if (
			previous &&
			this.ctx.chatContainer.children.at(-1) === previous &&
			this.ctx.chatContainer.isBlockUncommitted(previous)
		) {
			previous.addRules(event.rules);
			this.ctx.ui.requestRender();
			return;
		}
		const component = new TtsrNotificationComponent(event.rules);
		component.setExpanded(this.ctx.toolOutputExpanded);
		this.ctx.present(component);
		this.#lastTtsrNotification = component;
	}

	async #handleTodoReminder(event: Extract<AgentSessionEvent, { type: "todo_reminder" }>): Promise<void> {
		const component = new TodoReminderComponent(event.todos, event.attempt, event.maxAttempts);
		this.ctx.present(component);
	}

	async #handleTodoAutoClear(_event: Extract<AgentSessionEvent, { type: "todo_auto_clear" }>): Promise<void> {
		await this.ctx.reloadTodos();
	}

	#cancelIdleCompaction(): void {
		if (this.#idleCompactionTimer) {
			clearTimeout(this.#idleCompactionTimer);
			this.#idleCompactionTimer = undefined;
		}
	}

	#scheduleIdleCompaction(): void {
		this.#cancelIdleCompaction();
		// Don't schedule idle work while context maintenance is already running; the
		// maintenance flow may reset the session before this timer fires.
		if (this.ctx.viewSession.isCompacting) return;

		const idleSettings = settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;

		// Only if input is empty
		if (this.ctx.editor.getText().trim()) return;

		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0) return;
		if (this.#currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		this.#idleCompactionTimer = setTimeout(() => {
			this.#idleCompactionTimer = undefined;
			// Re-check conditions before firing. Pruning may have run between arming
			// the timer and now, dropping usage back below the idle threshold.
			if (this.ctx.viewSession.isStreaming) return;
			if (this.ctx.viewSession.isCompacting) return;
			if (this.ctx.editor.getText().trim()) return;
			// The idle gate itself is mutable: `compaction.idleEnabled` and
			// `idleThresholdTokens` can change while this timer is pending, and the
			// values captured at arm time are what the callback would otherwise fire
			// on. Firing on a stale gate would run idle compaction the user has since
			// turned off, or trigger on a threshold no longer in force — which the
			// request then reports as whatever the settings say at metadata time, a
			// threshold that never fired. Re-resolve the gate here so the policy that
			// authorizes the run is the one that governs it.
			const armed = buildEffectiveIdleThreshold(settings);
			if (!armed.enabled || armed.thresholdTokens <= 0) return;
			if (this.#currentContextTokens() < armed.thresholdTokens) return;
			// Hand the run the exact threshold that cleared it, rather than letting
			// the compaction path re-read settings that can change again while it is
			// in flight.
			void this.ctx.viewSession.runIdleCompaction({ idleThreshold: armed });
		}, timeoutMs);
		this.#idleCompactionTimer.unref?.();
	}

	#currentContextTokens(): number {
		return this.ctx.viewSession.getContextUsage()?.tokens ?? 0;
	}

	sendErrorNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		// A running async job or queued delivery will wake the session again, so
		// its current agent_end is a scheduling pause rather than a user-visible
		// terminal failure. AgentSession marks that stable outcome before
		// dispatching the deferred event; do not infer it from mutable job state.
		if (event.isTerminal === false) return;

		// `AgentSession` defers and coalesces the wire-level `agent_end` while a
		// prompt is still in flight (see `#emitSessionEvent` in agent-session.ts):
		// every mid-retry attempt's own settle is superseded, so this method often
		// sees only ONE `agent_end` for an entire multi-attempt retry saga — which
		// can be the final failure, not an intermediate one. Gate purely on the
		// retry lifecycle (`auto_retry_start`/`auto_retry_end`, which are never
		// deferred) rather than consuming this flag against whichever `agent_end`
		// happens to arrive first: `#retryPending` is true only for the actual
		// window a retry is outstanding, so the settled failure that survives
		// coalescing is never mistaken for a mid-retry blip.
		if (this.#retryPending) return;

		// Warp structured OSC 777 already drives native completion UX when the
		// protocol is negotiated — avoid a second legacy desktop/OSC-9 toast.
		if (isWarpCliAgentProtocolActive()) return;

		const notify = settings.get("error.notify");
		if (notify === "off") return;

		// Read the turn's own outcome from `agent_end.messages`, not the mutable
		// active context: a classifier-refusal failure is final (stopReason ===
		// "error") but gets pruned from `viewSession`'s active context before this
		// handler runs (see `#removeAssistantMessageFromActiveContext` in
		// agent-session.ts), so `getLastAssistantMessage()` would see a stale or
		// absent assistant and silently drop the notification.
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason !== "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Oh My Pi",
			body: "Stopped with error",
			type: "error",
			actions: "focus",
		});
	}

	sendCompletionNotification(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
		const notify = settings.get("completion.notify");
		if (notify === "off") return;

		// Warp structured OSC 777 already drives native completion UX when the
		// protocol is negotiated — avoid a second legacy desktop/OSC-9 toast.
		if (isWarpCliAgentProtocolActive()) return;

		// Read the turn's own outcome from `agent_end.messages`, not the mutable
		// active context (see `sendErrorNotification` above for why `viewSession`'s
		// snapshot can be stale): an aborted or errored turn is not "Task
		// complete", and using the same event `sendErrorNotification` just read
		// keeps the two notifications mutually exclusive for one settled turn.
		const last = event.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;

		const sessionName = this.ctx.sessionManager.getSessionName();
		TERMINAL.sendNotification({
			title: sessionName || "Oh My Pi",
			body: "Complete",
			type: "completion",
			actions: "focus",
		});
	}
}

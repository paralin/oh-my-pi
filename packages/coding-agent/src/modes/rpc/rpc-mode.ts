/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { once } from "node:events";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { type Theme, theme } from "../../modes/theme/theme";
import { type AgentSession, persistenceSafeAgentSessionEvent } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { sessionMessageUsage } from "../../session/session-stats";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { parseSlashCommand } from "../../slash-commands/helpers/parse";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { initializeExtensions } from "../runtime-init";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import {
	type RpcHarnessEvent,
	RpcHarnessSessionOwner,
	rpcHarnessRecordFileForSessionFile,
	rpcSteeringPayloadIdentity,
} from "./rpc-harness";
import { claimRpcInput, readRpcInputFrames } from "./rpc-input";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcResponse,
	RpcSessionState,
	RpcSessionUsage,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

// Re-export types for consumers
export type * from "./rpc-types";

export function isRpcCustodyRestrictedPrompt(message: string): boolean {
	const name = parseSlashCommand(message)?.name;
	return name === "move" || name === "compact";
}

export function startRpcResidualPrompt<T>(
	owner: Pick<RpcHarnessSessionOwner, "assertAcceptingWork"> | undefined,
	start: () => T,
): T {
	owner?.assertAcceptingWork();
	return start();
}

/**
 * Whether the episode still owes work that must land before a terminal result.
 *
 * Advisor reviews count even though every primary-facing signal here can read
 * idle while one is running: advisors review out of band, and a review that
 * lands late persists a card into the transcript or resumes the primary through
 * a trigger-turn blocker. Sealing on the primary signals alone writes the
 * terminal result over work that then appears after it.
 */
export function hasPendingRpcContinuation(
	session: Pick<
		AgentSession,
		| "hasPendingAdvisorReviews"
		| "hasPendingAsyncWork"
		| "hasPendingBashMessages"
		| "hasQueuedAgentMessages"
		| "isCompacting"
		| "isStreaming"
	>,
): boolean {
	return (
		session.isStreaming ||
		session.isCompacting ||
		session.hasPendingAsyncWork() ||
		session.hasPendingBashMessages ||
		session.hasQueuedAgentMessages ||
		session.hasPendingAdvisorReviews
	);
}

export function rpcExitOutcome(hasIncompleteWork: boolean): "aborted" | "completed" {
	return hasIncompleteWork ? "aborted" : "completed";
}
/**
 * Acceptance control for one terminal seal attempt.
 *
 * Every source of episode work — extension handlers, stranded IRC asides, and
 * the yield queue's idle flush — asks the custody gate before starting, so
 * closing that gate is what makes a continuation check final. `reopen()`
 * abandons the attempt: it must also re-arm whatever the closed gate parked,
 * because a refused wake leaves its entries queued with no self-rearming timer.
 */
export interface RpcResultSealAcceptance {
	/** Stop admitting episode work, so a continuation check cannot go stale. */
	close(): void;
	/** Abandon the attempt: readmit work and re-arm the wakes the gate parked. */
	reopen(): void;
}

/** Closes custody for a seal attempt and re-arms parked idle flushes when it is abandoned. */
export function rpcResultSealAcceptance(
	owner: Pick<RpcHarnessSessionOwner, "beginResultSeal" | "cancelResultSeal">,
	requestIdleFlush: () => void,
): RpcResultSealAcceptance {
	return {
		close: () => owner.beginResultSeal(),
		reopen: () => {
			owner.cancelResultSeal();
			// Reopening only stops the gate refusing; nothing re-evaluates the wakes
			// it already parked, and neither `#endInFlight` nor `#resetInFlight`
			// does more than re-ask the same gate. Re-arm once here — the same
			// re-arm `bindHarness` performs once custody settles — or entries parked
			// by this abandoned attempt wait for disposal.
			requestIdleFlush();
		},
	};
}
export function retryRpcResultSealAfterAdvisorSettlement(
	session: Pick<AgentSession, "onAdvisorReviewsSettled">,
	retry: () => void,
): () => void {
	let active = true;
	let unsubscribe = () => {};
	const settled = () => {
		if (!active) return;
		active = false;
		unsubscribe();
		retry();
	};
	unsubscribe = session.onAdvisorReviewsSettled(settled);
	return () => {
		if (!active) return;
		active = false;
		unsubscribe();
	};
}

/**
 * Decide whether the terminal result may be sealed now.
 *
 * A forced exit path seals unconditionally. Otherwise the terminal boundary is
 * drained and the episode checked for a continuation — but the check on its own
 * settles nothing, because work enters through a custody gate that stays open
 * across every `await` here. A check that yields before sealing can have its
 * answer invalidated by extension, IRC, or yield-queue work admitted in the gap,
 * and the terminal result would then be written over work that is still running.
 *
 * So acceptance closes in the same synchronous step the first drain resolves in,
 * and the boundary is drained a second time with the gate shut — nothing new can
 * enter now, and work admitted *during* the first drain reaches a boundary and
 * becomes visible. Only then does the continuation check decide. Finding a
 * continuation abandons the attempt and reopens acceptance.
 */
export async function prepareRpcResultSeal(
	force: boolean,
	drain: () => Promise<void>,
	hasPendingContinuation: () => boolean,
	acceptance?: RpcResultSealAcceptance,
): Promise<boolean> {
	if (force) return true;
	await drain();
	acceptance?.close();
	try {
		await drain();
		if (!hasPendingContinuation()) return true;
	} catch (errorValue) {
		acceptance?.reopen();
		throw errorValue;
	}
	acceptance?.reopen();
	return false;
}
export async function compactRpcSession<T>(
	isStreaming: boolean,
	compact: () => Promise<T>,
	sealResult?: (stopReason: string, outcome: "aborted") => Promise<void>,
): Promise<T> {
	try {
		return await compact();
	} finally {
		if (isStreaming) await sealResult?.("aborted", "aborted");
	}
}

export async function materializeRpcCustodyTranscript(session: {
	readonly sessionFile: string | undefined;
	sessionManager: { ensureOnDisk(): Promise<void> };
}): Promise<string> {
	if (!session.sessionFile) throw new Error("Durable RPC custody requires a persisted session");
	await session.sessionManager.ensureOnDisk();
	const sessionFile = session.sessionFile;
	if (!sessionFile) throw new Error("Durable RPC custody requires a persisted session");
	return sessionFile;
}

export async function waitForRpcMessageDurability(
	session: {
		waitForMessagePersistence(message: AgentMessage): Promise<void>;
		sessionManager: { flush(): Promise<void> };
	},
	message: AgentMessage,
): Promise<void> {
	await session.waitForMessagePersistence(message);
	await session.sessionManager.flush();
}

export function reuseRpcHarnessBinding(
	owner: Pick<RpcHarnessSessionOwner, "isBoundToRun" | "sessionId"> | undefined,
	runId: string,
):
	| {
			owner: Pick<RpcHarnessSessionOwner, "isBoundToRun" | "sessionId">;
			binding: { runId: string; sessionId: string; existing: true };
	  }
	| undefined {
	if (!owner?.isBoundToRun(runId)) return undefined;
	return { owner, binding: { runId, sessionId: owner.sessionId, existing: true } };
}
export function hasActiveRpcSessionWork(
	session: Pick<
		AgentSession,
		| "hasPendingAdvisorReviews"
		| "hasPendingAsyncWork"
		| "hasPendingBashMessages"
		| "hasPendingExtensionEvents"
		| "hasQueuedAgentMessages"
		| "isCompacting"
		| "isStreaming"
	>,
	hasTrackedTasks: boolean,
	hasActivePrompts: boolean,
	hasPendingAgentMessageTasks: boolean,
): boolean {
	return (
		hasPendingRpcContinuation(session) ||
		session.hasPendingExtensionEvents ||
		hasTrackedTasks ||
		hasActivePrompts ||
		hasPendingAgentMessageTasks
	);
}

export async function disposeRpcSessionWithCustody(
	session: { dispose(): Promise<void> },
	owner?: { dispose(): Promise<void> },
): Promise<void> {
	await session.dispose();
	await owner?.dispose();
}

export async function deliverRpcSteeringIfNeeded(
	alreadyPersisted: boolean,
	deliver: () => Promise<boolean | void>,
): Promise<void> {
	if (alreadyPersisted) return;
	if ((await deliver()) === false) throw new Error("Steering delivery was cancelled before the message was queued");
}

function providerSafeAssistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	const safeEvent = persistenceSafeAgentSessionEvent(event);
	if (safeEvent.type !== "message_end" || safeEvent.message.role !== "assistant") return undefined;
	const text = safeEvent.message.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("")
		.trim();
	return text || undefined;
}

function addRpcUsage(target: RpcSessionUsage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.reasoning += usage.reasoningTokens ?? 0;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.total += usage.totalTokens;
}

export function summarizeRpcEpisode(events: readonly RpcHarnessEvent[]): {
	finalMessage: string;
	usage: RpcSessionUsage;
} {
	let finalMessage = "";
	const usage: RpcSessionUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	for (const event of events) {
		if (event.type !== "message_end") continue;
		finalMessage = providerSafeAssistantText(event as AgentSessionEvent) ?? finalMessage;
		const messageUsage = sessionMessageUsage(event.message);
		if (messageUsage) addRpcUsage(usage, messageUsage);
	}
	return { finalMessage, usage };
}

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch">;

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			if (agentInvoked) return;
			await input.waitForExtensionAgentMessageTasks?.();
			if (!input.hasExtensionAgentMessageTask?.()) {
				input.output({ type: "prompt_result", id: input.id, agentInvoked: false });
			}
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; that prompt must not report agentInvoked:false to the host.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();
	#pendingAgentMessageTasks = new Set<Promise<void>>();
	get hasActivePrompts(): boolean {
		return this.#activePromptScopes.size > 0;
	}

	get hasPendingAgentMessageTasks(): boolean {
		return this.#pendingAgentMessageTasks.size > 0;
	}

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		const pendingTask = task.then(
			() => {},
			() => {},
		);
		this.#pendingAgentMessageTasks.add(pendingTask);
		void pendingTask.then(() => {
			this.#pendingAgentMessageTasks.delete(pendingTask);
		});
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	async waitForPendingAgentMessageTasks(): Promise<void> {
		while (this.#pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled([...this.#pendingAgentMessageTasks]);
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	trackPrompt?: (task: Promise<boolean>) => Promise<boolean>;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: input.trackPrompt?.(trackedPrompt.prompt) ?? trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

export class RpcTerminalTaskTracker {
	#tasks = new Set<Promise<unknown>>();

	track<T>(task: Promise<T>): Promise<T> {
		this.#tasks.add(task);
		void task.finally(() => this.#tasks.delete(task)).catch(() => {});
		return task;
	}

	get hasPendingTasks(): boolean {
		return this.#tasks.size > 0;
	}

	async wait(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled([...this.#tasks]);
		}
	}
}
export function rpcForcedExitOutcome(
	session: Parameters<typeof hasPendingRpcContinuation>[0],
	terminalTasks: Pick<RpcTerminalTaskTracker, "hasPendingTasks">,
): "aborted" | "completed" {
	return rpcExitOutcome(hasPendingRpcContinuation(session) || terminalTasks.hasPendingTasks);
}

export async function drainRpcTerminalBoundary(
	session: Pick<
		AgentSession,
		| "flushPendingBashMessages"
		| "hasPendingAdvisorReviews"
		| "hasPendingBashMessages"
		| "hasPendingExtensionEvents"
		| "waitForPendingAdvisorReviews"
		| "waitForPendingExtensionEvents"
	>,
	terminalTasks: RpcTerminalTaskTracker,
	extensionTasks: RpcExtensionUserMessageTracker,
): Promise<void> {
	do {
		await session.waitForPendingExtensionEvents();
		await Promise.all([terminalTasks.wait(), extensionTasks.waitForPendingAgentMessageTasks()]);
		if (session.hasPendingBashMessages) await session.flushPendingBashMessages();
		// Give an in-flight advisor review its chance to land inside the boundary
		// rather than after the terminal result. The wait is bounded, so it is
		// deliberately absent from the loop condition below: an advisor that never
		// catches up would otherwise spin here. What it leaves behind stays visible
		// to `hasPendingRpcContinuation`, which then refuses the seal outright.
		if (session.hasPendingAdvisorReviews) await session.waitForPendingAdvisorReviews();
	} while (
		session.hasPendingExtensionEvents ||
		terminalTasks.hasPendingTasks ||
		extensionTasks.hasPendingAgentMessageTasks ||
		session.hasPendingBashMessages
	);
}

export class RpcCustodyBindingGuard {
	#binding = false;

	async run<T>(bind: () => Promise<T>): Promise<T> {
		if (this.#binding) throw new Error("Durable RPC custody binding is already in progress");
		this.#binding = true;
		try {
			return await bind();
		} finally {
			this.#binding = false;
		}
	}

	assertWorkAllowed(): void {
		if (this.#binding) throw new Error("Agent work is unavailable while durable RPC custody is binding");
	}

	assertSessionChangeAllowed(): void {
		if (this.#binding) throw new Error("Session changes are unavailable while durable RPC custody is binding");
	}
}

/**
 * Dependencies for {@link streamRpcSessionEvent}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the event path with stubs.
 */
export interface RpcSessionEventStreamDeps {
	/** The ledger for the currently bound run, or undefined while none is bound. */
	ledger: () => RpcHarnessSessionOwner | undefined;
	output: (frame: object) => void;
	sealResult: (stopReason: string, outcome: "completed" | "failed" | "aborted") => Promise<void>;
	waitForMessagePersistence: (message: AgentMessage) => Promise<void>;
	trackSteeringPersistence: (task: Promise<void>) => void;
	onLedgerFailure: (command: string, error: unknown) => void;
}

/**
 * Write one agent event to stdout.
 *
 * A bound run records and sequences the event before it is published, and a
 * failed append reports `session.watch` and stops the run: emitting an event the
 * client can never replay would break the replay cursor it depends on. An
 * `agent_end` under a bound run also seals the terminal result. With no bound
 * run the event is written straight through, unsequenced and unrecorded, which
 * is the stream every client saw before the ledger existed.
 */
export function streamRpcSessionEvent(
	event: AgentSessionEvent,
	deps: RpcSessionEventStreamDeps,
): Promise<void> | undefined {
	const ledger = deps.ledger();
	if (!ledger) {
		deps.output(event);
		return undefined;
	}
	if (ledger.hasResult) return undefined;
	const eventPersistence = ledger.appendEvent(persistenceSafeAgentSessionEvent(event), event).then(() => undefined);
	void eventPersistence.catch(errorValue => {
		if (ledger.hasResult) return;
		deps.onLedgerFailure("session.watch", errorValue);
	});
	if (event.type === "message_end" && event.message.role === "user" && event.message.idempotencyKey) {
		const prefix = `rpc:${ledger.sessionId}:`;
		if (event.message.idempotencyKey.startsWith(prefix)) {
			const steeringId = event.message.idempotencyKey.slice(prefix.length);
			const persistence = deps
				.waitForMessagePersistence(event.message)
				.then(() => ledger.markSteeringInjected(steeringId));
			deps.trackSteeringPersistence(persistence);
			void persistence.catch(errorValue => deps.onLedgerFailure("session.steer", errorValue));
		}
	}
	if (event.type === "agent_end" && event.isTerminal === true) {
		const assistantMessage = [...event.messages].reverse().find(message => message.role === "assistant") as
			| { stopReason?: string }
			| undefined;
		const stopReason = assistantMessage?.stopReason ?? "completed";
		const outcome = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "failed" : "completed";
		void deps.sealResult(stopReason, outcome).catch(errorValue => {
			deps.onLedgerFailure("session.result", errorValue);
		});
	}
	return eventPersistence;
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Bash commands are dispatched in the background so the caller can keep reading
 * subsequent frames while a shell command is still running. This lets a client
 * send `abort_bash` while a long-running `bash` is in flight. Response
 * correlation is preserved via each command's `id`; ordering across concurrent
 * commands is not guaranteed and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or dispatched in the
 *   background (`bash`). Otherwise a promise that resolves once the response
 *   for the command has been emitted via `output`. Errors from `handleCommand`
 *   on non-`bash` commands propagate; the caller is expected to wrap them.
 */
function isBackgroundRpcCommand(command: RpcCommand): boolean {
	return command.type === "bash" || command.type === "session.result";
}

export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; `handleCommand`'s `default` arm surfaces
	// unknown discriminants as an error response, so we do not shape-check
	// the union here.
	const command = parsed as RpcCommand;

	// Long-running commands dispatch in the background so later control and
	// steering commands can overtake them. The response is emitted when the
	// command resolves; clients correlate it through `command.id`.
	if (isBackgroundRpcCommand(command)) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordinary RPC commands while allowing control frames to dispatch immediately. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	#resultWaits = new Set<Promise<void>>();
	#running = new Set<RpcCommand>();
	#closing = false;
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;
	readonly #isLongRunningSerialCommand: ((command: RpcCommand) => boolean) | undefined;
	readonly #abortSerialCommand: ((command: RpcCommand) => void) | undefined;

	constructor(options: {
		deps: RpcInputFrameDeps;
		afterSerialCommand?: () => Promise<void>;
		/** Whether a serial command starts work that only an abort can settle. */
		isLongRunningSerialCommand?: (command: RpcCommand) => boolean;
		/** Aborts the started work of a long-running serial command. */
		abortSerialCommand?: (command: RpcCommand) => void;
	}) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
		this.#isLongRunningSerialCommand = options.isLongRunningSerialCommand;
		this.#abortSerialCommand = options.abortSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (command.type === "session.result") {
				// A result wait can only settle once terminal state exists, and on
				// the EOF path that state is created by `sealLedgerOnExit()` which
				// runs *after* `drain()`. Result waits therefore get their own
				// custody set instead of `#tasks`: the pre-seal drain covers the
				// serial tail only, and `drainResultWaits()` (post-seal) plus
				// `trackBackgroundTask` keep shutdown and disposal waiting for the
				// response frame this command still owes the client.
				const wait = this.#tail.then(
					() => this.#dispatchResultWait(command),
					() => this.#dispatchResultWait(command),
				);
				this.#resultWaits.add(wait);
				void wait.finally(() => this.#resultWaits.delete(wait)).catch(() => {});
				return;
			}

			if (isBackgroundRpcCommand(command)) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(undefined, "parse", `Failed to parse command: ${message}`));
		}
	}

	/**
	 * Close the accepted serial tail for an exit path.
	 *
	 * A serial command that only an abort can settle — `compact` parked on a
	 * provider summary is the case that wedges the process — is aborted here if
	 * it has already started, so {@link drain} can finish. The abort has to
	 * happen before that drain rather than during teardown: the exit path seals
	 * the ledger after the drain, and `session.dispose()`, which owns this abort
	 * today, runs only after the seal. Waiting first costs the whole exit and
	 * buys nothing, because disposal aborts the same work moments later anyway.
	 *
	 * A command of that kind still queued has not started, so there is nothing to
	 * abort; it is refused when its turn comes instead, since starting fresh
	 * long-running work after the client is gone would re-stall the drain this
	 * abort just unblocked. Ordinary queued commands are untouched and still run.
	 * Both refused and aborted commands settle through
	 * {@link RpcInputDispatcher.dispatch}'s serial path, so each still emits the
	 * response or error frame it owes the client.
	 */
	closeForExit(): void {
		this.#closing = true;
		for (const command of this.#running) {
			if (this.#isLongRunningSerialCommand?.(command)) this.#abortSerialCommand?.(command);
		}
	}

	/**
	 * Await every accepted serial command, including commands queued before EOF.
	 *
	 * Deferred `session.result` waits are deliberately excluded — see
	 * {@link drainResultWaits} — so an exit path can finish this drain and seal
	 * the terminal result the waiters are blocked on.
	 */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/** Whether a `session.result` command still owes the client a response frame. */
	get hasPendingResultWaits(): boolean {
		return this.#resultWaits.size > 0;
	}

	/**
	 * Await every accepted `session.result` command, including one still queued
	 * behind the serial tail. Only safe once the terminal result has been sealed.
	 */
	async drainResultWaits(): Promise<void> {
		while (this.#resultWaits.size > 0) {
			await Promise.allSettled(Array.from(this.#resultWaits));
		}
	}

	/**
	 * Run a deferred `session.result` once the serial tail settles.
	 *
	 * {@link dispatchRpcInputFrame} dispatches it in the background and hands the
	 * wait to `trackBackgroundTask`; that task is intercepted here (and still
	 * forwarded) so this promise covers the whole command — queue wait, dispatch,
	 * and the wait for terminal state — and dispatch failures still reach the
	 * client as a response frame instead of an unhandled rejection.
	 */
	async #dispatchResultWait(command: RpcCommand): Promise<void> {
		let resultWait: Promise<void> | undefined;
		try {
			const awaited = dispatchRpcInputFrame(command, {
				...this.#deps,
				trackBackgroundTask: task => {
					resultWait = task;
					this.#deps.trackBackgroundTask?.(task);
				},
			});
			if (awaited) await awaited;
			if (resultWait) await resultWait;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			// Reached its turn only after the exit path closed the tail: starting
			// long-running work now would re-stall the drain that close unblocked.
			// Refusing is still custody — the error frame below is the response this
			// command owes — whereas starting it would strand the exit again.
			if (this.#closing && this.#isLongRunningSerialCommand?.(command)) {
				throw new Error("RPC client disconnected before the command started");
			}
			this.#running.add(command);
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			this.#running.delete(command);
			await this.#afterSerialCommand?.();
		}
	}
}

export async function finalizeRpcInputAfterEof(
	drainInput: () => Promise<void>,
	sealLedger: () => Promise<void>,
	drainBackground: () => Promise<void>,
): Promise<void> {
	await drainInput();
	await sealLedger();
	await drainBackground();
}

/**
 * Whether an exit path must still force the terminal seal.
 *
 * Failure reporting latches on the first durable failure from any path,
 * including a session transcript flush that never reached the ledger. Only a
 * latched ledger append failure takes sealing away, so every other failure
 * still has to seal: an unsealed ledger leaves `session.result` waiters blocked
 * in the shutdown drain and the episode without terminal state.
 */
export function shouldForceLedgerSeal(ledger: RpcHarnessSessionOwner | undefined): boolean {
	return ledger?.canSealResult === true;
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-bash with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;
	readonly #prepareShutdown: (() => Promise<void>) | undefined;

	constructor(options: {
		isShutdownRequested: () => boolean;
		prepareShutdown?: () => Promise<void>;
		performShutdown: () => Promise<void>;
	}) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#prepareShutdown = options.prepareShutdown;
		this.#performShutdown = options.performShutdown;
	}

	get hasTrackedTasks(): boolean {
		return this.#tasks.size > 0;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.#prepareShutdown?.().then(() => this.drain()) ?? this.drain();
			this.#shutdown = this.#shutdown.then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			resolve(parseResponse(response));
		},
		reject,
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;
	// The durable ledger stays dormant until a supervisor claims a run through
	// `session.start` or `session.resume`. A client that never sends those keeps
	// the original stream: events reach stdout directly, carry no sequence, and
	// nothing is written to disk.
	let harnessOwner: RpcHarnessSessionOwner | undefined;
	let episodeFinalMessage = "";
	let episodeUsage: RpcSessionUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const terminalTasks = new RpcTerminalTaskTracker();
	const bindingGuard = new RpcCustodyBindingGuard();
	session.setBackgroundAgentWorkGuard(() => {
		bindingGuard.assertWorkAllowed();
		harnessOwner?.assertAcceptingWork();
	});
	const UNBOUND_RUN_ERROR = "No run is bound: send session.start or session.resume first";
	const bindHarness = (runId: string) => {
		const reused = reuseRpcHarnessBinding(harnessOwner, runId);
		if (reused) {
			return Promise.resolve({
				owner: reused.owner as RpcHarnessSessionOwner,
				binding: reused.binding,
			});
		}
		const existingOwner = harnessOwner;
		return bindingGuard
			.run(async () => {
				const sessionFile = await materializeRpcCustodyTranscript(session);
				const owner =
					existingOwner ??
					(await RpcHarnessSessionOwner.open(
						session.sessionId,
						rpcHarnessRecordFileForSessionFile(sessionFile),
						event => output(event),
						path.join(path.dirname(sessionFile), "rpc-runs.jsonl"),
						{
							acquireSessionLease: true,
							displayEvent: event => session.restoreProviderValueForDisplay(event),
							displayResult: result => ({
								...result,
								finalMessage: session.restoreProviderTextForDisplay(result.finalMessage),
							}),
						},
					));
				try {
					const binding = await owner.bindRun(runId);
					if (!harnessOwner) {
						harnessOwner = owner;
						const summary = summarizeRpcEpisode(await owner.replayPersisted());
						episodeFinalMessage = summary.finalMessage;
						episodeUsage = summary.usage;
					}
					return { owner, binding };
				} catch (error) {
					if (!existingOwner) await owner.dispose();
					throw error;
				}
			})
			.finally(() => {
				// Binding parks yield-queue idle wakes instead of dropping them, and a parked
				// flush has no self-rearming timer. Custody has settled by the time this runs,
				// so re-arm once: entries still blocked by a sealed episode simply park again
				// at the next wake check.
				session.yieldQueue.requestIdleFlush();
			});
	};
	let pendingAdvisorSealRetryUnsubscribe: (() => void) | undefined;

	const completeRpcResult = async (
		stopReason: string,
		outcome: "completed" | "failed" | "aborted" = "completed",
		force = false,
	) => {
		const owner = harnessOwner;
		if (!owner || owner.hasResult) {
			pendingAdvisorSealRetryUnsubscribe?.();
			pendingAdvisorSealRetryUnsubscribe = undefined;
			return;
		}
		if (
			!(await prepareRpcResultSeal(
				force,
				() => drainRpcTerminalBoundary(session, terminalTasks, extensionUserMessageTracker),
				() => hasPendingRpcContinuation(session),
				rpcResultSealAcceptance(owner, () => session.yieldQueue.requestIdleFlush()),
			))
		) {
			if (session.hasPendingAdvisorReviews && !pendingAdvisorSealRetryUnsubscribe) {
				pendingAdvisorSealRetryUnsubscribe = retryRpcResultSealAfterAdvisorSettlement(session, () => {
					pendingAdvisorSealRetryUnsubscribe = undefined;
					void completeRpcResult(stopReason, outcome).catch(errorValue => {
						output(
							error(
								undefined,
								"session.result",
								errorValue instanceof Error ? errorValue.message : String(errorValue),
							),
						);
					});
				});
			}
			return;
		}
		pendingAdvisorSealRetryUnsubscribe?.();
		pendingAdvisorSealRetryUnsubscribe = undefined;
		owner.beginResultSeal();
		await owner.completeResult({
			outcome,
			stopReason,
			finalMessage: episodeFinalMessage,
			usage: episodeUsage,
		});
	};
	/**
	 * Seals the ledger on an exit path. The teardown that follows must run even
	 * when the terminal result cannot be recorded, so the failure is emitted as a
	 * response frame and the exit continues.
	 */
	const sealLedgerOnExit = async (stopReason: string, outcome: "completed" | "failed" | "aborted" = "completed") => {
		try {
			await completeRpcResult(stopReason, outcome, true);
		} catch (errorValue) {
			output(
				error(undefined, "session.result", errorValue instanceof Error ? errorValue.message : String(errorValue)),
			);
		}
	};
	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => {
					if ("cancelled" in response && response.cancelled) {
						if (response.timedOut) dialogOptions?.onTimeout?.();
						return false;
					}
					if ("confirmed" in response) return response.confirmed;
					return false;
				},
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				response => parseValueDialogResponse(response, dialogOptions),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(_message?: string): void {
			// Not supported in RPC mode
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		getEditorText(): string {
			// Synchronous method can't wait for RPC response
			// Host should track editor state locally if needed
			return "";
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(): void {
			// Autocomplete provider composition is not supported in RPC mode
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return Promise.resolve([]);
		}

		getTheme(_name: string): Promise<Theme | undefined> {
			return Promise.resolve(undefined);
		}

		setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
			// Theme switching not supported in RPC mode
			return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		assertAgentWorkAllowed: () => {
			bindingGuard.assertWorkAllowed();
			harnessOwner?.assertAcceptingWork();
		},
		assertSessionChangeAllowed: () => {
			bindingGuard.assertSessionChangeAllowed();
			if (harnessOwner) throw new Error("Session changes are unavailable after durable RPC custody is bound");
		},
		runCompact: instructionsOrOptions =>
			compactRpcSession(
				session.isStreaming,
				() => runExtensionCompact(session, instructionsOrOptions),
				harnessOwner ? completeRpcResult : undefined,
			),
		uiContext: rpcUiContext,
	});

	let requestFatalWatchShutdown: (() => Promise<void>) | undefined;
	let watchFailureReported = false;
	/**
	 * Reports the first durable failure once and requests shutdown. The latch is
	 * reporting only — whether the ledger can still record terminal state is
	 * answered by the ledger itself, through {@link shouldForceLedgerSeal}.
	 */
	const reportLedgerFailure = (command: string, errorValue: unknown) => {
		if (watchFailureReported) return;
		watchFailureReported = true;
		shutdownState.requested = true;
		output(error(undefined, command, errorValue instanceof Error ? errorValue.message : String(errorValue)));
		void requestFatalWatchShutdown?.();
	};
	const eventPersistence = new WeakMap<AgentSessionEvent, Promise<void>>();
	session.registerMessagePersistenceBarrier(event => eventPersistence.get(event) ?? Promise.resolve());
	session.subscribe(event => {
		if (harnessOwner && event.type === "message_end") {
			episodeFinalMessage = providerSafeAssistantText(event) ?? episodeFinalMessage;
			const usage = sessionMessageUsage(event.message);
			if (usage) addRpcUsage(episodeUsage, usage);
		}
		const persistence = streamRpcSessionEvent(event, {
			ledger: () => harnessOwner,
			output,
			sealResult: completeRpcResult,
			waitForMessagePersistence: message => waitForRpcMessageDurability(session, message),
			trackSteeringPersistence: task => {
				terminalTasks.track(task);
			},
			onLedgerFailure: reportLedgerFailure,
		});
		if (persistence) eventPersistence.set(event, persistence);
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommandsUpdate();
	};
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;
		const handoffCompaction = (): boolean =>
			session.settings.get("compaction.strategy") === "handoff" && session.autoCompactionEnabled;

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				harnessOwner?.assertAcceptingWork();
				if (harnessOwner && isRpcCustodyRestrictedPrompt(command.message)) {
					const name = parseSlashCommand(command.message)?.name;
					return name === "compact"
						? error(id, "prompt", "Use the compact RPC command after durable RPC custody is bound")
						: error(id, "prompt", "Session changes are unavailable after durable RPC custody is bound");
				}
				const skillTask = tryRunRpcSkillCommand(session, command.message, command.streamingBehavior);
				if (harnessOwner) terminalTasks.track(skillTask);
				const skillResult = await skillTask;
				if (skillResult) {
					return success(id, "prompt", skillResult);
				}
				const builtinTask = executeAcpBuiltinSlashCommand(command.message, {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					output: text => output({ type: "command_output", text }),
					refreshCommands: emitAvailableCommandsUpdate,
					reloadPlugins: reloadPluginState,
					notifyTitleChanged: async () => {
						output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
					},
					notifyConfigChanged: async () => {
						output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
					},
				});
				const builtinResult = await (harnessOwner ? terminalTasks.track(builtinTask) : builtinTask);
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: () =>
								startRpcResidualPrompt(harnessOwner, () =>
									session.prompt(builtinResult.prompt, { images: command.images }),
								),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
							trackPrompt: task => terminalTasks.track(task),
						});
						return success(id, "prompt");
					}
					return success(id, "prompt", { agentInvoked: false });
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: () =>
						session.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
						}),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
					trackPrompt: task => terminalTasks.track(task),
				});
				return success(id, "prompt");
			}
			case "session.start": {
				if (
					hasActiveRpcSessionWork(
						session,
						shutdownCoordinator.hasTrackedTasks,
						extensionUserMessageTracker.hasActivePrompts,
						extensionUserMessageTracker.hasPendingAgentMessageTasks,
					) &&
					!harnessOwner?.isBoundToRun(command.run_id)
				) {
					return error(id, "session.start", "Durable RPC custody must be bound before active session work");
				}
				if (handoffCompaction()) {
					return error(
						id,
						"session.start",
						"Disable automatic handoff compaction before binding durable RPC custody",
					);
				}
				const { binding } = await bindHarness(command.run_id);
				return success(id, "session.start", {
					run_id: binding.runId,
					session_id: binding.sessionId,
					existing: binding.existing,
				});
			}

			case "session.resume": {
				if (
					hasActiveRpcSessionWork(
						session,
						shutdownCoordinator.hasTrackedTasks,
						extensionUserMessageTracker.hasActivePrompts,
						extensionUserMessageTracker.hasPendingAgentMessageTasks,
					) &&
					!harnessOwner?.isBoundToRun(command.run_id)
				) {
					return error(id, "session.resume", "Durable RPC custody must be bound before active session work");
				}
				if (handoffCompaction()) {
					return error(
						id,
						"session.resume",
						"Disable automatic handoff compaction before binding durable RPC custody",
					);
				}
				if (command.session_id !== undefined && command.session_id !== session.sessionId) {
					return error(id, "session.resume", `Unknown session_id: ${command.session_id}`);
				}
				const { owner, binding } = await bindHarness(command.run_id);
				const events = await owner.replay(command.after_sequence);
				for (const event of events) output(event);
				return success(id, "session.resume", {
					run_id: binding.runId,
					session_id: binding.sessionId,
					existing: binding.existing,
				});
			}

			case "session.replay":
			case "session.watch": {
				if (!harnessOwner) return error(id, command.type, UNBOUND_RUN_ERROR);
				const limit = command.limit ?? 1_000;
				const events = await harnessOwner.replay(command.after_sequence, limit);
				const nextSequence = events.at(-1)?.sequence ?? command.after_sequence ?? 0;
				return success(id, command.type, {
					events,
					next_sequence: nextSequence,
					has_more: harnessOwner.latestSequence > nextSequence,
				});
			}

			case "session.result": {
				if (!harnessOwner) return error(id, "session.result", UNBOUND_RUN_ERROR);
				const result = await harnessOwner.waitResult();
				return success(id, "session.result", result);
			}

			case "session.steer": {
				if (!harnessOwner) return error(id, "session.steer", UNBOUND_RUN_ERROR);
				harnessOwner.assertAcceptingWork();
				const idempotencyKey = `rpc:${session.sessionId}:${command.steering_id}`;
				const persistedMessage = session.findPersistedUserMessageByIdempotencyKey(idempotencyKey);
				const ack = await terminalTasks.track(
					harnessOwner.steer(
						command.steering_id,
						command.message,
						() =>
							deliverRpcSteeringIfNeeded(persistedMessage !== undefined, () =>
								session.steerWithResult(command.message, command.images, {
									idempotencyKey,
								}),
							),
						rpcSteeringPayloadIdentity(command.message, command.images),
					),
				);
				if (persistedMessage) {
					await waitForRpcMessageDurability(session, persistedMessage);
					await harnessOwner.markSteeringInjected(command.steering_id);
				}
				return success(id, "session.steer", ack);
			}

			case "steer": {
				harnessOwner?.assertAcceptingWork();
				await terminalTasks.track(session.steer(command.message, command.images));
				return success(id, "steer");
			}

			case "follow_up": {
				harnessOwner?.assertAcceptingWork();
				await terminalTasks.track(session.followUp(command.message, command.images));
				return success(id, "follow_up");
			}

			case "abort": {
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				if (harnessOwner) {
					return error(
						id,
						"abort_and_prompt",
						"abort_and_prompt is unavailable after durable RPC custody is bound",
					);
				}
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch": {
				if (harnessOwner)
					return error(id, command.type, "Session changes are unavailable after durable RPC custody is bound");
				const result = await handleRpcSessionChange(session, command, subagentRegistry);
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
				};
				return success(id, "get_state", state);
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				let models = session.getAvailableModels();
				let model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					// Model not in the current catalog. Wait for in-flight
					// background discovery before declaring it missing: on cold
					// start, discovery-backed providers (proxy / ollama / etc.)
					// populate seconds after session ready. Models already in
					// the bundled catalog skip this await entirely so the RPC
					// queue is not stalled behind unrelated discovery.
					await session.modelRegistry.awaitBackgroundRefresh();
					models = session.getAvailableModels();
					model = models.find(m => m.provider === command.provider && m.id === command.modelId);
				}
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				harnessOwner?.assertAcceptingWork();
				if (harnessOwner && session.settings.get("compaction.strategy") === "handoff") {
					return error(id, "compact", "Handoff compaction is unavailable after durable RPC custody is bound");
				}
				const result = await compactRpcSession(
					session.isStreaming,
					() => session.compact(command.customInstructions),
					harnessOwner ? completeRpcResult : undefined,
				);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				if (harnessOwner && command.enabled && session.settings.get("compaction.strategy") === "handoff") {
					return error(
						id,
						"set_auto_compaction",
						"Automatic handoff compaction is unavailable after durable RPC custody is bound",
					);
				}
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				bindingGuard.assertWorkAllowed();
				harnessOwner?.assertAcceptingWork();
				const bashTask = session.executeBash(command.command);
				if (harnessOwner) terminalTasks.track(bashTask);
				const result = await bashTask;
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "handoff": {
				if (harnessOwner) {
					return error(id, "handoff", "Handoff is unavailable after durable RPC custody is bound");
				}
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.hasAuth(provider.id),
				}));
				return success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			default: {
				const unknownCommand = command as { type: string };
				return error(undefined, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched bash still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		prepareShutdown: async () => {
			if (shouldForceLedgerSeal(harnessOwner)) {
				await sealLedgerOnExit("shutdown_requested", rpcForcedExitOutcome(session, terminalTasks));
			}
		},
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			// Ledger sealing runs before the task drain so session.result waiters
			// resolve before shutdown waits for their response frames.
			await disposeRpcSessionWithCustody(session, harnessOwner);
			await stdoutQueue;
			process.exit(0);
		},
	});
	requestFatalWatchShutdown = () => shutdownCoordinator.checkShutdownRequested();
	if (shutdownState.requested) void requestFatalWatchShutdown();

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
		// `compact` waits on a provider summary that can stall without limit, and
		// it runs in the serial tail rather than in the background, so nothing but
		// an abort settles it. Everything else here either answers as soon as its
		// turn starts or is background-dispatched.
		isLongRunningSerialCommand: command => command.type === "compact",
		abortSerialCommand: () => session.abortCompaction(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordinary commands serialize through inputDispatcher, and bash remains
	// background-dispatched so abort_bash can overtake it. Frames are read
	// line-by-line by readRpcInputFrames so a single malformed line is reported
	// as an error frame and the loop keeps running instead of throwing out of
	// the reader and killing the whole process (issue #5194).
	await readRpcInputFrames(
		input ?? Bun.stdin.stream(),
		parsed => inputDispatcher.dispatch(parsed),
		message => output(error(undefined, "parse", message)),
	);

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	// Only the serial tail is drained before sealing: a `session.result`
	// requested before terminal state waits on the seal this path still owes it,
	// so those waits are drained afterwards together with background tasks.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	// Abort started serial work that only an abort can settle, before the drain
	// below waits on it. `session.dispose()` aborts the same work, but it runs
	// after this drain and the seal, so leaving it to disposal means a stalled
	// `compact` holds the drain open forever and the ledger never seals.
	inputDispatcher.closeForExit();
	await finalizeRpcInputAfterEof(
		() => inputDispatcher.drain(),
		() => sealLedgerOnExit("stdin_closed", rpcForcedExitOutcome(session, terminalTasks)),
		async () => {
			await inputDispatcher.drainResultWaits();
			await shutdownCoordinator.drain();
		},
	);
	subagentRegistry?.dispose();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately. Durable custody remains held through the complete teardown.
	await disposeRpcSessionWithCustody(session, harnessOwner);
	await stdoutQueue;
	process.exit(0);
}

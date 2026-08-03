import { describe, expect, expectTypeOf, test } from "bun:test";
import {
	compactRpcSession,
	completeRpcResultAfterTranscriptFlush,
	deliverRpcSteeringIfNeeded,
	drainRpcTerminalBoundary,
	hasActiveRpcSessionWork,
	hasPendingRpcContinuation,
	isRpcCustodyRestrictedPrompt,
	materializeRpcCustodyTranscript,
	prepareRpcResultSeal,
	RpcCustodyBindingGuard,
	RpcExtensionUserMessageTracker,
	RpcTerminalTaskTracker,
	reportLocalOnlyPromptResult,
	retryRpcResultSealAfterAdvisorSettlement,
	reuseRpcHarnessBinding,
	rpcExitOutcome,
	rpcForcedExitOutcome,
	rpcResultSealAcceptance,
	startRpcResidualPrompt,
	waitForRpcMessageDurability,
	watchAndReportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "../src/extensibility/extensions/types";
import type { RpcSessionEventListener } from "../src/modes/rpc/rpc-client";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession } from "../src/session/agent-session";

async function waitForPromptHandlers(prompt: Promise<unknown>): Promise<void> {
	await prompt.catch(() => undefined);
	await Promise.resolve();
}

async function waitForTrackedPromptHandlers(trackedPrompt: {
	prompt: Promise<unknown>;
	waitForAgentMessageTasks: () => Promise<void>;
}): Promise<void> {
	await trackedPrompt.prompt.catch(() => undefined);
	await trackedPrompt.waitForAgentMessageTasks();
	await Promise.resolve();
	await Promise.resolve();
}

describe("RPC durable custody prompts", () => {
	test("treats pending asynchronous delivery as active pre-custody work", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => true,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
			hasPendingExtensionEvents: false,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("treats hidden queued messages as active pre-custody work", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: true,
			hasPendingExtensionEvents: false,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("treats an unfinished extension lifecycle handler as active pre-custody work", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
			hasPendingExtensionEvents: true,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("rejects custody steering when delivery is cancelled before queueing", async () => {
		await expect(deliverRpcSteeringIfNeeded(false, async () => false)).rejects.toThrow(
			"cancelled before the message was queued",
		);
	});

	test("materializes the transcript before durable custody opens its sidecar", async () => {
		let materialized = false;
		const session = {
			sessionFile: "/tmp/session.jsonl",
			sessionManager: {
				async ensureOnDisk() {
					materialized = true;
				},
			},
		};

		await expect(materializeRpcCustodyTranscript(session)).resolves.toBe("/tmp/session.jsonl");
		expect(materialized).toBe(true);
	});

	test("surfaces a latched transcript failure before steering is marked durable", async () => {
		const order: string[] = [];
		const failure = new Error("disk full");
		const session = {
			waitForMessagePersistence: async () => {
				order.push("message");
			},
			sessionManager: {
				flush: async () => {
					order.push("flush");
					throw failure;
				},
			},
		};

		await expect(waitForRpcMessageDurability(session, {} as never)).rejects.toBe(failure);
		expect(order).toEqual(["message", "flush"]);
	});

	test("flushes the transcript before completing the durable result", async () => {
		const order: string[] = [];
		const failure = new Error("transcript append failed");
		const owner = {
			beginResultSeal: () => order.push("seal"),
			completeResult: async () => {
				order.push("complete");
				return {} as never;
			},
		};
		const result = {
			outcome: "completed" as const,
			stopReason: "stop",
			finalMessage: "done",
			usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		await expect(
			completeRpcResultAfterTranscriptFlush(
				{
					flush: async () => {
						order.push("flush");
						throw failure;
					},
				},
				owner,
				result,
			),
		).rejects.toBe(failure);
		expect(order).toEqual(["seal", "flush"]);
	});

	test("exposes the optional durable sequence to session event listeners", () => {
		expectTypeOf<Parameters<RpcSessionEventListener>[0]["sequence"]>().toEqualTypeOf<number | undefined>();
	});

	test("reuses an idempotent run binding without entering a custody transition", () => {
		const owner = { sessionId: "session-1", isBoundToRun: (runId: string) => runId === "run-1" };

		expect(reuseRpcHarnessBinding(owner as never, "run-1")).toEqual({
			owner,
			binding: { runId: "run-1", sessionId: "session-1", existing: true },
		});
		expect(reuseRpcHarnessBinding(owner as never, "run-2")).toBeUndefined();
	});

	test("recognizes every parsed move command spelling", () => {
		expect(isRpcCustodyRestrictedPrompt("/move /existing/dir")).toBe(true);
		expect(isRpcCustodyRestrictedPrompt("/compact focus on APIs")).toBe(true);
		expect(isRpcCustodyRestrictedPrompt("/move:/existing/dir")).toBe(true);
		expect(isRpcCustodyRestrictedPrompt("/model move")).toBe(false);
	});

	test("blocks session changes throughout durable custody binding", async () => {
		const guard = new RpcCustodyBindingGuard();
		const pending = Promise.withResolvers<void>();
		const binding = guard.run(() => pending.promise);
		await Promise.resolve();

		expect(() => guard.assertSessionChangeAllowed()).toThrow(
			"Session changes are unavailable while durable RPC custody is binding",
		);
		pending.resolve();
		await binding;
		expect(() => guard.assertSessionChangeAllowed()).not.toThrow();
	});

	test("blocks extension command session changes while custody is bound", async () => {
		let commandActions: ExtensionCommandContextActions | undefined;
		let sessionChanges = 0;
		const session = {
			extensionRunner: {
				initialize: (_actions: ExtensionActions, _context: unknown, actions: ExtensionCommandContextActions) => {
					commandActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			agent: { waitForIdle: async () => {} },
			newSession: async () => {
				sessionChanges++;
				return true;
			},
			branch: async () => {
				sessionChanges++;
				return { cancelled: false };
			},
			switchSession: async () => {
				sessionChanges++;
				return true;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			assertSessionChangeAllowed: () => {
				throw new Error("custody bound");
			},
		});

		await expect(commandActions!.newSession()).rejects.toThrow("custody bound");
		await expect(commandActions!.branch("entry-id")).rejects.toThrow("custody bound");
		await expect(commandActions!.switchSession("other.jsonl")).rejects.toThrow("custody bound");
		expect(sessionChanges).toBe(0);
	});

	test("marks exits with unfinished RPC work aborted", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => true,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
		};
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.hasPendingAsyncWork = () => false;
		session.hasPendingBashMessages = true;
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.hasPendingBashMessages = false;
		session.hasQueuedAgentMessages = true;
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.hasQueuedAgentMessages = false;
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("completed");
	});
	test("marks a forced exit aborted while an accepted terminal task is running", () => {
		const pending = Promise.withResolvers<void>();
		const terminalTasks = new RpcTerminalTaskTracker();
		terminalTasks.track(pending.promise);
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
			hasPendingExtensionEvents: false,
		};

		expect(rpcForcedExitOutcome(session, terminalTasks)).toBe("aborted");
		pending.resolve();
	});

	test("marks a forced exit aborted while an extension handler is running", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: false,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
			hasPendingExtensionEvents: true,
		};

		expect(rpcForcedExitOutcome(session, { hasPendingTasks: false })).toBe("aborted");
	});

	test("treats an outstanding advisor review as active pre-custody work", () => {
		// `session.start` binds through this predicate. An advisor still reviewing
		// the pre-custody turn would otherwise have its output bound into the new
		// run as if the run had produced it.
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: true,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
			hasPendingExtensionEvents: false,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("refuses to seal while an advisor review is still outstanding", () => {
		// Every primary-facing signal reads idle here: advisors review out of band.
		// A late concern persists a card after the terminal result, and a late
		// blocker resumes the primary through a trigger turn outside the ledger.
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAdvisorReviews: true,
			hasPendingAsyncWork: () => false,
			hasPendingBashMessages: false,
			hasQueuedAgentMessages: false,
		};

		expect(hasPendingRpcContinuation(session)).toBe(true);
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.hasPendingAdvisorReviews = false;
		expect(hasPendingRpcContinuation(session)).toBe(false);
	});

	test("drains an advisor review inside the terminal boundary", async () => {
		let pendingAdvisor = true;
		let cardPersisted = false;
		let drains = 0;

		await drainRpcTerminalBoundary(
			{
				hasPendingBashMessages: false,
				flushPendingBashMessages: async () => {},
				hasPendingExtensionEvents: false,
				waitForPendingExtensionEvents: async () => {},
				get hasPendingAdvisorReviews() {
					return pendingAdvisor;
				},
				waitForPendingAdvisorReviews: async () => {
					drains++;
					// The review lands and its card persists — inside the boundary,
					// which is the whole point of draining here rather than after.
					cardPersisted = true;
					pendingAdvisor = false;
				},
			},
			new RpcTerminalTaskTracker(),
			new RpcExtensionUserMessageTracker(),
		);

		expect(drains).toBe(1);
		expect(cardPersisted).toBe(true);
		expect(pendingAdvisor).toBe(false);
	});

	test("gives up on a stalled advisor instead of spinning the terminal boundary", async () => {
		// The advisor drain is bounded, so an advisor that never catches up leaves
		// the flag set. The boundary must exit anyway — the leftover is reported by
		// the continuation predicate, which refuses the seal.
		let drains = 0;

		await drainRpcTerminalBoundary(
			{
				hasPendingBashMessages: false,
				flushPendingBashMessages: async () => {},
				hasPendingExtensionEvents: false,
				waitForPendingExtensionEvents: async () => {},
				hasPendingAdvisorReviews: true,
				waitForPendingAdvisorReviews: async () => {
					drains++;
				},
			},
			new RpcTerminalTaskTracker(),
			new RpcExtensionUserMessageTracker(),
		);

		expect(drains).toBe(1);
	});
	test("retries a refused seal when a silent advisor review settles", () => {
		let settlementListener: (() => void) | undefined;
		let unsubscribeCalls = 0;
		let retryCalls = 0;
		const cancel = retryRpcResultSealAfterAdvisorSettlement(
			{
				onAdvisorReviewsSettled(listener) {
					settlementListener = listener;
					return () => {
						unsubscribeCalls++;
					};
				},
			},
			() => {
				retryCalls++;
			},
		);

		settlementListener?.();
		settlementListener?.();
		cancel();

		expect(retryCalls).toBe(1);
		expect(unsubscribeCalls).toBe(1);
	});
	test("flushes deferred bash results before opening the terminal boundary", async () => {
		let pendingBash = true;
		let flushes = 0;
		await drainRpcTerminalBoundary(
			{
				get hasPendingBashMessages() {
					return pendingBash;
				},
				hasPendingExtensionEvents: false,
				async waitForPendingExtensionEvents() {},
				async flushPendingBashMessages() {
					flushes++;
					pendingBash = false;
				},
				hasPendingAdvisorReviews: false,
				waitForPendingAdvisorReviews: async () => {},
			},
			new RpcTerminalTaskTracker(),
			new RpcExtensionUserMessageTracker(),
		);

		expect(flushes).toBe(1);
		expect(pendingBash).toBe(false);
	});

	test("waits for agent-end extension handlers before draining their continuation", async () => {
		let pendingExtension = true;
		let continuationFinished = false;
		const extensionGate = Promise.withResolvers<void>();
		const terminalTasks = new RpcTerminalTaskTracker();
		const extensionTasks = new RpcExtensionUserMessageTracker();
		const extensionEvent = extensionGate.promise.then(async () => {
			pendingExtension = false;
			await extensionTasks.trackAgentMessageTask(Promise.resolve().then(() => (continuationFinished = true)));
		});

		await Promise.all([
			drainRpcTerminalBoundary(
				{
					hasPendingBashMessages: false,
					flushPendingBashMessages: async () => {},
					get hasPendingExtensionEvents() {
						return pendingExtension;
					},
					waitForPendingExtensionEvents: async () => extensionEvent,
					hasPendingAdvisorReviews: false,
					waitForPendingAdvisorReviews: async () => {},
				},
				terminalTasks,
				extensionTasks,
			),
			Promise.resolve().then(() => extensionGate.resolve()),
		]);

		expect(continuationFinished).toBe(true);
	});

	test("skips terminal-task draining while forcing an aborted exit result", async () => {
		let drainCalls = 0;
		expect(
			await prepareRpcResultSeal(
				true,
				async () => {
					drainCalls++;
				},
				() => true,
			),
		).toBe(true);
		expect(drainCalls).toBe(0);
	});

	test("takes the terminal decision with acceptance already closed", async () => {
		// The window this closes: the old order checked for a continuation, then
		// yielded, then sealed. Anything the custody gate admitted in that gap ran
		// on under a terminal result. The check must never be consulted while the
		// gate is still open, and the gate must stay closed through the seal.
		const openAtCheck: boolean[] = [];
		let accepting = true;

		const sealed = await prepareRpcResultSeal(
			false,
			async () => {},
			() => {
				openAtCheck.push(accepting);
				return false;
			},
			{
				close: () => {
					accepting = false;
				},
				reopen: () => {
					accepting = true;
				},
			},
		);

		expect(sealed).toBe(true);
		expect(openAtCheck).toEqual([false]);
		expect(accepting).toBe(false);
	});

	test("cancels the seal and re-arms parked wakes when work is admitted during the boundary drain", async () => {
		// A yield-queue idle flush wakes while the boundary is still draining.
		// Acceptance is legitimately open there, so the work is admitted — and the
		// attempt must then abandon rather than seal over it.
		const events: string[] = [];
		let accepting = true;
		let pendingContinuation = false;
		let drains = 0;

		const sealed = await prepareRpcResultSeal(
			false,
			async () => {
				drains++;
				if (drains === 1 && accepting) {
					pendingContinuation = true;
					events.push("admitted");
				}
			},
			() => pendingContinuation,
			{
				close: () => {
					accepting = false;
					events.push("closed");
				},
				reopen: () => {
					accepting = true;
					events.push("reopened");
				},
			},
		);

		expect(sealed).toBe(false);
		// The second drain is what gives work admitted during the first one a
		// boundary to reach before the check decides.
		expect(drains).toBe(2);
		expect(events).toEqual(["admitted", "closed", "reopened"]);
		expect(accepting).toBe(true);
	});

	test("abandoning a seal reopens custody and re-arms the idle flush it parked", () => {
		// Reopening alone is silent: the gate stops refusing, but nothing
		// re-evaluates the wakes it already parked, so a missing re-arm strands
		// them until disposal with no error and no log. Assert the pairing.
		const calls: string[] = [];
		const acceptance = rpcResultSealAcceptance(
			{
				beginResultSeal: () => calls.push("beginResultSeal"),
				cancelResultSeal: () => calls.push("cancelResultSeal"),
			},
			() => calls.push("requestIdleFlush"),
		);

		acceptance.close();
		acceptance.reopen();

		expect(calls).toEqual(["beginResultSeal", "cancelResultSeal", "requestIdleFlush"]);
	});
	test("rechecks custody before starting an ACP residual prompt", () => {
		let started = false;
		expect(() =>
			startRpcResidualPrompt(
				{
					assertAcceptingWork() {
						throw new Error("run already sealed");
					},
				},
				() => {
					started = true;
				},
			),
		).toThrow("run already sealed");
		expect(started).toBe(false);
	});

	test("seals a streaming episode after manual compaction aborts it", async () => {
		const seals: Array<[string, string]> = [];
		const compact = async () => ({ summary: "compacted" });

		const result = await compactRpcSession(true, compact, async (stopReason, outcome) => {
			seals.push([stopReason, outcome]);
		});

		expect(result).toEqual({ summary: "compacted" });
		expect(seals).toEqual([["aborted", "aborted"]]);
	});
});

describe("reportLocalOnlyPromptResult", () => {
	test("emits prompt_result when prompt resolves without invoking the agent or extension user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("keeps prompt preflight active until the prompt promise settles", async () => {
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const preflight = Promise.withResolvers<boolean>();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => preflight.promise);

		expect(extensionUserMessages.hasActivePrompts).toBe(true);

		preflight.resolve(false);
		await trackedPrompt.prompt;
		expect(extensionUserMessages.hasActivePrompts).toBe(false);
	});

	test("keeps extension message preparation pending after the outer prompt resolves", async () => {
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const messagePreparation = Promise.withResolvers<void>();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.trackAgentMessageTask(messagePreparation.promise);
			return Promise.resolve(false);
		});

		await trackedPrompt.prompt;
		expect(extensionUserMessages.hasPendingAgentMessageTasks).toBe(true);

		messagePreparation.resolve();
		await messagePreparation.promise;
		await Promise.resolve();
		expect(extensionUserMessages.hasPendingAgentMessageTasks).toBe(false);
	});

	test("waits for all extension message preparation to settle", async () => {
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const messagePreparation = Promise.withResolvers<void>();
		extensionUserMessages.trackAgentMessageTask(messagePreparation.promise);
		let settled = false;
		const terminal = extensionUserMessages.waitForPendingAgentMessageTasks().then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);
		messagePreparation.resolve();
		await terminal;
		expect(settled).toBe(true);
	});

	test("does not emit false prompt_result when an extension command schedules a user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("does not emit false prompt_result when an extension command schedules a triggerTurn custom message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.markAgentMessageTask();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("marks triggerTurn extension custom messages as agent work", async () => {
		let extensionActions: ExtensionActions | undefined;
		let markCount = 0;
		let sentOptions: { triggerTurn?: boolean } | undefined;
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async (_message: unknown, options?: { triggerTurn?: boolean }) => {
				sentOptions = options;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			markAgentInvokingMessage: () => {
				markCount += 1;
			},
		});
		extensionActions?.sendMessage(
			{
				customType: "test",
				content: "context",
				display: true,
				details: "context",
				attribution: "user",
			},
			{ triggerTurn: true },
		);

		expect(markCount).toBe(1);
		expect(sentOptions).toEqual({ triggerTurn: true });
	});

	test("rejects extension-triggered work after durable custody seals", async () => {
		let extensionActions: ExtensionActions | undefined;
		let contextActions: ExtensionContextActions | undefined;
		let commandActions: ExtensionCommandContextActions | undefined;
		let sends = 0;
		const session = {
			extensionRunner: {
				initialize: (
					actions: ExtensionActions,
					context: ExtensionContextActions,
					commands: ExtensionCommandContextActions,
				) => {
					extensionActions = actions;
					contextActions = context;
					commandActions = commands;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async () => {
				sends++;
			},
			sendUserMessage: async () => {
				sends++;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			assertAgentWorkAllowed: () => {
				throw new Error("run already sealed");
			},
		});
		const actions = extensionActions;
		if (!actions) throw new Error("extensions not initialized");
		const context = contextActions;
		const commands = commandActions;
		if (!context || !commands) throw new Error("extension contexts not initialized");
		const message = {
			customType: "test",
			content: "context",
			display: true,
			details: "context",
			attribution: "user" as const,
		};

		expect(() => actions.sendUserMessage("late work")).toThrow("run already sealed");
		expect(() => actions.sendMessage(message, { triggerTurn: true })).toThrow("run already sealed");
		expect(() => context.compact()).toThrow("run already sealed");
		expect(() => commands.compact()).toThrow("run already sealed");
		expect(sends).toBe(0);
	});

	test("routes both extension compaction contexts through the mode boundary", async () => {
		let contextActions: ExtensionContextActions | undefined;
		let commandActions: ExtensionCommandContextActions | undefined;
		const calls: unknown[] = [];
		const session = {
			extensionRunner: {
				initialize: (
					_actions: ExtensionActions,
					context: ExtensionContextActions,
					commands: ExtensionCommandContextActions,
				) => {
					contextActions = context;
					commandActions = commands;
				},
				onError: () => {},
				emit: async () => {},
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			runCompact: async options => {
				calls.push(options);
			},
		});

		await contextActions!.compact("context");
		await commandActions!.compact({ mode: "soft" });
		expect(calls).toEqual(["context", { mode: "soft" }]);
	});

	test("suppresses prompt_result when extension sendUserMessage succeeds", async () => {
		let extensionActions: ExtensionActions | undefined;
		let sentContent: unknown;
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async (content: unknown) => {
				sentContent = content;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_success",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(sentContent).toBe("start work");
		expect(output).toEqual([]);
	});

	test("emits prompt_result when extension sendUserMessage rejects", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const reportedErrors: Error[] = [];
		const thrown = new Error("missing model");
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async () => {
				throw thrown;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				reportedErrors.push(error);
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_rejected",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
			waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
		});
		await waitForTrackedPromptHandlers(trackedPrompt);

		expect(reportedErrors).toEqual([thrown]);
		expect(output).toEqual([{ type: "prompt_result", id: "req_rejected", agentInvoked: false }]);
	});

	test("does not emit when prompt invokes the agent", async () => {
		const output: object[] = [];
		const prompt = Promise.resolve(true);

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});

	test("reports prompt rejection without emitting output", async () => {
		const output: object[] = [];
		const thrown = new Error("boom");
		const prompt = Promise.reject(thrown);
		let reported: Error | undefined;

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				reported = error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(reported).toBe(thrown);
		expect(output).toEqual([]);
	});
});

describe("watchAndReportLocalOnlyPromptResult", () => {
	test("reports builtin residual prompts that complete locally", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(false);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("registers prompt preflight with the terminal task boundary", async () => {
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const prompt = Promise.withResolvers<boolean>();
		let tracked: Promise<boolean> | undefined;

		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt.promise,
			output: () => {},
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
			trackPrompt: task => {
				tracked = task;
				return task;
			},
		});

		expect(tracked).toBeDefined();
		prompt.resolve(true);
		await tracked;
	});

	test("does not report builtin residual prompts that invoke the agent", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(true);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([]);
	});
});

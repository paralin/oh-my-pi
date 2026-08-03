import { describe, expect, test } from "bun:test";
import {
	compactRpcSession,
	hasActiveRpcSessionWork,
	hasPendingRpcContinuation,
	isRpcCustodyRestrictedPrompt,
	RpcCustodyBindingGuard,
	RpcExtensionUserMessageTracker,
	reportLocalOnlyPromptResult,
	rpcExitOutcome,
	watchAndReportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type {
	ExtensionActions,
	ExtensionCommandContextActions,
	ExtensionContextActions,
} from "../src/extensibility/extensions/types";
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
			hasPendingAsyncWork: () => true,
			queuedMessageCount: 0,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("treats queued messages as active pre-custody work", () => {
		const session = {
			isStreaming: false,
			isCompacting: false,
			hasPendingAsyncWork: () => false,
			queuedMessageCount: 1,
		};

		expect(hasActiveRpcSessionWork(session, false, false, false)).toBe(true);
	});

	test("recognizes every parsed move command spelling", () => {
		expect(isRpcCustodyRestrictedPrompt("/move /existing/dir")).toBe(true);
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
			hasPendingAsyncWork: () => true,
			queuedMessageCount: 0,
		};
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.hasPendingAsyncWork = () => false;
		session.queuedMessageCount = 1;
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("aborted");
		session.queuedMessageCount = 0;
		expect(rpcExitOutcome(hasPendingRpcContinuation(session))).toBe("completed");
	});

	test("seals a streaming episode after manual compaction aborts it", async () => {
		const seals: Array<[string, string]> = [];
		const session = {
			isStreaming: true,
			compact: async () => {
				session.isStreaming = false;
				return { summary: "compacted" };
			},
		};

		const result = await compactRpcSession(session, undefined, async (stopReason, outcome) => {
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

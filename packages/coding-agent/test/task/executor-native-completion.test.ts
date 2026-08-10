import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMockSession(options: {
	responses: string[];
	onSettle?: (state: { messages: AssistantMessage[] }) => void;
	pending?: boolean;
}): { session: AgentSession; prompts: string[]; settled: () => number } {
	const listeners: Array<(event: never) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const prompts: string[] = [];
	let pending = options.pending ?? false;
	let settleCount = 0;
	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		subscribe: (listener: (event: never) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async (text: string, _promptOptions?: PromptOptions) => {
			prompts.push(text);
			const response = options.responses[prompts.length - 1];
			if (response !== undefined) state.messages.push(assistant(response));
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		hasPendingAsyncWork: () => pending,
		settleAsyncWork: async () => {
			settleCount += 1;
			pending = false;
			options.onSettle?.(state);
		},
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
	} as unknown as AgentSession;
	return { session, prompts, settled: () => settleCount };
}

function mockCreateAgentSession(session: AgentSession) {
	const result: CreateAgentSessionResult = {
		session,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(result);
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};
const baseOptions = {
	cwd: "/tmp",
	agent: baseAgent,
	task: "do work",
	index: 0,
	id: "native-completion",
	settings: Settings.isolated(),
	modelRegistry: {
		refresh: async () => {},
	} as unknown as import("@oh-my-pi/pi-coding-agent/config/model-registry").ModelRegistry,
	enableLsp: false,
};

describe("runSubprocess native completion", () => {
	afterEach(() => vi.restoreAllMocks());

	it("accepts an unstructured terminal assistant response after one prompt", async () => {
		const mock = createMockSession({ responses: ["completed once"] });
		mockCreateAgentSession(mock.session);

		const result = await runSubprocess(baseOptions);

		expect(mock.prompts).toEqual(["do work"]);
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("completed once");
		expect(result.error).toBeUndefined();
	});

	it("validates structured JSON from the terminal assistant response after one prompt", async () => {
		const mock = createMockSession({ responses: ['{"ok":true}'] });
		mockCreateAgentSession(mock.session);

		const result = await runSubprocess({
			...baseOptions,
			id: "native-structured-completion",
			outputSchema: { properties: { ok: { type: "boolean" } } },
		});

		expect(mock.prompts).toEqual(["do work"]);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.output)).toEqual({ ok: true });
		expect(result.structuredOutput?.status).toBe("valid");
	});

	it("settles owner async work before accepting the latest assistant response", async () => {
		const mock = createMockSession({
			responses: ["initial response"],
			pending: true,
			onSettle: state => state.messages.push(assistant("response after async result")),
		});
		mockCreateAgentSession(mock.session);

		const result = await runSubprocess({ ...baseOptions, id: "native-async-settlement" });

		expect(mock.prompts).toHaveLength(1);
		expect(mock.settled()).toBe(1);
		expect(result.output).toBe("response after async result");
	});
});

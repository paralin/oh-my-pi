import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { formatResultOutputFallback } from "@oh-my-pi/pi-coding-agent/task";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

describe("runSubprocess terminal response and salvage", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns a native terminal assistant response without a yield tool call", async () => {
		const terminal = {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "completed native response" }],
		};
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			subscribe: () => () => {},
			prompt: async () => true,
			waitForIdle: async () => {},
			getLastAssistantMessage: () => terminal,
			abort: async () => {},
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "terminal-response",
			enableLsp: false,
		});
		expect(result).toMatchObject({ aborted: false, exitCode: 0, output: "completed native response" });
	});

	it("preserves last assistant text after a runtime abort", async () => {
		const gate = Promise.withResolvers<void>();
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			subscribe: () => () => {},
			prompt: async () => gate.promise,
			waitForIdle: async () => gate.promise,
			getLastAssistantMessage: () => ({
				role: "assistant",
				stopReason: "aborted",
				content: [{ type: "text", text: "Reading   the\nconfig loader" }],
			}),
			abort: async () => gate.resolve(),
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
		} as unknown as AgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session,
			extensionsResult: {} as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "salvage",
			enableLsp: false,
			settings: Settings.isolated({ "task.maxRuntimeMs": 20 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		});
		expect(result).toMatchObject({
			aborted: true,
			exitCode: 1,
			output: "Reading   the\nconfig loader",
		});
	});

	it("formats the empty-output fallback with request count", () => {
		expect(formatResultOutputFallback({ output: "", stderr: "", requests: 7 })).toBe("(no output) after 7 req");
	});
});

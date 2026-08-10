import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function mockSession(session: AgentSession) {
	return vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
		session,
		extensionsResult: {} as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	} satisfies CreateAgentSessionResult);
}

describe("runSubprocess runtime limit", () => {
	afterEach(() => vi.restoreAllMocks());

	it("aborts a stalled native response with the runtime-limit reason", async () => {
		const stalled = Promise.withResolvers<void>();
		let aborts = 0;
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			subscribe: () => () => {},
			prompt: async () => stalled.promise,
			waitForIdle: async () => stalled.promise,
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				aborts += 1;
				stalled.resolve();
			},
			dispose: async () => {},
			setIrcWakeTurnObserver: () => {},
		} as unknown as AgentSession;
		mockSession(session);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "runtime-limit",
			settings: Settings.isolated({ "task.maxRuntimeMs": 20 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(aborts).toBeGreaterThanOrEqual(1);
		expect(result).toMatchObject({ aborted: true, exitCode: 1 });
		expect(result.abortReason).toContain("runtime limit exceeded");
	});
});

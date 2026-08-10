import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { resolveSoftRequestBudget, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

describe("runSubprocess soft request budget", () => {
	afterEach(() => vi.restoreAllMocks());

	it("directly aborts a native run at 1.5 times its request budget", async () => {
		const gate = Promise.withResolvers<void>();
		let aborts = 0;
		const session = {
			state: { messages: [] },
			agent: { state: { systemPrompt: ["test"] } },
			extensionRunner: undefined,
			sessionManager: { appendSessionInit: () => {} },
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				queueMicrotask(() => {
					for (let request = 0; request < 3; request++)
						listener({
							type: "message_end",
							message: { role: "assistant", content: [] },
						} as unknown as AgentSessionEvent);
				});
				return () => {};
			},
			prompt: async () => gate.promise,
			waitForIdle: async () => gate.promise,
			getLastAssistantMessage: () => undefined,
			abort: async () => {
				aborts += 1;
				gate.resolve();
			},
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
			id: "budget",
			enableLsp: false,
			settings: Settings.isolated({ "task.softRequestBudget": 2 }),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		});

		expect(aborts).toBeGreaterThanOrEqual(1);
		expect(result).toMatchObject({ aborted: true, exitCode: 1, requests: 3 });
		expect(result.abortReason).toContain("Soft request budget exceeded");
	});

	it("uses the lower configured or bundled request ceiling", () => {
		expect(resolveSoftRequestBudget("scout", 20)).toBe(20);
		expect(resolveSoftRequestBudget("scout", 200)).toBe(100);
		expect(resolveSoftRequestBudget("task", 20)).toBe(20);
	});
});

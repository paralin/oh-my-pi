import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession user shortcut hooks", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-user-shortcut-hooks-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	function createSession(extensionRunner?: ExtensionRunner): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			extensionRunner,
		});
		return session;
	}

	it("invokes user_bash hook and honors replacement result", async () => {
		const replacement = {
			output: "hooked bash output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: 18,
			outputLines: 1,
			outputBytes: 18,
		};
		const emitUserBash = vi.fn().mockResolvedValue({ result: replacement });
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "user_bash"),
			emitUserBash,
		} as unknown as ExtensionRunner;
		const executeBashSpy = vi.spyOn(bashExecutor, "executeBash");

		createSession(extensionRunner);
		const result = await session.executeBash("echo hello", undefined, { excludeFromContext: true });

		expect(emitUserBash).toHaveBeenCalledWith({
			type: "user_bash",
			command: "echo hello",
			excludeFromContext: true,
			cwd: expect.any(String),
		});
		expect(executeBashSpy).not.toHaveBeenCalled();
		expect(result).toEqual(replacement);
		const bashMessage = session.messages.at(-1);
		expect(bashMessage?.role).toBe("bashExecution");
		expect(bashMessage).toMatchObject({
			output: "hooked bash output",
			excludeFromContext: true,
		});
	});
});

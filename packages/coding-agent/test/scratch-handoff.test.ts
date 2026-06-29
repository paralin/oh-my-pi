import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { resolveScratchHandoffPath } from "@oh-my-pi/pi-coding-agent/session/scratch-handoff";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("scratch handoff", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
	});

	async function createTestSession(
		input: { taskDepth?: number; agentId?: string; parentScratch?: string; scratchFile?: string } = {},
	): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		authStorage: AuthStorage;
		cwd: string;
	}> {
		const tempDir = TempDir.createSync("@pi-scratch-handoff-");
		tempDirs.push(tempDir);
		const cwd = tempDir.join("project-root");
		fs.mkdirSync(cwd, { recursive: true });
		const authStorage = await AuthStorage.create(tempDir.join("testauth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(cwd, tempDir.join("sessions"));
		const settings = Settings.isolated({
			"async.enabled": false,
			"scratchHandoff.enabled": true,
			"scratchHandoff.rootDir": "agent",
		});
		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected built-in OpenAI test model");
		const result = await createAgentSession({
			cwd,
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings,
			model,
			taskDepth: input.taskDepth,
			agentId: input.agentId,
			parentScratchHandoffDisplayPath: input.parentScratch,
			scratchHandoffFile: input.scratchFile,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: cwd,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return { session: result.session, sessionManager, authStorage, cwd };
	}

	it("creates the main session scratch file and injects the protocol", async () => {
		const { session, sessionManager, authStorage, cwd } = await createTestSession();
		try {
			const scratch = resolveScratchHandoffPath({
				cwd,
				rootDir: "agent",
				sessionId: sessionManager.getSessionId(),
				agentId: "Main",
			});
			const document = fs.readFileSync(scratch.absolutePath, "utf8");
			expect(document).toContain("* Scratch Handoff");
			expect(document).toContain(`:session: ${sessionManager.getSessionId()}`);
			const promptText = session.systemPrompt.join("\n\n");
			expect(promptText).toContain("Scratch compaction protocol:");
			expect(promptText).toContain(`Existing scratch org file: ${scratch.displayPath}.`);
			const scratchContext = session.agent.state.messages.find(message => {
				return message.role === "custom" && message.customType === "scratch-handoff-read";
			});
			expect(scratchContext?.role).toBe("custom");
			if (scratchContext?.role !== "custom") throw new Error("missing scratch handoff context");
			expect(scratchContext.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("<scratch-handoff-context>") }),
			]);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("assigns in-process subagents their own scratch file linked to the parent", async () => {
		const parentScratch = "agent/20260629/Main-parent.org";
		const { session, sessionManager, authStorage, cwd } = await createTestSession({
			taskDepth: 1,
			agentId: "WorkerOne",
			parentScratch,
		});
		try {
			const scratch = resolveScratchHandoffPath({
				cwd,
				rootDir: "agent",
				sessionId: sessionManager.getSessionId(),
				agentId: "WorkerOne",
			});
			const document = fs.readFileSync(scratch.absolutePath, "utf8");
			expect(document).toContain(`[[file:${parentScratch}][Parent scratch handoff]]`);
			const promptText = session.systemPrompt.join("\n\n");
			expect(promptText).toContain("Scratch compaction protocol:");
			expect(promptText).toContain(`Parent scratch org file: ${parentScratch}.`);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("uses an explicit scratch handoff file when one is provided", async () => {
		const scratchFile = "handoffs/current.org";
		const { session, authStorage, cwd } = await createTestSession({ scratchFile });
		try {
			const scratch = resolveScratchHandoffPath({
				cwd,
				rootDir: "agent",
				sessionId: "ignored",
				agentId: "Main",
				scratchFile,
			});
			expect(fs.existsSync(scratch.absolutePath)).toBe(true);
			expect(session.getScratchHandoffDisplayPath()).toBe(scratchFile);
			expect(session.systemPrompt.join("\n\n")).toContain(`Existing scratch org file: ${scratchFile}.`);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});
});

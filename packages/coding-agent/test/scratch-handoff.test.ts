import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveScratchHandoffPath } from "@oh-my-pi/pi-coding-agent/session/scratch-handoff";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("scratch handoff", () => {
	const tempDirs: TempDir[] = [];

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			await tempDir.remove();
		}
		vi.restoreAllMocks();
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
			expect(document).toContain("#+TITLE: Current agent work");
			expect(document).toContain(`#+SESSION: ${sessionManager.getSessionId()}`);
			expect(document).toContain(`#+PATH: ${scratch.displayPath}`);
			expect(document).toContain("* TODO Current work");
			expect(document).not.toContain("* Scratch Handoff");
			const promptText = session.systemPrompt.join("\n\n");
			expect(promptText).toContain("Scratch continuity protocol:");
			expect(promptText).toContain(`Existing scratch org file: ${scratch.displayPath}.`);
			expect(promptText).toContain("Continue exactly as if no context reset, compaction, or handoff occurred.");
			expect(promptText).toContain("Do not mention, log, summarize, or count scratch loading");
			expect(promptText).toContain("Keep `#+TITLE` as a one-line summary");
			expect(promptText).toContain("Keep scratch metadata in root org keywords");
			expect(promptText).toContain("Keep the current work under an active `* TODO ...` heading");
			expect(promptText).toContain("A child TODO blocks closing its parent heading");
			expect(promptText).toContain("Keep verification as current proof and residual risk");
			expect(promptText).toContain("Do not use the separate todo tool/list for scratch-owned work");
			const scratchContext = session.agent.state.messages.find(message => {
				return message.role === "custom" && message.customType === "scratch-handoff-read";
			});
			expect(scratchContext?.role).toBe("custom");
			if (scratchContext?.role !== "custom") throw new Error("missing scratch handoff context");
			expect(scratchContext.content).toEqual([
				expect.objectContaining({
					text: expect.stringContaining("Resume this session from the scratch handoff below."),
				}),
			]);
			expect(scratchContext.content).toEqual([
				expect.objectContaining({
					text: expect.stringContaining(
						"Reload and continue the skill/command stack recorded in the scratch file",
					),
				}),
			]);
			const scratchText = Array.isArray(scratchContext.content)
				? scratchContext.content.map(block => (block.type === "text" ? block.text : "")).join("\n")
				: scratchContext.content;
			expect(scratchText).not.toContain("Synthetic read");
			expect(scratchText).not.toContain("loaded the scratch handoff file");
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
			expect(promptText).toContain("Scratch continuity protocol:");
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

	it("preserves pre-compaction background task completion in the same session", async () => {
		const { session, authStorage } = await createTestSession();
		const manager = session.asyncJobManager;
		if (!manager) throw new Error("expected top-level session to own an async job manager");
		session.settings.set("compaction.strategy", "handoff");

		const gate = Promise.withResolvers<string>();
		let abortedByHandoff = false;
		const promptedBatches: AgentMessage[][] = [];
		const promptOwner = session.agent as unknown as {
			prompt: (input: AgentMessage | AgentMessage[]) => Promise<void>;
		};
		const originalPrompt = promptOwner.prompt.bind(session.agent);
		promptOwner.prompt = async input => {
			promptedBatches.push(Array.isArray(input) ? input : [input]);
		};

		const jobId = manager.register(
			"task",
			"ContinuityChild",
			async ({ signal }) => {
				const text = await gate.promise;
				if (signal.aborted) {
					abortedByHandoff = true;
					throw new Error("child aborted during scratch handoff");
				}
				return text;
			},
			{ id: "continuity-child-job", ownerId: "Main" },
		);
		const beforeSessionId = session.sessionId;

		try {
			const compactResult = await session.compact();
			const statusAfterHandoff = manager.getJob(jobId)?.status;
			const afterSessionId = session.sessionId;

			gate.resolve("child completed after scratch compaction");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Main" } });
			await session.waitForIdle();

			expect(compactResult.summary).toContain("Scratch handoff");
			expect(afterSessionId).toBe(beforeSessionId);
			expect(statusAfterHandoff).toBe("running");
			expect(abortedByHandoff).toBe(false);
			expect(manager.getJob(jobId)?.status).toBe("completed");

			const asyncResults = promptedBatches
				.flat()
				.filter(
					(message): message is CustomMessage =>
						message.role === "custom" && message.customType === "async-result",
				);
			const deliveredText = asyncResults
				.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				)
				.join("\n");
			expect(asyncResults).toHaveLength(1);
			expect(deliveredText).toContain("child completed after scratch compaction");
			expect(deliveredText.match(/continuity-child-job/g) ?? []).toHaveLength(1);
		} finally {
			gate.resolve("cleanup");
			promptOwner.prompt = originalPrompt;
			await session.dispose();
			authStorage.close();
		}
	});

	it("preserves a full boss-style map of background jobs across scratch handoff", async () => {
		const { session, authStorage } = await createTestSession();
		const manager = session.asyncJobManager;
		if (!manager) throw new Error("expected top-level session to own an async job manager");
		session.settings.set("compaction.strategy", "handoff");

		const gates = Array.from({ length: 10 }, () => Promise.withResolvers<string>());
		const promptedBatches: AgentMessage[][] = [];
		const promptOwner = session.agent as unknown as {
			prompt: (input: AgentMessage | AgentMessage[]) => Promise<void>;
		};
		const originalPrompt = promptOwner.prompt.bind(session.agent);
		promptOwner.prompt = async input => {
			promptedBatches.push(Array.isArray(input) ? input : [input]);
		};

		const jobIds = gates.map((gate, index) =>
			manager.register(
				"task",
				`BossMapJob${index}`,
				async ({ signal }) => {
					const text = await gate.promise;
					if (signal.aborted) throw new Error("boss map job aborted during scratch handoff");
					return text;
				},
				{ id: `boss-map-${index}`, ownerId: "Main" },
			),
		);

		try {
			await session.compact();
			expect(jobIds.map(id => manager.getJob(id)?.status)).toEqual(Array(10).fill("running"));

			gates.forEach((gate, index) => {
				gate.resolve(`boss map job ${index} completed`);
			});
			await Promise.all(jobIds.map(id => manager.getJob(id)?.promise));
			await manager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Main" } });
			await session.waitForIdle();

			expect(jobIds.map(id => manager.getJob(id)?.status)).toEqual(Array(10).fill("completed"));
			const asyncResults = promptedBatches
				.flat()
				.filter(
					(message): message is CustomMessage =>
						message.role === "custom" && message.customType === "async-result",
				);
			const deliveredText = asyncResults
				.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				)
				.join("\n");
			expect(asyncResults).toHaveLength(1);
			for (let index = 0; index < 10; index++) {
				expect(deliveredText).toContain(`boss map job ${index} completed`);
				expect(deliveredText).toContain(`boss-map-${index}`);
			}
		} finally {
			gates.forEach(gate => {
				gate.resolve("cleanup");
			});
			promptOwner.prompt = originalPrompt;
			await session.dispose();
			authStorage.close();
		}
	});

	it("preserves pre-handoff background task completion for the manual handoff successor", async () => {
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("## Goal\nContinue manually");
		const { session, sessionManager, authStorage } = await createTestSession();
		const model = session.model;
		if (!model) throw new Error("expected test session to have a model");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed before manual handoff" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response before manual handoff" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
		const manager = session.asyncJobManager;
		if (!manager) throw new Error("expected top-level session to own an async job manager");

		const gate = Promise.withResolvers<string>();
		let abortedByHandoff = false;
		const promptedBatches: AgentMessage[][] = [];
		const promptOwner = session.agent as unknown as {
			prompt: (input: AgentMessage | AgentMessage[]) => Promise<void>;
		};
		const originalPrompt = promptOwner.prompt.bind(session.agent);
		promptOwner.prompt = async input => {
			promptedBatches.push(Array.isArray(input) ? input : [input]);
		};

		const jobId = manager.register(
			"task",
			"ManualContinuityChild",
			async ({ signal }) => {
				const text = await gate.promise;
				if (signal.aborted) {
					abortedByHandoff = true;
					throw new Error("child aborted during manual handoff");
				}
				return text;
			},
			{ id: "manual-continuity-child-job", ownerId: "Main" },
		);
		const beforeSessionId = session.sessionId;

		try {
			const handoffResult = await session.handoff("continue from the completed child");
			const statusAfterHandoff = manager.getJob(jobId)?.status;
			const afterSessionId = session.sessionId;

			gate.resolve("child completed after manual successor");
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Main" } });
			await session.waitForIdle();

			expect(handoffResult?.document).toContain("Continue manually");
			expect(afterSessionId).not.toBe(beforeSessionId);
			expect(statusAfterHandoff).toBe("running");
			expect(abortedByHandoff).toBe(false);
			expect(manager.getJob(jobId)?.status).toBe("completed");

			const asyncResults = promptedBatches
				.flat()
				.filter(
					(message): message is CustomMessage =>
						message.role === "custom" && message.customType === "async-result",
				);
			const deliveredText = asyncResults
				.map(message =>
					typeof message.content === "string"
						? message.content
						: message.content.map(part => (part.type === "text" ? part.text : "")).join("\n"),
				)
				.join("\n");
			expect(asyncResults).toHaveLength(1);
			expect(deliveredText).toContain("child completed after manual successor");
			expect(deliveredText.match(/manual-continuity-child-job/g) ?? []).toHaveLength(1);
		} finally {
			gate.resolve("cleanup");
			promptOwner.prompt = originalPrompt;
			await session.dispose();
			authStorage.close();
		}
	});
});

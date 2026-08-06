import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentPeer, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 1,
		output: "",
		stderr: "cancelled",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		aborted: true,
	};
}

function session(manager: AsyncJobManager): ToolSession {
	const registry = AgentRegistry.global();
	return {
		cwd: "/workspace",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => MAIN_AGENT_ID,
		getActiveModelString: () => "provider/model",
		getModelString: () => "provider/model",
		getArtifactsDir: () => null,
		asyncJobManager: manager,
		agentRegistry: registry,
		agentLifecycle: () => AgentLifecycleManager.global(),
		keepAliveSubagents: true,
		modelRegistry: {
			getAvailable: () => [{ provider: "provider", id: "model", name: "Model" }],
		} as ToolSession["modelRegistry"],
	} as unknown as ToolSession;
}

describe("Task-backed RLM admission", () => {
	let manager: AsyncJobManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		manager = new AsyncJobManager({ onJobComplete: () => {}, retentionMs: 60_000 });
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	test("returns after runtime publication while the existing Task job continues", async () => {
		let disposed = false;
		let aborted = false;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			expect(options.keepAlive).toBe(true);
			const peer: AgentPeer = {
				messages: [],
				deliverIrcMessage: async () => "queued",
				abort: async () => {
					aborted = true;
				},
				dispose: async () => {
					disposed = true;
				},
			};
			const sessionFile = `/sessions/${options.id}.jsonl`;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: peer,
				sessionFile,
				status: "running",
			});
			options.onAdmission?.({
				id: options.id,
				name: options.id,
				sessionId: "child-session",
				sessionDir: "/sessions",
				sessionFile,
				model: "provider/model",
				cwd: options.cwd,
			});
			if (!options.signal?.aborted) {
				await new Promise<void>(resolve =>
					options.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return result(options.id);
		});
		const tool = await TaskTool.create(session(manager));

		const handle = await tool.admit({
			assignment: "Review the API.",
			name: "reviewer",
			model: "provider/model",
			sourceId: "ipython:root:cell:1",
		});

		expect(handle).toMatchObject({
			id: "reviewer",
			name: "reviewer",
			jobId: "reviewer",
			sessionId: "child-session",
			sessionDir: "/sessions",
			model: "provider/model",
		});
		expect(manager.getJob("reviewer")?.status).toBe("running");
		expect(await tool.listDirectChildren()).toEqual([
			expect.objectContaining({
				id: "reviewer",
				activeSessionId: "child-session",
				status: "running",
				lifecycleStatus: "running",
			}),
		]);

		const deleted = await tool.deleteDirectChild("reviewer");
		expect(deleted).toMatchObject({ id: "reviewer", status: "error", lifecycleStatus: "aborted" });
		expect(manager.getJob("reviewer")?.status).toBe("cancelled");
		expect(AgentRegistry.global().get("reviewer")).toBeUndefined();
		expect(aborted).toBe(true);
		expect(disposed).toBe(true);
	});

	test("keeps Prime-shaped display names separate from filesystem-safe Task ids", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const peer: AgentPeer = {
				messages: [],
				deliverIrcMessage: async () => "queued",
				abort: async () => {},
				dispose: async () => {},
			};
			const sessionFile = `/sessions/${options.id}.jsonl`;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.description ?? options.id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: peer,
				sessionFile,
				status: "running",
			});
			options.onAdmission?.({
				id: options.id,
				name: options.id,
				sessionId: "named-session",
				sessionDir: "/sessions",
				sessionFile,
				model: "provider/model",
				cwd: options.cwd,
			});
			if (!options.signal?.aborted) {
				await new Promise<void>(resolve =>
					options.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
			}
			return result(options.id);
		});
		const tool = await TaskTool.create(session(manager));
		const handle = await tool.admit({
			assignment: "work",
			name: "../API reviewer",
			sourceId: "ipython:root:cell:named",
		});
		expect(handle.name).toBe("../API reviewer");
		expect(handle.id).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(handle.id).not.toContain("..");
		expect(AgentRegistry.global().get(handle.id)?.displayName).toBe("../API reviewer");
		await expect(
			tool.admit({
				assignment: "duplicate",
				name: "../API reviewer",
				sourceId: "ipython:root:cell:duplicate",
			}),
		).rejects.toThrow("already in use by a sibling");
		await tool.deleteDirectChild(handle.id);
	});

	test("projects terminal and parked Task children from AgentRegistry", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			const peer: AgentPeer = {
				messages: [],
				deliverIrcMessage: async () => "queued",
				abort: async () => {},
				dispose: async () => {},
			};
			const sessionFile = `/sessions/${options.id}.jsonl`;
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: peer,
				sessionFile,
				status: "running",
			});
			options.onAdmission?.({
				id: options.id,
				name: options.id,
				sessionId: "terminal-session",
				sessionDir: "/sessions",
				sessionFile,
				model: "provider/model",
				cwd: options.cwd,
			});
			AgentRegistry.global().setStatus(options.id, "idle", peer);
			return result(options.id);
		});
		const tool = await TaskTool.create(session(manager));
		const handle = await tool.admit({
			assignment: "finish",
			name: "terminal-child",
			sourceId: "ipython:root:cell:terminal",
		});
		await manager.getJob(handle.jobId)?.promise;
		AgentRegistry.global().register({
			id: "parked-child",
			displayName: "Parked child",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/sessions/parked.jsonl",
			status: "parked",
		});

		expect(await tool.listDirectChildren()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "terminal-child", status: "completed", lifecycleStatus: "idle" }),
				expect.objectContaining({ id: "parked-child", status: "completed", lifecycleStatus: "parked" }),
			]),
		);
	});

	test("rejects instead of hanging when Task fails before publishing a child", async () => {
		vi.spyOn(executorModule, "runSubprocess").mockRejectedValue(new Error("startup failed"));
		const tool = await TaskTool.create(session(manager));
		await expect(
			tool.admit({
				assignment: "work",
				name: "failed-child",
				sourceId: "ipython:root:cell:failed",
			}),
		).rejects.toThrow("startup failed");
		expect(manager.getJob("failed-child")?.status).toBe("failed");
		expect(AgentRegistry.global().get("failed-child")).toBeUndefined();
	});

	test("does not register a child for an already interrupted cell", async () => {
		const tool = await TaskTool.create(session(manager));
		const abort = new AbortController();
		abort.abort(new Error("cell interrupted"));
		await expect(
			tool.admit({
				assignment: "work",
				sourceId: "ipython:root:cell:aborted",
				signal: abort.signal,
			}),
		).rejects.toThrow("cell interrupted");
		expect(manager.getAllJobs()).toHaveLength(0);
	});

	test("accepts only exact available selectors and exposes the same lookup", async () => {
		const tool = await TaskTool.create(session(manager));
		expect(tool.findModels("model", 8)).toEqual([
			{ provider: "provider", id: "model", name: "Model", selector: "provider/model" },
		]);
		await expect(
			tool.admit({
				assignment: "work",
				model: "provider/model:high",
				sourceId: "ipython:root:cell:2",
			}),
		).rejects.toThrow("exact selector returned by rlm.find_models");
		expect(manager.getAllJobs()).toHaveLength(0);
	});
});

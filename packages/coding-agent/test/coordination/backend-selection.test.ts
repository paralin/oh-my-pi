import { afterEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CoordinationBackend } from "@oh-my-pi/pi-coding-agent/coordination/backend";
import { createParentCoordinationBackend } from "@oh-my-pi/pi-coding-agent/coordination/parent";
import { PARENT_SESSION_ENV, PARENT_SOCKET_ENV } from "@oh-my-pi/pi-coding-agent/parent/config";
import { TaskService } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "../../src/session/tool-session.js";

const nativeAgent: AgentDefinition = {
	name: "task",
	description: "Native task agent",
	systemPrompt: "Run the task.",
	source: "bundled",
};
const claudeAgent: AgentDefinition = {
	...nativeAgent,
	name: "claude",
	model: ["claude-code/sonnet"],
};

const backend: CoordinationBackend = {
	kind: "parent",
	spawn: () => Promise.reject(new Error("unused")),
	listPeers: () => Promise.reject(new Error("unused")),
	attachMailbox: () => {},
	send: () => Promise.reject(new Error("unused")),
	inbox: () => [],
	waitMessage: () => Promise.reject(new Error("unused")),
	interrupt: () => Promise.reject(new Error("unused")),
	close: () => Promise.resolve(),
};

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, ...settings }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		coordinationBackend: backend,
	};
}

function result(id = "worker-2", overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		assignment: "work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function textOf(value: { content: Array<{ type: string; text?: string }> }): string {
	return value.content.find(part => part.type === "text")?.text ?? "";
}

describe("coordination backend selection", () => {
	afterEach(() => vi.restoreAllMocks());

	test("selects Parent only when socket and caller session are both configured", async () => {
		expect(() => createParentCoordinationBackend({ env: { [PARENT_SOCKET_ENV]: "/tmp/parent.sock" } })).toThrow(
			"OMP_PARENT_SESSION is required",
		);
		expect(createParentCoordinationBackend({ env: {} })).toBeUndefined();

		const selected = createParentCoordinationBackend({
			env: {
				[PARENT_SOCKET_ENV]: "/tmp/parent.sock",
				[PARENT_SESSION_ENV]: "glados/live/root/llm-session",
			},
		});
		expect(selected?.kind).toBe("parent");
		expect(selected?.client.connected).toBe(false);
		await selected?.close();
	});

	test("rejects isolated and Claude policies before execution", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [nativeAgent, claudeAgent],
			projectAgentsDir: null,
		});
		const run = vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(result());

		const isolatedTool = await TaskService.create(session({ "task.isolation.mode": "auto" }));
		const isolated = await isolatedTool.spawn("isolated", {
			agent: "task",
			task: "work",
			isolated: true,
		});
		expect(textOf(isolated)).toContain("unsupported_parent_runtime");

		const claudeTool = await TaskService.create(session());
		const claude = await claudeTool.spawn("claude", {
			agent: "claude",
			task: "work",
		});
		expect(textOf(claude)).toContain("unsupported_parent_runtime");
		expect(run).not.toHaveBeenCalled();
	});

	test("routes native execution through the selected backend object", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [nativeAgent],
			projectAgentsDir: null,
		});
		const localRun = vi.spyOn(executorModule, "runSubprocess");
		const spawn = vi.spyOn(backend, "spawn").mockImplementation(async request => ({
			peerId: request.peerId,
			wait: async () => ({
				result: result(),
				policy: request.policy,
				mergeSummary: "",
				changesApplied: null,
				artifactsDir: request.artifactsDir,
				temporaryArtifacts: request.temporaryArtifacts,
			}),
		}));
		const tool = await TaskService.create(session());
		await tool.spawn("native", { agent: "task", task: "work" });
		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn.mock.calls[0]?.[0].request.session.coordinationBackend).toBe(backend);
		expect(localRun).not.toHaveBeenCalled();
	});

	test("keeps a detached Parent Task in the local job manager and auto-delivers its result", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [nativeAgent],
			projectAgentsDir: null,
		});
		const admitted = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: (_jobId, text) => {
				delivered.push(text);
			},
		});
		const spawn = vi.spyOn(backend, "spawn").mockImplementation(async request => {
			admitted.resolve();
			return {
				peerId: request.peerId,
				wait: async () => {
					await finish.promise;
					return {
						result: result(request.peerId),
						policy: request.policy,
						mergeSummary: "",
						changesApplied: null,
						artifactsDir: request.artifactsDir,
						temporaryArtifacts: request.temporaryArtifacts,
					};
				},
			};
		});
		try {
			const tool = await TaskService.create({
				...session({ "async.enabled": true }),
				asyncJobManager: manager,
			});
			const started = await tool.spawn("parent-async", { agent: "task", name: "ExactPeer", task: "work" });
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("Parent Task did not register a local job");
			await admitted.promise;

			expect(spawn.mock.calls[0]?.[0].peerId).toBe("ExactPeer");
			expect(manager.getJob(jobId)).toEqual(expect.objectContaining({ status: "running", agentId: "ExactPeer" }));
			finish.resolve();
			await manager.getJob(jobId)?.promise;
			expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("done");
		} finally {
			finish.resolve();
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	test("propagates local job cancellation into the durable wait signal", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [nativeAgent],
			projectAgentsDir: null,
		});
		const admitted = Promise.withResolvers<void>();
		let aborts = 0;
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		vi.spyOn(backend, "spawn").mockImplementation(async request => {
			admitted.resolve();
			return {
				peerId: request.peerId,
				wait: async signal =>
					await new Promise(resolve => {
						const settle = () => {
							aborts += 1;
							resolve({
								result: result(request.peerId, {
									exitCode: 1,
									aborted: true,
									abortReason: "Task cancelled by its parent",
								}),
								policy: request.policy,
								mergeSummary: "",
								changesApplied: null,
								artifactsDir: request.artifactsDir,
								temporaryArtifacts: request.temporaryArtifacts,
							});
						};
						if (signal?.aborted) settle();
						else signal?.addEventListener("abort", settle, { once: true });
					}),
			};
		});
		try {
			const tool = await TaskService.create({
				...session({ "async.enabled": true }),
				asyncJobManager: manager,
			});
			const started = await tool.spawn("parent-cancel", { agent: "task", name: "Cancelable", task: "work" });
			const jobId = started.details?.async?.jobId;
			if (!jobId) throw new Error("Parent Task did not register a local job");
			await admitted.promise;

			expect(manager.cancel(jobId)).toBe(true);
			await manager.getJob(jobId)?.promise;
			expect(aborts).toBe(1);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});
});

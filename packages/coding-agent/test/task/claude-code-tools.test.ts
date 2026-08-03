import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentPeer, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { claudeCodeNativeTools } from "@oh-my-pi/pi-coding-agent/task/claude-code-runtime";
import { createClaudeCodeMcpServer } from "@oh-my-pi/pi-coding-agent/task/claude-code-sdk";
import {
	createClaudeCodeMcpTools,
	createClaudeCodeToolSession,
} from "@oh-my-pi/pi-coding-agent/task/claude-code-tools";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition, SingleResult, YieldItem } from "@oh-my-pi/pi-coding-agent/task/types";
import { WORLD_SOCKET_ENV, WorldClient } from "@oh-my-pi/pi-coding-agent/world/index";

const CLAUDE_AGENT: AgentDefinition = {
	name: "claude-parent",
	description: "Claude parent",
	systemPrompt: "Coordinate the work.",
	spawns: "*",
	source: "project",
};

const TASK_AGENT: AgentDefinition = {
	name: "task",
	description: "Task worker",
	systemPrompt: "Complete the nested task.",
	model: ["openai/gpt-4.1-mini"],
	source: "bundled",
};

function peer(messages: IrcMessage[] = []): AgentPeer {
	return {
		messages: [],
		deliverIrcMessage: async message => {
			messages.push(message);
			return "injected";
		},
		abort: async () => {},
		dispose: async () => {},
	};
}

function result(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Nested task",
		assignment: "Nested task",
		exitCode: 0,
		output: "Nested result",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
	};
}

function options(settings: Settings, manager?: AsyncJobManager): ExecutorOptions {
	return {
		cwd: "/tmp",
		agent: CLAUDE_AGENT,
		task: "Parent task",
		assignment: "Parent task",
		index: 0,
		id: "ClaudePeer",
		taskDepth: 0,
		settings,
		asyncJobManager: manager,
	};
}

function text(value: { content: Array<{ type: string; text?: string }> }): string {
	return value.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

describe("Claude Code OMP tools", () => {
	const managers: AsyncJobManager[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function manager(): AsyncJobManager {
		const created = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(created);
		return created;
	}

	function registerClaude(registry: AgentRegistry): void {
		registry.register({
			id: "ClaudePeer",
			displayName: "claude-parent",
			kind: "sub",
			parentId: "Main",
			session: peer(),
			status: "running",
		});
	}

	async function tools(executor: ExecutorOptions, signal = new AbortController().signal) {
		const registry = AgentRegistry.global();
		registerClaude(registry);
		const yieldItems: YieldItem[] = [];
		return createClaudeCodeMcpTools({
			executor,
			registry,
			signal,
			yieldItems,
			onTerminalYield: () => {},
		});
	}

	it("builds the nested ToolSession from Claude identity and spawn policy", () => {
		const jobs = manager();
		const settings = Settings.isolated({ "task.maxRecursionDepth": 3 });
		const executor = options(settings, jobs);
		executor.additionalDirectories = ["/tmp/outside"];
		executor.worktree = "/tmp/isolated";
		const session = createClaudeCodeToolSession(executor, AgentRegistry.global());

		expect(session.getAgentId?.()).toBe("ClaudePeer");
		expect(session.taskDepth).toBe(1);
		expect(session.getSessionSpawns()).toBe("*");
		expect(session.agentRegistry).toBe(AgentRegistry.global());
		expect(session.asyncJobManager).toBe(jobs);
		expect(session.cwd).toBe("/tmp/isolated");
		expect(session.additionalDirectories).toBeUndefined();
	});

	it("delegates synchronous nested work through TaskTool with Claude ownership and depth", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TASK_AGENT], projectAgentsDir: null });
		const run = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async nested => result(nested.id));
		const controller = new AbortController();
		const bridge = await tools(
			options(Settings.isolated({ "async.enabled": false, "task.maxRecursionDepth": 3 })),
			controller.signal,
		);
		const task = bridge.find(tool => tool.name === "task");
		if (!task) throw new Error("Task MCP tool missing");

		const called = await task.handler({ agent: "task", name: "Nested", task: "Inspect the nested target." });

		expect(called.isError).not.toBe(true);
		expect(text(called)).toContain("Nested result");
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toMatchObject({
			keepAlive: true,
			parentAgentId: "ClaudePeer",
			taskDepth: 1,
			modelOverride: ["openai/gpt-4.1-mini"],
			signal: controller.signal,
		});
	});

	it("rejects nested Task at the inherited recursion boundary before execution", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TASK_AGENT], projectAgentsDir: null });
		const run = vi.spyOn(executorModule, "runSubprocess");
		const executor = options(Settings.isolated({ "async.enabled": false, "task.maxRecursionDepth": 2 }));
		executor.taskDepth = 1;
		const bridge = await tools(executor);
		const task = bridge.find(tool => tool.name === "task");
		if (!task) throw new Error("Task MCP tool missing");

		const called = await task.handler({ agent: "task", task: "Must not start." });

		expect(text(called)).toContain("Cannot spawn another agent at task depth 2; maximum depth is 2.");
		expect(run).not.toHaveBeenCalled();
	});

	it("keeps asynchronous Task and Hub custody scoped to the Claude owner", async () => {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [TASK_AGENT], projectAgentsDir: null });
		const gate = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async nested => {
			await gate.promise;
			return result(nested.id);
		});
		const jobs = manager();
		const bridge = await tools(options(Settings.isolated({ "async.enabled": true }), jobs));
		const task = bridge.find(tool => tool.name === "task");
		const hub = bridge.find(tool => tool.name === "hub");
		if (!task || !hub) throw new Error("Task or Hub MCP tool missing");

		const spawned = await task.handler({ agent: "task", name: "AsyncNested", task: "Inspect asynchronously." });
		const owned = jobs.getAllJobs({ ownerId: "ClaudePeer" });
		expect(spawned.isError).not.toBe(true);
		expect(owned).toHaveLength(1);
		expect(owned[0]?.agentId).toBe("ClaudePeer.AsyncNested");
		expect(jobs.getAllJobs({ ownerId: "OtherPeer" })).toHaveLength(0);

		const otherId = jobs.register("task", "other task", async () => "other result", { ownerId: "OtherPeer" });
		await jobs.getJob(otherId)?.promise;
		const visible = await hub.handler({ op: "jobs" });
		expect(text(visible)).toContain(owned[0]!.id);
		expect(text(visible)).not.toContain(otherId);

		gate.resolve();
		await owned[0]!.promise;
		const waited = await hub.handler({ op: "wait", ids: [owned[0]!.id], timeoutMs: 1_000 });
		expect(text(waited)).toContain("Nested result");
		expect(jobs.getJob(otherId)?.status).toBe("completed");
		expect(jobs.getJob(owned[0]!.id)?.status).toBe("completed");
	});

	it("cancels only jobs owned by the Claude peer", async () => {
		const jobs = manager();
		const ownGate = Promise.withResolvers<void>();
		const foreignGate = Promise.withResolvers<void>();
		const ownId = jobs.register(
			"task",
			"owned task",
			async () => {
				await ownGate.promise;
				return "owned";
			},
			{ ownerId: "ClaudePeer" },
		);
		const foreignId = jobs.register(
			"task",
			"foreign task",
			async () => {
				await foreignGate.promise;
				return "foreign";
			},
			{ ownerId: "OtherPeer" },
		);
		const bridge = await tools(options(Settings.isolated(), jobs));
		const hub = bridge.find(tool => tool.name === "hub");
		if (!hub) throw new Error("Hub MCP tool missing");

		const cancelled = await hub.handler({ op: "cancel", ids: [ownId, foreignId] });

		expect(text(cancelled)).toContain(`Cancelled background job ${ownId}.`);
		expect(text(cancelled)).toContain(`Background job not found: ${foreignId}`);
		expect(jobs.getJob(ownId)?.status).toBe("cancelled");
		expect(jobs.getJob(foreignId)?.status).toBe("running");
		ownGate.resolve();
		foreignGate.resolve();
		await Promise.all([jobs.getJob(ownId)!.promise, jobs.getJob(foreignId)!.promise]);
	});

	it("advertises only messaging and job Hub operations and rejects process shapes", async () => {
		const bridge = await tools(options(Settings.isolated()));
		const hub = bridge.find(tool => tool.name === "hub");
		if (!hub) throw new Error("Hub MCP tool missing");
		const server = createClaudeCodeMcpServer({ name: "omp", tools: bridge });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "claude-hub-boundary", version: "1" });
		await server.instance.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			const advertised = (await client.listTools()).tools.find(tool => tool.name === "hub")?.inputSchema;
			expect(advertised?.properties?.op).toMatchObject({
				enum: ["list", "send", "inbox", "wait", "jobs", "cancel"],
			});
			expect(advertised?.properties).not.toHaveProperty("name");
			expect(advertised?.properties).not.toHaveProperty("application");

			const start = await client.callTool({ name: "hub", arguments: { op: "start" } });
			expect(start.isError).toBe(true);
			expect(JSON.stringify(start.content)).toContain("operation is unavailable");
			const processSend = await client.callTool({ name: "hub", arguments: { op: "send", name: "server" } });
			expect(processSend.isError).toBe(true);
			expect(JSON.stringify(processSend.content)).toContain("process field is unavailable: name");
			const processWait = await client.callTool({ name: "hub", arguments: { op: "wait", name: "server" } });
			expect(processWait.isError).toBe(true);
			expect(JSON.stringify(processWait.content)).toContain("process field is unavailable: name");
		} finally {
			await client.close();
			await server.instance.close();
		}
	});

	it("uses the Claude peer identity for Hub list, send, and immediate wait", async () => {
		const registry = AgentRegistry.global();
		const received: IrcMessage[] = [];
		registry.register({
			id: "OtherPeer",
			displayName: "other",
			kind: "sub",
			parentId: "Main",
			session: peer(received),
			status: "running",
		});
		const bridge = await tools(options(Settings.isolated()));
		const hub = bridge.find(tool => tool.name === "hub");
		if (!hub) throw new Error("Hub MCP tool missing");

		const listed = await hub.handler({ op: "list" });
		expect(text(listed)).toContain("OtherPeer");
		const sent = await hub.handler({ op: "send", to: "OtherPeer", message: "ready?" });
		expect(sent.isError).not.toBe(true);
		expect(received).toMatchObject([{ from: "ClaudePeer", to: "OtherPeer", body: "ready?" }]);

		const waiting = hub.handler({ op: "wait", from: "OtherPeer", timeoutMs: 1_000 });
		await IrcBus.global().send({ from: "OtherPeer", to: "ClaudePeer", body: "ready" });
		const waited = await waiting;
		expect(text(waited)).toContain("OtherPeer: ready");
		const inbox = await hub.handler({ op: "inbox" });
		expect(text(inbox)).toBe("Inbox empty.");
	});

	// world_read is the Claude half of the same World read the native
	// spacewave:// handler serves. It is conditional on purpose: a root with no
	// configured daemon has nothing to address, so advertising the tool there
	// would offer a capability whose every call fails.
	describe("world_read bridge", () => {
		const KEY = "glados/live/omp/abc/llm-session";
		const URI = `/u/1/so/sp1/-/${KEY}`;
		const WORLD_URL = `spacewave://${URI}`;

		// Awaited inside the try, not returned from it: restoring the variable
		// before the promise settles would put the bridge back on the ambient
		// configuration while it is still deciding whether to build the tool.
		async function withSocket<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
			const previous = process.env[WORLD_SOCKET_ENV];
			if (value === undefined) delete process.env[WORLD_SOCKET_ENV];
			else process.env[WORLD_SOCKET_ENV] = value;
			try {
				return await run();
			} finally {
				if (previous === undefined) delete process.env[WORLD_SOCKET_ENV];
				else process.env[WORLD_SOCKET_ENV] = previous;
			}
		}

		it("is absent from an unconfigured root", async () => {
			const bridge = await withSocket(undefined, () => tools(options(Settings.isolated())));
			expect(bridge.map(tool => tool.name)).not.toContain("world_read");
		});

		it("is advertised when a World socket is configured", async () => {
			const bridge = await withSocket("/run/glados/console.sock", () => tools(options(Settings.isolated())));
			const worldRead = bridge.find(tool => tool.name === "world_read");
			if (!worldRead) throw new Error("world_read MCP tool missing");
			const schema = worldRead.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
			// url and limit only: no out-of-band mode bit, so the address alone
			// decides object versus listing.
			expect(schema.required).toEqual(["url"]);
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["limit", "url"]);
		});

		it("reports a malformed address as a tool failure without dialing", async () => {
			const bridge = await withSocket("/run/glados/console.sock", () => tools(options(Settings.isolated())));
			const worldRead = bridge.find(tool => tool.name === "world_read");
			if (!worldRead) throw new Error("world_read MCP tool missing");
			const failed = await worldRead.handler({ url: `${WORLD_URL}#1` });
			expect(failed.isError).toBe(true);
			expect(text(failed)).toContain("fragment marker");
		});

		it("observes World client cleanup failures when the peer aborts", async () => {
			const observe = vi.fn(() => Promise.resolve());
			const cleanup = { catch: observe } as unknown as Promise<void>;
			const close = vi.fn(() => cleanup);
			vi.spyOn(WorldClient, "create").mockReturnValue({ close } as unknown as WorldClient);
			const controller = new AbortController();
			await tools(options(Settings.isolated()), controller.signal);

			controller.abort();

			expect(close).toHaveBeenCalledTimes(1);
			expect(observe).toHaveBeenCalledTimes(1);
		});

		it("detaches a completed read from a later peer abort", async () => {
			let staleReadAborted = false;
			const readWorldURI = vi.fn(async (_uri: string, readOptions?: { signal?: AbortSignal }) => {
				readOptions?.signal?.addEventListener("abort", () => {
					staleReadAborted = true;
				});
				return { found: false as const, objectKey: KEY };
			});
			const close = vi.fn(async () => {});
			vi.spyOn(WorldClient, "create").mockReturnValue({
				readWorldURI,
				close,
			} as unknown as WorldClient);
			const controller = new AbortController();
			const bridge = await tools(options(Settings.isolated()), controller.signal);
			const worldRead = bridge.find(tool => tool.name === "world_read");
			if (!worldRead) throw new Error("world_read MCP tool missing");

			const result = await worldRead.handler({ url: WORLD_URL });
			expect(result.isError).not.toBe(true);
			expect(readWorldURI.mock.calls[0]?.[0]).toBe(URI);
			controller.abort();

			expect(staleReadAborted).toBe(false);
			expect(close).toHaveBeenCalledTimes(1);
		});

		it("keeps world_read admissible for a restricted child", () => {
			expect(() => claudeCodeNativeTools(["read", "world_read"])).not.toThrow();
			expect(() => claudeCodeNativeTools(["read", "not_a_tool"])).toThrow(/Unsupported restricted/);
		});
	});
});

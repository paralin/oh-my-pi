import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createIpythonCapabilityHostHandlers,
	createIpythonMcpOwner,
	type IpythonMcpManagerOwner,
	type IpythonMcpOwner,
} from "../../src/ipython/capability-service.js";
import type { IpythonDisplayEvent, IpythonHostRequest } from "../../src/ipython/controller.js";
import { OmpHarnessService } from "../../src/ipython/harness-service.js";
import type { MCPServerConfig, MCPServerConnection, MCPTransport } from "../../src/mcp/types.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(mcp?: IpythonMcpOwner) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-capability-"));
	temporaryRoots.push(root);
	const local = path.join(root, "local");
	const global = path.join(root, "global");
	await fs.mkdir(local, { recursive: true });
	const displays: IpythonDisplayEvent[] = [];
	let refreshes = 0;
	const harness = new OmpHarnessService({ localRoot: () => local, globalRoot: global });
	const handlers = createIpythonCapabilityHostHandlers({
		harness,
		mcp,
		modelInfo: () => ({ id: "provider/vision", input: ["text", "image"] }),
		refreshSystemPrompt: async () => {
			refreshes += 1;
		},
	});
	const request = (data: Readonly<Record<string, unknown>>): IpythonHostRequest => ({
		requestId: "execution-1",
		executionId: "execution-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal: new AbortController().signal,
		sessionId: "session-1",
		cwd: root,
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async display => {
			displays.push({ ...display, kind: "display" });
		},
		allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
	});
	const call = async (operation: string, data: Record<string, unknown> = {}) => {
		const handler = handlers[operation];
		if (!handler) throw new Error(`missing handler ${operation}`);
		return await handler(request({ ...data, type: operation }));
	};
	return { root, local, global, displays, call, refreshes: () => refreshes };
}

function mcpFixture(): { owner: IpythonMcpOwner; calls: Array<Record<string, unknown>> } {
	const calls: Array<Record<string, unknown>> = [];
	const config = {
		type: "http",
		url: "https://example.test/mcp",
		headers: { Authorization: "secret" },
	} satisfies MCPServerConfig;
	return {
		calls,
		owner: {
			getAllServerNames: () => ["demo"],
			getConnectedServers: () => ["demo"],
			getServerConfig: () => config,
			listTools: async (_name, signal) => {
				calls.push({ operation: "list", aborted: signal.aborted });
				return [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }];
			},
			callTool: async (name, tool, args, signal) => {
				calls.push({ operation: "call", name, tool, args, aborted: signal.aborted });
				return { content: [{ type: "text", text: String(args.value) }], isError: false };
			},
			getServerResources: () => ({
				resources: [{ uri: "demo://one" }],
				templates: [{ uriTemplate: "demo://{id}" }],
			}),
			readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "resource" }] }),
			getServerPrompts: () => [{ name: "summarize" }],
			executePrompt: async (_name, promptName, args) => ({
				messages: [{ role: "user", content: `${promptName}:${args?.topic}` }],
			}),
			reconnect: async name => {
				calls.push({ operation: "reconnect", name });
				return true;
			},
			getNotificationState: () => ({ enabled: true, subscriptions: [{ server: "demo", methods: ["changed"] }] }),
			waitNotification: async options => ({
				server: options.server ?? "demo",
				method: options.method ?? "changed",
				params: { value: 1, access_token: "private" },
			}),
			refreshServerResources: async name => {
				calls.push({ operation: "refresh-resources", name });
			},
			refreshServerPrompts: async name => {
				calls.push({ operation: "refresh-prompts", name });
			},
		},
	};
}

function mcpConnection(request: () => unknown | Promise<unknown>): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		request: async <T>() => (await request()) as T,
		notify: async () => {},
		close: async () => {},
	};
	return {
		name: "demo",
		config: { type: "http", url: "https://example.test/mcp" },
		transport,
		serverInfo: { name: "demo", version: "1" },
		capabilities: {},
	};
}

function mcpManager(
	connection: MCPServerConnection,
	reconnect: IpythonMcpManagerOwner["reconnectServer"],
	addNotificationListener: IpythonMcpManagerOwner["addNotificationListener"] = () => () => {},
): IpythonMcpManagerOwner {
	return {
		getAllServerNames: () => ["demo"],
		getConnectedServers: () => ["demo"],
		getServerConfig: () => connection.config,
		getConnection: () => connection,
		reconnectServer: reconnect,
		getNotificationState: () => ({ enabled: true, subscriptions: new Map() }),
		addNotificationListener,
		getServerResources: () => undefined,
		readServerResource: async () => undefined,
		getServerPrompts: () => undefined,
		executePrompt: async () => undefined,
		refreshServerResources: async () => {},
		refreshServerPrompts: async () => {},
	};
}

describe("IPython typed capability services", () => {
	test("admits bounded signature-checked images and reports the active model without exposing HTML", async () => {
		const f = await fixture();
		expect(await f.call("model.info")).toEqual({ id: "provider/vision", input: ["text", "image"] });
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
		expect(await f.call("attachment.admit", { path: "chart.png", mime_type: "image/png", data: png })).toEqual({
			path: "chart.png",
			mime_type: "image/png",
			bytes: 69,
			width: 1,
			height: 1,
		});
		expect(f.displays[0]).toMatchObject({
			data: {
				"application/vnd.omp.attachment+json": { path: "chart.png", mime_type: "image/png", data: png },
				"text/plain": "Loaded image into context: chart.png",
			},
		});
		await expect(f.call("attachment.admit", { path: "bad.jpg", mime_type: "image/jpeg", data: png })).rejects.toThrow(
			"does not match",
		);
	});

	test("projects memory, rules, and skills through managed OMP storage", async () => {
		const f = await fixture();
		for (const domain of ["memory", "rules", "skills"]) {
			const created = await f.call(`${domain}.create`, {
				id: `${domain}-entry`,
				description: `${domain} description`,
				content: `${domain} content`,
				scope: "local",
			});
			expect(created.entry).toMatchObject({ id: `${domain}-entry`, content: `${domain} content`, scope: "local" });
			expect(await f.call(`${domain}.list`, { scope: "local" })).toMatchObject({
				entries: [{ id: `${domain}-entry` }],
			});
			if (domain === "rules") {
				const native = await fs.readFile(path.join(f.local, "managed-rules", "rules-entry.md"), "utf8");
				expect(native).toContain("alwaysApply: true");
				expect(native).toContain("kind: rule");
			}
			expect(await f.call(`${domain}.delete`, { id: `${domain}-entry`, scope: "local" })).toEqual({ deleted: true });
		}
		expect(f.refreshes()).toBe(6);
	});

	test("spills oversized MCP values without exposing private metadata", async () => {
		const mcp = mcpFixture();
		mcp.owner.callTool = async () => ({
			content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
			isError: false,
			_meta: { access_token: "private" },
		});
		const f = await fixture(mcp.owner);
		const result = await f.call("mcp.call_tool", { server: "demo", tool: "large" });
		expect(result).toMatchObject({ result: { truncated: true, artifact: { mime_type: "application/json" } } });
		const artifact = await fs.readFile(path.join(f.root, "artifact.json"), "utf8");
		expect(artifact.length).toBeGreaterThan(1024 * 1024);
		expect(artifact).not.toContain("access_token");
		expect(artifact).not.toContain("private");
	});

	test("uses the host MCP owner for tools, resources, prompts, safe config, and refresh", async () => {
		const mcp = mcpFixture();
		const f = await fixture(mcp.owner);
		expect(await f.call("mcp.list_servers")).toEqual({ servers: [{ name: "demo", connected: true }] });
		expect(await f.call("mcp.list_tools", { server: "demo" })).toMatchObject({ tools: [{ name: "echo" }] });
		expect(await f.call("mcp.call_tool", { server: "demo", tool: "echo", arguments: { value: "hello" } })).toEqual({
			result: [{ type: "text", text: "hello" }],
			is_error: false,
		});
		expect(await f.call("mcp.list_resources", { server: "demo", refresh: true })).toMatchObject({
			resources: [{ uri: "demo://one" }],
			templates: [{ uriTemplate: "demo://{id}" }],
		});
		expect(await f.call("mcp.resource_templates", { server: "demo" })).toEqual({
			templates: [{ uriTemplate: "demo://{id}" }],
		});
		expect(await f.call("mcp.read_resource", { server: "demo", uri: "demo://one" })).toMatchObject({
			result: { contents: [{ text: "resource" }] },
		});
		expect(await f.call("mcp.list_prompts", { server: "demo", refresh: true })).toMatchObject({
			prompts: [{ name: "summarize" }],
		});
		expect(
			await f.call("mcp.get_prompt", { server: "demo", name: "summarize", arguments: { topic: "state" } }),
		).toMatchObject({ result: { messages: [{ content: "summarize:state" }] } });
		const config = await f.call("mcp.config", { server: "demo" });
		expect(config).toEqual({ server: "demo", connected: true, type: "http", url: "https://example.test/mcp" });
		expect(JSON.stringify(config)).not.toContain("secret");
		expect(await f.call("mcp.notification_state")).toMatchObject({ enabled: true });
		expect(await f.call("mcp.wait_notification", { server: "demo", method: "changed", timeout: 1 })).toEqual({
			server: "demo",
			method: "changed",
			params: { value: 1 },
		});
		expect(await f.call("mcp.refresh", { server: "demo" })).toEqual({
			refreshed: true,
			connected: true,
			connection: "connected",
		});
		expect(mcp.calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ operation: "call", tool: "echo" }),
				expect.objectContaining({ operation: "reconnect" }),
			]),
		);
	});

	test("reconnects once for stale transports and host-owned auth challenges", async () => {
		let firstCalls = 0;
		const stale = mcpConnection(() => {
			firstCalls += 1;
			throw new Error("ECONNRESET");
		});
		const recovered = mcpConnection(() => ({ content: [{ type: "text", text: "recovered" }], isError: false }));
		let reconnects = 0;
		const owner = createIpythonMcpOwner(
			mcpManager(stale, async () => {
				reconnects += 1;
				return recovered;
			}),
		);
		expect(await owner.callTool("demo", "echo", {}, new AbortController().signal)).toMatchObject({
			content: [{ text: "recovered" }],
		});
		expect({ firstCalls, reconnects }).toEqual({ firstCalls: 1, reconnects: 1 });

		const challenged = mcpConnection(() => ({
			content: [{ type: "text", text: "authenticate" }],
			isError: true,
			_meta: { "mcp/www_authenticate": ["Bearer resource_metadata=demo"] },
		}));
		let challenge: unknown;
		const authOwner = createIpythonMcpOwner(
			mcpManager(challenged, async (_name, options) => {
				challenge = options?.authChallenge;
				return recovered;
			}),
		);
		expect(await authOwner.callTool("demo", "echo", {}, new AbortController().signal)).toMatchObject({
			content: [{ text: "recovered" }],
		});
		expect(challenge).toEqual({ wwwAuthenticate: ["Bearer resource_metadata=demo"] });
	});

	test("cancels MCP notification waits and removes their listener", async () => {
		let listener: ((server: string, method: string, params: unknown) => void) | undefined;
		let removed = 0;
		const connection = mcpConnection(() => null);
		const owner = createIpythonMcpOwner(
			mcpManager(
				connection,
				async () => connection,
				next => {
					listener = next;
					return () => {
						removed += 1;
					};
				},
			),
		);
		const abort = new AbortController();
		const waiting = owner.waitNotification?.({ timeoutMs: 1_000, signal: abort.signal });
		expect(listener).toBeDefined();
		abort.abort(new Error("cancel wait"));
		await expect(waiting).rejects.toThrow("Operation aborted");
		expect(removed).toBe(1);
	});

	test("waits for a matching MCP notification and cleans up a synchronous buffered delivery", async () => {
		let removed = 0;
		const connection = mcpConnection(() => null);
		const owner = createIpythonMcpOwner(
			mcpManager(
				connection,
				async () => connection,
				listener => {
					listener("demo", "changed", { value: 1, access_token: "private" });
					return () => {
						removed += 1;
					};
				},
			),
		);
		expect(
			await owner.waitNotification?.({
				server: "demo",
				method: "changed",
				timeoutMs: 100,
				signal: new AbortController().signal,
			}),
		).toEqual({ server: "demo", method: "changed", params: { value: 1 } });
		expect(removed).toBe(1);
	});
});

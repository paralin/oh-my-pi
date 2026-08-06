import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createIpythonCapabilityHostHandlers, type IpythonMcpOwner } from "../../src/ipython/capability-service.js";
import type { IpythonDisplayEvent, IpythonHostRequest } from "../../src/ipython/controller.js";
import { OmpHarnessService } from "../../src/ipython/harness-service.js";
import type { MCPServerConfig } from "../../src/mcp/types.js";

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
		cwd: root,
		snapshotOwner: {},
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
			getServerResources: () => ({ resources: [{ uri: "demo://one" }], templates: [] }),
			readServerResource: async (_name, uri) => ({ contents: [{ uri, text: "resource" }] }),
			getServerPrompts: () => [{ name: "summarize" }],
			executePrompt: async (_name, promptName, args) => ({
				messages: [{ role: "user", content: `${promptName}:${args?.topic}` }],
			}),
			refreshCredentials: async name => {
				calls.push({ operation: "refresh-credentials", name });
				return true;
			},
			refreshServerResources: async name => {
				calls.push({ operation: "refresh-resources", name });
			},
			refreshServerPrompts: async name => {
				calls.push({ operation: "refresh-prompts", name });
			},
		},
	};
}

describe("IPython typed capability services", () => {
	test("searches and edits only regular files inside the workspace and publishes the OMP diff", async () => {
		const f = await fixture();
		const file = path.join(f.root, "example.txt");
		await fs.writeFile(file, "alpha\nbeta\n");
		await fs.writeFile(path.join(f.root, "hashline.txt"), "delta\nepsilon\n");
		const search = await f.call("workspace.search", { query: "beta", paths: ["."], limit: 10 });
		expect(search).toMatchObject({
			matches: [{ path: "example.txt", line: 2, text: "beta" }],
			truncated: false,
		});
		const anchored = await f.call("workspace.search", { query: "epsilon", paths: ["hashline.txt"], limit: 10 });
		const snapshot = (anchored.snapshots as Array<{ header: string }>)[0];
		if (!snapshot) throw new Error("search did not return a hashline snapshot");
		await expect(
			f.call("workspace.hashline_edit", { input: `${snapshot.header}\nPUT 1-1:\n+changed` }),
		).rejects.toThrow("never displayed");
		const hashline = await f.call("workspace.hashline_edit", {
			input: `${snapshot.header}\nPUT 2-2:\n+zeta`,
		});
		expect(hashline).toMatchObject({ op: "update", start_line: 2 });
		expect(await fs.readFile(path.join(f.root, "hashline.txt"), "utf8")).toBe("delta\nzeta\n");
		const edited = await f.call("workspace.edit", { path: "example.txt", old_str: "beta", new_str: "gamma" });
		expect(edited).toMatchObject({ start_line: 2 });
		expect(path.basename(String(edited.path))).toBe("example.txt");
		expect(await fs.readFile(file, "utf8")).toBe("alpha\ngamma\n");
		expect(f.displays).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "display",
					data: expect.objectContaining({
						"application/vnd.omp.diff+json": expect.objectContaining({ path: edited.path, start_line: 2 }),
					}),
				}),
			]),
		);
		await expect(f.call("workspace.edit", { path: "example.txt", old_str: "a", new_str: "x" })).rejects.toThrow(
			"exactly once",
		);
		await expect(f.call("workspace.search", { query: "x", paths: [".."] })).rejects.toThrow("outside");
	});

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
			templates: [],
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
		expect(await f.call("mcp.refresh", { server: "demo" })).toEqual({ refreshed: true });
		expect(mcp.calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ operation: "call", tool: "echo" }),
				expect.objectContaining({ operation: "refresh-credentials" }),
			]),
		);
	});
});

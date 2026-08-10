import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DapResolvedAdapter } from "../../src/dap/types.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { type IpythonDebugManager, IpythonDebugService } from "../../src/ipython/debug-service.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeDebugManager implements IpythonDebugManager {
	readonly calls: Array<{ operation: string; args: unknown[] }> = [];
	largeVariables = false;

	#result(operation: string, args: unknown[]): Record<string, unknown> {
		this.calls.push({ operation, args });
		if (operation === "variables" && this.largeVariables) return { variables: [{ value: "x".repeat(1024 * 1024) }] };
		return { operation };
	}

	getActiveSession() {
		return null;
	}
	listSessions() {
		return [];
	}
	getCapabilities() {
		return { supportsTerminateRequest: true };
	}
	async launch(...args: unknown[]) {
		return this.#result("launch", args);
	}
	async attach(...args: unknown[]) {
		return this.#result("attach", args);
	}
	async setBreakpoint(...args: unknown[]) {
		return this.#result("setBreakpoint", args);
	}
	async removeBreakpoint(...args: unknown[]) {
		return this.#result("removeBreakpoint", args);
	}
	async setFunctionBreakpoint(...args: unknown[]) {
		return this.#result("setFunctionBreakpoint", args);
	}
	async removeFunctionBreakpoint(...args: unknown[]) {
		return this.#result("removeFunctionBreakpoint", args);
	}
	async setInstructionBreakpoint(...args: unknown[]) {
		return this.#result("setInstructionBreakpoint", args);
	}
	async removeInstructionBreakpoint(...args: unknown[]) {
		return this.#result("removeInstructionBreakpoint", args);
	}
	async dataBreakpointInfo(...args: unknown[]) {
		return this.#result("dataBreakpointInfo", args);
	}
	async setDataBreakpoint(...args: unknown[]) {
		return this.#result("setDataBreakpoint", args);
	}
	async removeDataBreakpoint(...args: unknown[]) {
		return this.#result("removeDataBreakpoint", args);
	}
	async continue(...args: unknown[]) {
		return this.#result("continue", args);
	}
	async pause(...args: unknown[]) {
		return this.#result("pause", args);
	}
	async stepOver(...args: unknown[]) {
		return this.#result("stepOver", args);
	}
	async stepIn(...args: unknown[]) {
		return this.#result("stepIn", args);
	}
	async stepOut(...args: unknown[]) {
		return this.#result("stepOut", args);
	}
	async threads(...args: unknown[]) {
		return this.#result("threads", args);
	}
	async stackTrace(...args: unknown[]) {
		return this.#result("stackTrace", args);
	}
	async scopes(...args: unknown[]) {
		return this.#result("scopes", args);
	}
	async variables(...args: unknown[]) {
		return this.#result("variables", args);
	}
	async evaluate(...args: unknown[]) {
		return this.#result("evaluate", args);
	}
	getOutput(...args: unknown[]) {
		return this.#result("getOutput", args);
	}
	async disassemble(...args: unknown[]) {
		return this.#result("disassemble", args);
	}
	async readMemory(...args: unknown[]) {
		return this.#result("readMemory", args);
	}
	async writeMemory(...args: unknown[]) {
		return this.#result("writeMemory", args);
	}
	async modules(...args: unknown[]) {
		return this.#result("modules", args);
	}
	async loadedSources(...args: unknown[]) {
		return this.#result("loadedSources", args);
	}
	async terminate(...args: unknown[]) {
		return this.#result("terminate", args);
	}
	async dispose() {
		this.#result("dispose", []);
	}
}

const adapter: DapResolvedAdapter = {
	name: "fake",
	command: "fake-dap",
	args: [],
	resolvedCommand: "/fake-dap",
	languages: ["typescript"],
	fileTypes: [".ts"],
	rootMarkers: [],
	launchDefaults: {},
	attachDefaults: {},
	connectMode: "stdio",
	acceptsDirectoryProgram: false,
};

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-debug-"));
	temporaryRoots.push(root);
	const manager = new FakeDebugManager();
	const progress: string[] = [];
	const service = new IpythonDebugService({
		cwd: () => root,
		manager,
		availableAdapters: () => [adapter],
		launchAdapter: () => ({ kind: "adapter", adapter }),
		attachAdapter: () => adapter,
	});
	const call = async (
		operation: string,
		data: Record<string, unknown> = {},
		signal: AbortSignal = new AbortController().signal,
	) => {
		const handler = service.handlers[operation];
		if (!handler) throw new Error(`missing handler ${operation}`);
		const request: IpythonHostRequest = {
			requestId: "execution-1",
			executionId: "execution-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { ...data, type: operation },
			signal,
			sessionId: "session-1",
			cwd: root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async message => {
				progress.push(message);
			},
			publishDisplay: async () => {},
			allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { root, manager, progress, service, call };
}

describe("IPython debug service", () => {
	test("launches and mutates one session-private DAP owner with canonical workspace paths", async () => {
		const f = await fixture();
		await fs.mkdir(path.join(f.root, "src"));
		await fs.writeFile(path.join(f.root, "src", "main.ts"), "debugger;\n");
		expect(await f.call("debug.adapters")).toEqual({
			items: [{ name: "fake", command: "fake-dap", file_types: [".ts"], root_markers: [] }],
		});
		expect(await f.call("debug.launch", { program: "src/main.ts", args: ["one"], timeout: 5 })).toEqual({
			operation: "launch",
		});
		expect(await f.call("debug.set_breakpoint", { file: "src/main.ts", line: 1, timeout: 5 })).toEqual({
			operation: "setBreakpoint",
		});
		const launch = f.manager.calls.find(call => call.operation === "launch");
		expect(launch?.args[0]).toMatchObject({ program: path.join(await fs.realpath(f.root), "src/main.ts") });
		const breakpoint = f.manager.calls.find(call => call.operation === "setBreakpoint");
		expect(breakpoint?.args.slice(0, 2)).toEqual([path.join(await fs.realpath(f.root), "src/main.ts"), 1]);
		expect(f.progress).toEqual(
			expect.arrayContaining(["Debug operation started: launch", "Debug operation completed: set breakpoint"]),
		);
		await expect(f.call("debug.set_breakpoint", { file: "../outside.ts", line: 1 })).rejects.toThrow();
		await expect(f.call("debug.attach", { adapter: "fake" })).rejects.toThrow("attach requires pid or port");
		await expect(f.call("debug.read_memory", { memory_reference: "0x1", count: 4 })).rejects.toThrow(
			"Current adapter does not support memory reads",
		);
		const unavailable = new IpythonDebugService({
			cwd: () => f.root,
			manager: f.manager,
			availableAdapters: () => [],
			launchAdapter: () => ({ kind: "unavailable", adapterName: "debugpy", command: "python" }),
			attachAdapter: () => null,
		});
		const handler = unavailable.handlers["debug.launch"];
		expect(handler).toBeDefined();
		await expect(
			handler?.({
				requestId: "execution-2",
				executionId: "execution-2",
				commId: "comm-2",
				targetName: "host.request",
				data: { type: "debug.launch", program: "src/main.ts" },
				signal: new AbortController().signal,
				sessionId: "session-1",
				cwd: f.root,
				cellId: "cell-2",
				sequence: 2,
				origin: "model",
				authority: "trusted-cell",
				publishProgress: async () => {},
				publishDisplay: async () => {},
				allocateArtifact: async artifact => ({ path: path.join(f.root, `unavailable${artifact.suffix}`) }),
			}),
		).rejects.toThrow("python not found in PATH");
	});

	test("forwards cell cancellation, bounds input, spills large results, and disposes once", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort(new Error("cell cancelled"));
		await expect(f.call("debug.continue", {}, controller.signal)).rejects.toThrow("cell cancelled");
		await expect(f.call("debug.variables", { variable_ref: -1 })).rejects.toThrow("variable_ref");
		await expect(f.call("debug.pause", { raw: true })).rejects.toThrow("unknown field");

		f.manager.largeVariables = true;
		const spilled = await f.call("debug.variables", { variable_ref: 7 });
		const artifact = spilled.artifact as { path: string; mime_type: string };
		expect(spilled.truncated).toBe(true);
		expect(artifact.mime_type).toBe("application/json");
		expect((await fs.stat(artifact.path)).size).toBeGreaterThan(1024 * 1024);

		await f.service.suspend();
		expect(f.manager.calls.filter(call => call.operation === "terminate")).toHaveLength(1);
		await Promise.all([f.service.dispose(), f.service.dispose()]);
		expect(f.manager.calls.filter(call => call.operation === "dispose")).toHaveLength(1);
	});
});

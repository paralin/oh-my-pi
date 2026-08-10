import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createIpythonCodeHostHandlers, type IpythonLspOwner } from "../../src/ipython/code-service.js";
import type { IpythonDisplayEvent, IpythonHostRequest } from "../../src/ipython/controller.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(lsp?: IpythonLspOwner) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-code-"));
	temporaryRoots.push(root);
	const displays: IpythonDisplayEvent[] = [];
	const progress: Array<{ message: string; data: Readonly<Record<string, unknown>> }> = [];
	const handlers = createIpythonCodeHostHandlers({ cwd: root, lsp });
	const call = async (
		operation: string,
		data: Record<string, unknown> = {},
		signal: AbortSignal = new AbortController().signal,
	) => {
		const handler = handlers[operation];
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
			publishProgress: async (message, progressData = {}) => {
				progress.push({ message, data: progressData });
			},
			publishDisplay: async display => {
				displays.push({ ...display, kind: "display" });
			},
			allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { root, displays, progress, call };
}

describe("IPython code service", () => {
	test("dispatches explicit LSP operations through the reusable owner with cell cancellation", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const lsp: IpythonLspOwner = {
			status: () => ({ configured: ["typescript"], active: [] }),
			query: async (input, signal) => {
				calls.push({ ...input, aborted: signal.aborted });
				return { action: input.action, locations: [{ path: "src/target.ts" }] };
			},
		};
		const f = await fixture(lsp);
		const status = await f.call("code.lsp_status");
		expect(status).toEqual({ configured: ["typescript"], active: [] });
		const definition = await f.call("code.definition", {
			file: "src/source.ts",
			line: 7,
			symbol: "target",
		});
		expect(definition).toEqual({ action: "definition", locations: [{ path: "src/target.ts" }] });
		expect(calls).toEqual([
			{
				action: "definition",
				file: "src/source.ts",
				line: 7,
				symbol: "target",
				apply: false,
				aborted: false,
			},
		]);
		expect(f.progress.map(item => item.message)).toEqual([
			"Querying language server: definition",
			"Language server completed: definition",
		]);
		await expect(f.call("code.hover", { file: "src/source.ts", payload: "raw" })).rejects.toThrow("unknown field");
	});
});

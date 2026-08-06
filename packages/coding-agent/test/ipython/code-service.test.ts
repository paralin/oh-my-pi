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
	const handlers = createIpythonCodeHostHandlers({ cwd: root, snapshotOwner: {}, lsp });
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

describe("IPython file and code services", () => {
	test("reads, writes, and globs bounded workspace files with snapshot and diff details", async () => {
		const f = await fixture();
		await fs.mkdir(path.join(f.root, "src"));
		await fs.writeFile(path.join(f.root, "src", "one.ts"), "first\nsecond\nthird\n");
		await fs.writeFile(path.join(f.root, "src", "two.js"), "export {};\n");

		const read = await f.call("files.read", { path: "src/one.ts", offset: 2, limit: 1 });
		expect(read).toMatchObject({ path: "src/one.ts", content: "second", offset: 2, lines: 1, truncated: true });
		expect(String(read.snapshot)).toMatch(/^\[src\/one\.ts#[0-9A-F]{4}\]$/);

		const created = await f.call("files.write", { path: "created.txt", content: "hello\n" });
		expect(created).toMatchObject({ path: "created.txt", created: true, bytes: 6 });
		expect(await fs.readFile(path.join(f.root, "created.txt"), "utf8")).toBe("hello\n");
		await expect(f.call("files.write", { path: "created.txt", content: "replaced\n" })).rejects.toThrow(
			"pass overwrite=True",
		);
		await f.call("files.write", { path: "created.txt", content: "replaced\n", overwrite: true });
		expect(await fs.readFile(path.join(f.root, "created.txt"), "utf8")).toBe("replaced\n");
		expect(f.displays).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({ "application/vnd.omp.diff+json": expect.any(Object) }),
				}),
			]),
		);

		const glob = await f.call("files.glob", { pattern: "**/*.ts", path: ".", limit: 10 });
		expect(glob).toMatchObject({ entries: [{ path: "src/one.ts" }], count: 1, truncated: false });
		await expect(f.call("files.read", { path: "../outside" })).rejects.toThrow();
	});

	test("spills oversized file output through the cell artifact owner", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "large.txt"), "x".repeat(1024 * 1024 + 100));
		const result = await f.call("files.read", { path: "large.txt", limit: 1 });
		const artifact = result.artifact as { path: string; mime_type: string; bytes: number };
		expect(result).toMatchObject({ path: "large.txt", truncated: true });
		expect(artifact).toMatchObject({ mime_type: "text/plain", bytes: 1024 * 1024 + 100 });
		expect((await fs.stat(artifact.path)).size).toBe(1024 * 1024 + 100);
	});

	test("returns structured AST matches and previews or applies one bounded rewrite", async () => {
		const f = await fixture();
		await fs.mkdir(path.join(f.root, "src"));
		const source = path.join(f.root, "src", "example.ts");
		await fs.writeFile(source, "export function run(value: string) { console.log(value); }\n");

		const search = await f.call("code.ast_search", {
			pattern: "console.log($$$ARGS)",
			path: ".",
			glob: "**/*.ts",
		});
		expect(search).toMatchObject({
			matches: [expect.objectContaining({ path: "src/example.ts", text: "console.log(value)" })],
			total_matches: 1,
			files_with_matches: 1,
		});

		const operation = [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }];
		const preview = await f.call("code.ast_edit", {
			operations: operation,
			path: ".",
			glob: "**/*.ts",
		});
		expect(preview).toMatchObject({ applied: false, total_replacements: 1, files_touched: 1 });
		expect(await fs.readFile(source, "utf8")).toContain("console.log(value)");

		const applied = await f.call("code.ast_edit", {
			operations: operation,
			path: ".",
			glob: "**/*.ts",
			apply: true,
		});
		expect(applied).toMatchObject({ applied: true, total_replacements: 1, files_touched: 1 });
		expect(await fs.readFile(source, "utf8")).toContain("logger.info(value)");
		expect(f.progress.map(item => item.message)).toEqual(
			expect.arrayContaining(["Searching syntax trees", "Previewed syntax rewrite", "Applied syntax rewrite"]),
		);
		expect(f.displays.at(-1)?.data["application/vnd.omp.diff+json"]).toMatchObject({ applied: true });
	});

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

	test("propagates an already-aborted cell signal into native code operations", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "example.ts"), "console.log('x');\n");
		const controller = new AbortController();
		controller.abort(new Error("cancelled cell"));
		await expect(
			f.call("code.ast_search", { pattern: "console.log($$$ARGS)", path: "." }, controller.signal),
		).rejects.toThrow();
	});
});

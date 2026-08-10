import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createIpythonAstHostHandlers } from "../../src/ipython/ast-service.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-ast-"));
	temporaryRoots.push(root);
	const progress: Array<{ message: string; data: Readonly<Record<string, unknown>> }> = [];
	const handlers = createIpythonAstHostHandlers({ cwd: root });
	const call = async (operation: string, data: Record<string, unknown> = {}) => {
		const handler = handlers[operation];
		if (!handler) throw new Error(`missing handler ${operation}`);
		const request: IpythonHostRequest = {
			requestId: "execution-1",
			executionId: "execution-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { ...data, type: operation },
			signal: new AbortController().signal,
			sessionId: "session-1",
			cwd: root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async (message, eventData = {}) => {
				progress.push({ message, data: eventData });
			},
			publishDisplay: async () => {},
			allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { root, progress, call };
}

describe("IPython structural AST service", () => {
	test("searches and rewrites TypeScript and Python without matching comments or strings", async () => {
		const f = await fixture();
		await fs.writeFile(
			path.join(f.root, "fixture.ts"),
			'const selected = console.log(1);\n// console.log("unrelated")\nconst literal = "console.log(2)";\n',
		);
		await fs.writeFile(
			path.join(f.root, "fixture.py"),
			'selected = print(1)\n# print("unrelated")\nliteral = "print(2)"\n',
		);

		const typescript = await f.call("ast.search", {
			path: "fixture.ts",
			patterns: ["console.log($$$ARGS)"],
			language: "typescript",
			include_meta: true,
		});
		const python = await f.call("ast.search", {
			path: "fixture.py",
			patterns: ["print($$$ARGS)"],
			language: "python",
			include_meta: true,
		});
		expect(typescript).toMatchObject({ totalMatches: 1, matches: [{ text: "console.log(1)" }] });
		expect(python).toMatchObject({ totalMatches: 1, matches: [{ text: "print(1)" }] });

		const preview = await f.call("ast.rewrite", {
			path: "fixture.ts",
			rewrites: { "console.log($$$ARGS)": "logger.info($$$ARGS)" },
			language: "typescript",
		});
		expect(preview).toMatchObject({ applied: false, totalReplacements: 1 });
		expect(await fs.readFile(path.join(f.root, "fixture.ts"), "utf8")).toContain("console.log(1)");

		const typescriptRewrite = await f.call("ast.rewrite", {
			path: "fixture.ts",
			rewrites: { "console.log($$$ARGS)": "logger.info($$$ARGS)" },
			language: "typescript",
			dry_run: false,
		});
		const pythonRewrite = await f.call("ast.rewrite", {
			path: "fixture.py",
			rewrites: { "print($$$ARGS)": "logger.info($$$ARGS)" },
			language: "python",
			dry_run: false,
		});
		expect(typescriptRewrite).toMatchObject({ applied: true, totalReplacements: 1 });
		expect(pythonRewrite).toMatchObject({ applied: true, totalReplacements: 1 });
		expect(await fs.readFile(path.join(f.root, "fixture.ts"), "utf8")).toBe(
			'const selected = logger.info(1);\n// console.log("unrelated")\nconst literal = "console.log(2)";\n',
		);
		expect(await fs.readFile(path.join(f.root, "fixture.py"), "utf8")).toBe(
			'selected = logger.info(1)\n# print("unrelated")\nliteral = "print(2)"\n',
		);
		expect(f.progress.map(item => item.message)).toEqual([
			"Searching syntax trees",
			"Syntax-tree search completed",
			"Searching syntax trees",
			"Syntax-tree search completed",
			"Rewriting syntax trees",
			"Syntax-tree rewrite completed",
			"Rewriting syntax trees",
			"Syntax-tree rewrite completed",
			"Rewriting syntax trees",
			"Syntax-tree rewrite completed",
		]);
	});

	test("rejects paths outside the active workspace and unknown fields", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.root, "fixture.ts"), "console.log(1);\n");
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-ast-outside-"));
		temporaryRoots.push(outside);
		const outsideFile = path.join(outside, "outside.ts");
		await fs.writeFile(outsideFile, "console.log(1);\n");
		await expect(f.call("ast.search", { path: outsideFile, patterns: ["console.log($A)"] })).rejects.toThrow(
			"outside the active workspace",
		);
		await expect(
			f.call("ast.search", { path: "fixture.ts", patterns: ["console.log($A)"], unexpected: true }),
		).rejects.toThrow("unknown field");
	});
});

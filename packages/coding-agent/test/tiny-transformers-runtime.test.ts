import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	acquireTinyRuntimeInstallLock,
	compiledTransformersEntrypoint,
	createRuntimeInstallCommand,
	patchCompiledRuntimeRequires,
	resolveTransformersVersionSpecFromManifest,
	rewriteCompiledRuntimeRequires,
} from "../src/tiny/worker";

const TRANSFORMERS_PACKAGE = "@huggingface/transformers";

describe("resolveTransformersVersionSpecFromManifest", () => {
	it("uses the compiled catalog spec without resolving source node_modules", () => {
		let installedVersionRead = false;
		const spec = resolveTransformersVersionSpecFromManifest(
			{ optionalDependencies: { [TRANSFORMERS_PACKAGE]: "catalog:" } },
			"^4.2.0",
			() => {
				installedVersionRead = true;
				return "4.2.0";
			},
		);

		expect(spec).toBe("^4.2.0");
		expect(installedVersionRead).toBe(false);
	});

	it("falls back to the installed package version for source catalog deps", () => {
		const spec = resolveTransformersVersionSpecFromManifest(
			{ optionalDependencies: { [TRANSFORMERS_PACKAGE]: "catalog:" } },
			undefined,
			() => "4.2.0",
		);

		expect(spec).toBe("4.2.0");
	});

	it("keeps explicit semver specs unchanged", () => {
		const spec = resolveTransformersVersionSpecFromManifest(
			{ dependencies: { [TRANSFORMERS_PACKAGE]: "4.2.0" } },
			"^4.2.0",
			() => "4.3.0",
		);

		expect(spec).toBe("4.2.0");
	});
});

describe("compiledTransformersEntrypoint", () => {
	it("targets the installed CommonJS entrypoint without package-name resolution", () => {
		expect(compiledTransformersEntrypoint("/tmp/omp-runtime")).toBe(
			path.join("/tmp/omp-runtime", "node_modules", "@huggingface", "transformers", "dist", "transformers.node.cjs"),
		);
	});
});

describe("rewriteCompiledRuntimeRequires", () => {
	it("rewrites runtime dependency requires to absolute entrypoints", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-runtime-"));
		const packages = {
			"onnxruntime-node": "dist/index.js",
			"onnxruntime-common": "dist/cjs/index.js",
			sharp: "lib/index.js",
		};

		try {
			for (const [name, main] of Object.entries(packages)) {
				const packageDir = path.join(tmpDir, "node_modules", name);
				await fs.mkdir(packageDir, { recursive: true });
				await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ main }));
			}

			const rewritten = rewriteCompiledRuntimeRequires(
				`const fs = require("fs"); const ort = require("onnxruntime-node"); const common = require("onnxruntime-common"); const sharp = require("sharp"); const oldSharp = require(${JSON.stringify(path.join(tmpDir, "node_modules", "sharp", "lib", "index.js"))});`,
				tmpDir,
			);

			expect(rewritten).toContain(
				`require(${JSON.stringify(path.join(tmpDir, "node_modules", "onnxruntime-node", "dist", "index.js"))})`,
			);
			expect(rewritten).toContain(
				`require(${JSON.stringify(path.join(tmpDir, "node_modules", "onnxruntime-common", "dist", "cjs", "index.js"))})`,
			);
			expect(rewritten).toContain(`require(${JSON.stringify(path.join(tmpDir, "omp-sharp-stub.cjs"))})`);
			expect(rewritten).not.toContain(path.join("node_modules", "sharp", "lib", "index.js"));
			expect(rewritten).toContain('require("fs")');
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("createRuntimeInstallCommand", () => {
	it("runs bun install from the runtime directory instead of the parent workspace", () => {
		const command = createRuntimeInstallCommand("/tmp/omp-runtime", { PATH: "/bin" });
		expect(command.cmd).toEqual([process.execPath, "install", "--production", "--force", "--backend=copyfile"]);
		expect(command.cwd).toBe("/tmp/omp-runtime");
		expect(command.env).toMatchObject({ PATH: "/bin", BUN_BE_BUN: "1" });
		expect(command.cmd).not.toContain("--cwd");
	});
});

describe("acquireTinyRuntimeInstallLock", () => {
	it("creates the runtime parent directory before acquiring the lock", async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-runtime-"));
		const runtimeDir = path.join(tmpDir, "cache", "tiny-title-runtime", "transformers-test");
		const lockDir = `${runtimeDir}.lock`;
		const release = await acquireTinyRuntimeInstallLock(runtimeDir);

		try {
			const stats = await fs.stat(lockDir);
			expect(stats.isDirectory()).toBe(true);
		} finally {
			await release();
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});
});

describe("patchCompiledRuntimeRequires", () => {
	it("rewrites bare runtime requires recursively under installed dist directories", async () => {
		const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tiny-runtime-"));

		const layout: Record<string, { main: string; files: Record<string, string> }> = {
			"@huggingface/transformers": {
				main: "dist/transformers.node.cjs",
				files: { "dist/transformers.node.cjs": 'require("onnxruntime-node"); require("sharp");' },
			},
			"onnxruntime-node": {
				main: "dist/index.js",
				files: {
					"dist/index.js": 'require("./backend"); require("onnxruntime-common");',
					"dist/backend.js": 'require("./binding"); require("onnxruntime-common");',
					"dist/binding.js": 'require("onnxruntime-common");',
				},
			},
			"onnxruntime-common": { main: "dist/cjs/index.js", files: { "dist/cjs/index.js": "" } },
			sharp: { main: "lib/index.js", files: { "lib/index.js": "" } },
		};

		try {
			for (const [name, pkg] of Object.entries(layout)) {
				const packageDir = path.join(runtimeDir, "node_modules", ...name.split("/"));
				await fs.mkdir(packageDir, { recursive: true });
				await Bun.write(path.join(packageDir, "package.json"), JSON.stringify({ main: pkg.main }));
				for (const [relativePath, contents] of Object.entries(pkg.files)) {
					const filePath = path.join(packageDir, relativePath);
					await fs.mkdir(path.dirname(filePath), { recursive: true });
					await Bun.write(filePath, contents);
				}
			}

			await patchCompiledRuntimeRequires(runtimeDir);

			const backend = await Bun.file(
				path.join(runtimeDir, "node_modules", "onnxruntime-node", "dist", "backend.js"),
			).text();
			expect(backend).toContain(
				`require(${JSON.stringify(path.join(runtimeDir, "node_modules", "onnxruntime-common", "dist", "cjs", "index.js"))})`,
			);
			expect(backend).not.toContain('require("onnxruntime-common")');
		} finally {
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	});
});

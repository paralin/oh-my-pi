import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Skill } from "../../src/extensibility/skills.js";
import { createIpythonAstHostHandlers } from "../../src/ipython/ast-service.js";
import { IpythonController } from "../../src/ipython/controller.js";
import { ipythonBootstrapEnvironment, ipythonEnvironment } from "../../src/ipython/environment.js";
import { IPYTHON_PYTHON_ASSETS, ipythonPythonAssetHash } from "../../src/ipython/python-assets.js";
import type { PythonSkillPackage } from "../../src/ipython/python-packages.js";
import { resolvePythonSkillPackages } from "../../src/ipython/python-packages.js";
import {
	ensureIpythonRuntime,
	IPYTHON_RUNTIME_PACKAGES,
	normalizePythonProjectName,
	runtimePythonPackageIdentity,
	runtimePythonPackageMarkerText,
	stagePythonPackageInventory,
	validatePythonPackageExport,
} from "../../src/ipython/runtime-bootstrap.js";

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

async function runPython(
	pythonExecutable: string,
	environment: Readonly<Record<string, string>>,
	code: string,
): Promise<string> {
	const child = Bun.spawn([pythonExecutable, "-I", "-c", code], {
		env: { ...environment },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`Python exited with ${exitCode}: ${stderr}`);
	return stdout.trim();
}

function packageIdentity(importName: string, projectName: string, contentHash: string): PythonSkillPackage {
	return {
		importName,
		callableName: "run",
		projectName,
		packageRoot: "/tmp/package",
		sourceRoot: "/tmp/package/src",
		skillPath: "/tmp/package/SKILL.md",
		files: [],
		contentHash,
		skill: {
			name: importName,
			description: "test",
			filePath: "/tmp/package/SKILL.md",
			baseDir: "/tmp/package",
			source: "test",
		},
	};
}

describe("IPython runtime environment", () => {
	test("builds ordered normalized package identity and exact marker text", () => {
		const packages = [packageIdentity("z_pkg", "Z.pkg", "hash-z"), packageIdentity("a_pkg", "A_pkg", "hash-a")];
		expect(normalizePythonProjectName(" Z_pkg ")).toBe("z-pkg");
		expect(runtimePythonPackageIdentity(packages)).toBe(
			JSON.stringify([
				{ importName: "z_pkg", projectName: "z-pkg", contentHash: "hash-z" },
				{ importName: "a_pkg", projectName: "a-pkg", contentHash: "hash-a" },
			]),
		);
		expect(runtimePythonPackageMarkerText(packages)).toBe(`${runtimePythonPackageIdentity(packages)}\n`);
	});

	test("rejects unsafe exported local and editable requirements", () => {
		const safe = "dill==0.4.1 --hash=sha256:abc\n--hash=sha256:def\n";
		expect(() => validatePythonPackageExport(safe, "safe_pkg")).not.toThrow();
		for (const requirement of ["-e .", "--editable .", "pkg @ file:///tmp/pkg", "file:///tmp/pkg", "../pkg"]) {
			expect(() => validatePythonPackageExport(requirement, "unsafe_pkg")).toThrow("local/editable/file");
		}
		for (const requirement of [
			"--index-url https://pypi.org/simple",
			"--find-links /tmp",
			"git+https://example.invalid/pkg.git",
			"pkg @ https://example.invalid/pkg.whl",
		]) {
			expect(() => validatePythonPackageExport(requirement, "unsafe_pkg")).toThrow();
		}
	});

	test("stages the recorded inventory and rejects mutable source changes", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-python-stage-"));
		try {
			const packageRoot = path.join(root, "package");
			const sourceRoot = path.join(packageRoot, "src", "stage_pkg");
			await fs.mkdir(sourceRoot, { recursive: true });
			await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: stage\ndescription: stage\n---\n");
			await fs.writeFile(path.join(packageRoot, "pyproject.toml"), '[project]\nname = "stage-pkg"\n');
			await fs.writeFile(path.join(packageRoot, "uv.lock"), "version = 1\n");
			await fs.writeFile(path.join(sourceRoot, "__init__.py"), "VALUE = 1\n");
			const skill = {
				name: "stage",
				description: "stage",
				filePath: path.join(packageRoot, "SKILL.md"),
				baseDir: packageRoot,
				source: "test",
				pythonImport: "stage_pkg",
				pythonCallable: "run",
				pythonPath: path.join(packageRoot, "src"),
			};
			const resolved = await resolvePythonSkillPackages([skill]);
			const pkg = resolved.packages[0];
			if (!pkg) throw new Error("package did not resolve");
			const staged = await stagePythonPackageInventory(path.join(root, "runtime"), [pkg]);
			expect(await fs.readFile(path.join(staged[0]!, "stage_pkg", "__init__.py"), "utf8")).toBe("VALUE = 1\n");
			await fs.writeFile(path.join(sourceRoot, "__init__.py"), "VALUE = 2\n");
			await expect(stagePythonPackageInventory(path.join(root, "runtime"), [pkg])).rejects.toThrow(
				"content changed",
			);
			expect(await fs.readFile(path.join(staged[0]!, "stage_pkg", "__init__.py"), "utf8")).toBe("VALUE = 1\n");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("passes ordinary context without ambient credentials or execution injection", () => {
		const environment = ipythonEnvironment({
			HOME: "/safe/home",
			PATH: "/safe/bin",
			LANG: "en_US.UTF-8",
			LC_TEST: "ordinary",
			LC_API_KEY: "secret through allowed prefix",
			XDG_CACHE_HOME: "/safe/cache",
			OMP_SESSION_ID: "session-1",
			OMP_IPYTHON_RUNTIME_PATH: "/runtime/python",
			OMP_AUTH_BROKER_TOKEN: "broker-secret",
			OMP_UNPLANNED_VALUE: "not allowlisted",
			PI_API_KEY: "legacy-provider-secret",
			ANTHROPIC_API_KEY: "provider-secret",
			SSH_AUTH_SOCK: "/credential/socket",
			PYTHONPATH: "/injected/python",
			PYTHONHOME: "/injected/home",
			VIRTUAL_ENV: "/ambient/venv",
			CONDA_PREFIX: "/ambient/conda",
			LD_PRELOAD: "/injected/library.so",
			DYLD_INSERT_LIBRARIES: "/injected/library.dylib",
			UV_INDEX_URL: "https://credential@example.invalid/simple",
			HTTPS_PROXY: "https://credential@example.invalid",
		});

		expect(environment).toMatchObject({
			HOME: "/safe/home",
			PATH: "/safe/bin",
			LANG: "en_US.UTF-8",
			LC_TEST: "ordinary",
			XDG_CACHE_HOME: "/safe/cache",
			OMP_SESSION_ID: "session-1",
			OMP_IPYTHON_RUNTIME_PATH: "/runtime/python",
			PYTHONDONTWRITEBYTECODE: "1",
			PYTHONIOENCODING: "utf-8",
			PYTHONNOUSERSITE: "1",
			PYTHONUNBUFFERED: "1",
			PYTHONUTF8: "1",
		});
		for (const key of [
			"LC_API_KEY",
			"OMP_AUTH_BROKER_TOKEN",
			"OMP_UNPLANNED_VALUE",
			"PI_API_KEY",
			"ANTHROPIC_API_KEY",
			"SSH_AUTH_SOCK",
			"PYTHONPATH",
			"PYTHONHOME",
			"VIRTUAL_ENV",
			"CONDA_PREFIX",
			"LD_PRELOAD",
			"DYLD_INSERT_LIBRARIES",
			"UV_INDEX_URL",
			"HTTPS_PROXY",
		]) {
			expect(environment).not.toHaveProperty(key);
		}

		const bootstrap = ipythonBootstrapEnvironment("/runtime", {
			PATH: "/safe/bin",
			OMP_SESSION_ID: "must-not-reach-bootstrap",
			OMP_SESSION_CWD: "/session/cwd",
			OMP_SESSION_ARTIFACT_DIR: "/session/sidecar",
			OMP_IPYTHON_RUNTIME_PATH: "/runtime/injection",
			HTTPS_PROXY: "https://credential@example.invalid",
			UV_INDEX_URL: "https://credential@example.invalid/simple",
		});
		expect(bootstrap).toMatchObject({
			PATH: "/safe/bin",
			UV_CACHE_DIR: path.join("/runtime", "uv-cache"),
			UV_DEFAULT_INDEX: "https://pypi.org/simple",
			UV_KEYRING_PROVIDER: "disabled",
			UV_NO_CONFIG: "1",
			UV_PYTHON_INSTALL_DIR: path.join("/runtime", "python"),
		});
		expect(bootstrap).not.toHaveProperty("OMP_SESSION_ID");
		expect(bootstrap).not.toHaveProperty("OMP_SESSION_CWD");
		expect(bootstrap).not.toHaveProperty("OMP_SESSION_ARTIFACT_DIR");
		expect(bootstrap).not.toHaveProperty("OMP_IPYTHON_RUNTIME_PATH");
		expect(bootstrap).not.toHaveProperty("HTTPS_PROXY");
		expect(bootstrap).not.toHaveProperty("UV_INDEX_URL");
	});

	test("bundles one source-hashed callable RLM, OMP index, and focused Python skill tree", () => {
		const paths = IPYTHON_PYTHON_ASSETS.map(asset => asset.path);
		expect(new Set(paths).size).toBe(paths.length);
		for (const required of [
			"rlm/__init__.py",
			"rlm/_act.py",
			"rlm/harness.py",
			"rlm/mcp_base.py",
			"omp/__init__.py",
			"omp/ast.py",
			"omp/ask.py",
			"omp/autoresearch.py",
			"omp/browser.py",
			"omp/computer.py",
			"omp/cron.py",
			"omp/lsp.py",
			"omp/images.py",
			"omp/long_term_memory.py",
			"omp/qa.py",
			"omp/process.py",
			"omp/security.py",
			"omp/tts.py",
			"omp/vibe.py",
			"agent_message/__init__.py",
			"agent_observe/__init__.py",
			"attach_image/__init__.py",
			"compact/__init__.py",
			"edit/__init__.py",
			"goal/__init__.py",
			"refine/__init__.py",
			"rlm_heartbeat/__init__.py",
			"websearch/__init__.py",
			"websearch/websearch.py",
			"linear/__init__.py",
			"notion/__init__.py",
		]) {
			expect(paths).toContain(required);
		}
		for (const skill of [
			"agent-message",
			"agent-observe",
			"attach-image",
			"compact",
			"edit",
			"goal",
			"refine",
			"rlm-heartbeat",
			"websearch",
			"linear",
			"notion",
		]) {
			const metadata = IPYTHON_PYTHON_ASSETS.find(asset => asset.path === `skills/${skill}/SKILL.md`);
			expect(metadata?.content).toContain("type: python");
			expect(metadata?.content).toContain("python_import:");
			expect(metadata?.content).toContain("python_callable:");
			expect(paths).toContain(`skills/${skill}/pyproject.toml`);
		}
		expect(ipythonPythonAssetHash()).toMatch(/^[a-f0-9]{64}$/);
		const notice = IPYTHON_PYTHON_ASSETS.find(asset => asset.path === "NOTICE");
		expect(notice?.content).toContain("Copyright (c) 2025 Mario Zechner");
		expect(notice?.content).toContain("Permission is hereby granted, free of charge");
	});
});

describeIntegration("IPython managed runtime bootstrap", () => {
	test("creates one locked environment and reuses it without uv", async () => {
		const uvExecutable = Bun.env.OMP_IPYTHON_TEST_UV;
		if (!uvExecutable) throw new Error("OMP_IPYTHON_TEST_UV is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-runtime-"));
		const runtimeRoot = path.join(tempRoot, "runtime");
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		const environment = {
			HOME: home,
			LANG: "C.UTF-8",
			PATH: `${path.dirname(uvExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			ANTHROPIC_API_KEY: "must-not-reach-python",
			PYTHONPATH: "/must/not/reach/python",
		};
		let controller: IpythonController | undefined;
		try {
			const soleAbort = new AbortController();
			const soleStarted = Promise.withResolvers<void>();
			const sole = ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable,
				environment,
				cacheKeyParts: ["sole-cancellation"],
				signal: soleAbort.signal,
				onProgress: message => {
					if (message.startsWith("Setting up")) soleStarted.resolve();
				},
			});
			await soleStarted.promise;
			soleAbort.abort(new Error("cancel sole bootstrap waiter"));
			await expect(sole).rejects.toThrow("cancel sole bootstrap waiter");
			const recovered = await ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable,
				environment,
				cacheKeyParts: ["sole-cancellation"],
			});
			expect(await runPython(recovered.pythonExecutable, recovered.environment, "print(6 * 7)")).toBe("42");

			const firstAbort = new AbortController();
			const setupStarted = Promise.withResolvers<string>();
			const cancelledProgress: string[] = [];
			const survivorProgress: string[] = [];
			const cancelled = ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable,
				environment,
				signal: firstAbort.signal,
				onProgress: message => {
					cancelledProgress.push(message);
					if (message.startsWith("Setting up")) setupStarted.resolve(message);
				},
			});
			const surviving = ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable,
				environment: { ...environment, OMP_SESSION_ID: "concurrent-session" },
				onProgress: message => survivorProgress.push(message),
			});
			const activeProgress = await setupStarted.promise;
			expect(cancelledProgress).toContain(activeProgress);
			expect(survivorProgress).toContain(activeProgress);
			const replayedProgress: string[] = [];
			const late = ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable,
				environment: { ...environment, OMP_SESSION_ID: "late-session" },
				onProgress: message => replayedProgress.push(message),
			});
			expect(replayedProgress.at(-1)).toBe(activeProgress);
			firstAbort.abort(new Error("cancel first bootstrap waiter"));
			await expect(cancelled).rejects.toThrow("cancel first bootstrap waiter");
			const [concurrent, lateRuntime] = await Promise.all([surviving, late]);
			expect(lateRuntime.pythonExecutable).toBe(concurrent.pythonExecutable);
			expect(survivorProgress.at(-1)).toBe("IPython runtime ready");
			expect(replayedProgress.at(-1)).toBe("IPython runtime ready");

			const first = await ensureIpythonRuntime({ runtimeRoot, uvExecutable, environment });
			expect(concurrent.pythonExecutable).toBe(first.pythonExecutable);
			expect(concurrent.runtimeDir).toBe(first.runtimeDir);
			expect(first.environment).not.toHaveProperty("OMP_SESSION_ID");
			expect(concurrent.environment.OMP_SESSION_ID).toBe("concurrent-session");
			expect(first.environment.OMP_IPYTHON_RUNTIME_PATH).toBe(first.pythonPackageDir);
			expect(first.environment).not.toHaveProperty("PYTHONPATH");

			const versions = await runPython(
				first.pythonExecutable,
				first.environment,
				"import importlib.metadata as m, json, os; print(json.dumps({name: m.version(name) for name in ['dill', 'ipykernel', 'jupyter-client', 'pillow', 'pyzmq']})); assert 'ANTHROPIC_API_KEY' not in os.environ; assert 'PYTHONPATH' not in os.environ",
			);
			expect(JSON.parse(versions)).toEqual(IPYTHON_RUNTIME_PACKAGES);

			const typescriptFixture = path.join(tempRoot, "fixture.ts");
			const pythonFixture = path.join(tempRoot, "fixture.py");
			await fs.writeFile(
				typescriptFixture,
				'const selected = console.log(1);\n// console.log("unrelated")\nconst literal = "console.log(2)";\n',
			);
			await fs.writeFile(pythonFixture, 'selected = print(1)\n# print("unrelated")\nliteral = "print(2)"\n');

			controller = new IpythonController({
				pythonExecutable: first.pythonExecutable,
				cwd: tempRoot,
				env: first.environment,
				hostHandlers: createIpythonAstHostHandlers({ cwd: tempRoot }),
			});
			await controller.start();
			const cell = await controller.execute(
				"import json, os, sys; sys.path.insert(0, os.environ['OMP_IPYTHON_RUNTIME_PATH']); import dill, ipykernel, jupyter_client, PIL, zmq, rlm, omp, edit; capabilities = [item.name for item in omp.capabilities()]; print(json.dumps({'versions': [dill.__version__, ipykernel.__version__, jupyter_client.__version__, PIL.__version__, zmq.__version__], 'ast': callable(omp.ast.search) and callable(omp.ast.rewrite), 'rlm': callable(rlm), 'capabilities': {'ast': 'omp.ast' in capabilities, 'long_term_memory': 'omp.long_term_memory' in capabilities, 'lsp': 'omp.lsp' in capabilities, 'process': 'omp.process' in capabilities, 'tts': 'omp.tts' in capabilities}, 'edit': [omp.skill_path('edit').is_file(), callable(edit.run)]}))",
			);
			expect(cell.status).toBe("ok");
			expect(JSON.parse(cell.stdout.trim())).toEqual({
				versions: ["0.4.1", "7.3.0", "8.9.1", "11.3.0", "26.4.0"],
				ast: true,
				rlm: true,
				capabilities: { ast: true, long_term_memory: true, lsp: true, process: true, tts: true },
				edit: [true, true],
			});
			const discovery = await controller.execute(
				[
					"import json, omp",
					"web = omp.describe('omp.web')",
					"edit = omp.describe('edit')",
					"debug = omp.describe('omp.debug')",
					"details = [omp.describe(item.name) for item in omp.capabilities()]",
					"search = next(call for call in web.calls if call.name == 'search')",
					"print(json.dumps({'matches': [item.name for item in omp.capabilities('WeB')], 'web': {'category': web.category, 'documentation': search.documentation, 'is_async': search.is_async, 'signature': search.signature}, 'edit_skill_path': edit.skill_path.is_file(), 'debug': {'calls': len(debug.calls), 'omitted': debug.omitted_calls}, 'all_details': all(detail is not None for detail in details), 'process_run': hasattr(omp.process, 'run')}))",
				].join("\n"),
			);
			expect(discovery.status).toBe("ok");
			const discoveryDetail = JSON.parse(discovery.stdout.trim()) as {
				matches: string[];
				web: { category: string; documentation: string; is_async: boolean; signature: string };
				edit_skill_path: boolean;
				debug: { calls: number; omitted: number };
				all_details: boolean;
				process_run: boolean;
			};
			expect(discoveryDetail.matches).toEqual(["websearch", "omp.web"]);
			expect(discoveryDetail.web).toMatchObject({
				category: "host",
				documentation: "Search through the session's configured provider chain.",
				is_async: true,
			});
			expect(discoveryDetail.web.signature).toContain("query");
			expect(discoveryDetail.edit_skill_path).toBe(true);
			expect(discoveryDetail.debug).toEqual({ calls: 16, omitted: 15 });
			expect(discoveryDetail.all_details).toBe(true);
			expect(discoveryDetail.process_run).toBe(false);
			const structural = await controller.execute(
				[
					"import json",
					"typescript = await omp.ast.search('fixture.ts', ['console.log($$$ARGS)'], language='typescript')",
					"python = await omp.ast.search('fixture.py', ['print($$$ARGS)'], language='python')",
					"typescript_rewrite = await omp.ast.rewrite('fixture.ts', {'console.log($$$ARGS)': 'logger.info($$$ARGS)'}, language='typescript', dry_run=False)",
					"python_rewrite = await omp.ast.rewrite('fixture.py', {'print($$$ARGS)': 'logger.info($$$ARGS)'}, language='python', dry_run=False)",
					"print(json.dumps({'matches': [typescript['totalMatches'], typescript['matches'][0]['text'], python['totalMatches'], python['matches'][0]['text']], 'rewrites': [typescript_rewrite['totalReplacements'], python_rewrite['totalReplacements']]}))",
				].join("\n"),
				{
					hostContext: {
						sessionId: "runtime-test",
						cwd: tempRoot,
						cellId: "structural-ast",
						sequence: 1,
						origin: "model",
						authority: "trusted-cell",
					},
				},
			);
			expect(structural.status).toBe("ok");
			expect(JSON.parse(structural.stdout.trim())).toEqual({
				matches: [1, "console.log(1)", 1, "print(1)"],
				rewrites: [1, 1],
			});
			expect(await fs.readFile(typescriptFixture, "utf8")).toBe(
				'const selected = logger.info(1);\n// console.log("unrelated")\nconst literal = "console.log(2)";\n',
			);
			expect(await fs.readFile(pythonFixture, "utf8")).toBe(
				'selected = logger.info(1)\n# print("unrelated")\nliteral = "print(2)"\n',
			);
			await controller.dispose();
			controller = undefined;

			const warm = await ensureIpythonRuntime({
				runtimeRoot,
				uvExecutable: path.join(tempRoot, "uv-must-not-run"),
				environment,
			});
			expect(warm.pythonExecutable).toBe(first.pythonExecutable);
			expect(await runPython(warm.pythonExecutable, warm.environment, "print(40 + 2)")).toBe("42");
		} finally {
			await controller?.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 180_000);

	test("installs a locked validated package graph and rejects stale locks", async () => {
		const uvExecutable = Bun.env.OMP_IPYTHON_TEST_UV;
		if (!uvExecutable) throw new Error("OMP_IPYTHON_TEST_UV is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-package-runtime-"));
		const runtimeRoot = path.join(tempRoot, "runtime");
		const packageRoot = path.join(tempRoot, "tiny-package");
		const packageSource = path.join(packageRoot, "src", "tiny_runtime_pkg");
		const home = path.join(tempRoot, "home");
		await fs.mkdir(packageSource, { recursive: true });
		await fs.mkdir(home);
		await fs.writeFile(
			path.join(packageRoot, "pyproject.toml"),
			'[project]\nname = "tiny-runtime-package"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.12"\ndependencies = ["dill==0.4.1"]\n\n[tool.uv]\npackage = false\n',
		);
		await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: tiny-runtime\ndescription: tiny\n---\n");
		await fs.writeFile(path.join(packageSource, "__init__.py"), "import dill\nVALUE = dill.__version__\n");
		const environment = {
			HOME: home,
			PATH: `${path.dirname(uvExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			UV_NO_CONFIG: "1",
			UV_CACHE_DIR: path.join(tempRoot, "uv-cache"),
		};
		const lockProcess = Bun.spawn([uvExecutable, "lock", "--project", packageRoot, "--no-config"], {
			cwd: packageRoot,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [lockExit, lockStderr] = await Promise.all([lockProcess.exited, new Response(lockProcess.stderr).text()]);
		if (lockExit !== 0) throw new Error(`uv lock failed: ${lockStderr}`);
		const skill: Skill = {
			name: "tiny-runtime",
			description: "tiny",
			filePath: path.join(packageRoot, "SKILL.md"),
			baseDir: packageRoot,
			source: "test:project",
			pythonImport: "tiny_runtime_pkg",
			pythonCallable: "run",
			pythonPath: path.join(packageRoot, "src"),
		};
		const firstResolved = await resolvePythonSkillPackages([skill]);
		if (firstResolved.warnings.length > 0 || firstResolved.packages.length !== 1) {
			throw new Error(`package validation failed: ${JSON.stringify(firstResolved.warnings)}`);
		}
		const packageOptions = { runtimeRoot, uvExecutable, environment, pythonPackages: firstResolved.packages };
		try {
			const first = await ensureIpythonRuntime(packageOptions);
			const imported = await runPython(
				first.pythonExecutable,
				first.environment,
				`import sys; sys.path.insert(0, ${JSON.stringify(first.pythonPackagePaths?.[0])}); import tiny_runtime_pkg; print(tiny_runtime_pkg.VALUE)`,
			);
			expect(imported).toBe("0.4.1");
			const warm = await ensureIpythonRuntime({
				...packageOptions,
				uvExecutable: path.join(tempRoot, "uv-must-not-run"),
			});
			expect(warm.runtimeDir).toBe(first.runtimeDir);

			await fs.writeFile(path.join(packageSource, "__init__.py"), 'import dill\nVALUE = "changed"\n');
			const changedResolved = await resolvePythonSkillPackages([skill]);
			const changedPackage = changedResolved.packages[0];
			if (!changedPackage) throw new Error("changed package did not validate");
			const changed = await ensureIpythonRuntime({ ...packageOptions, pythonPackages: [changedPackage] });
			expect(changed.runtimeDir).not.toBe(first.runtimeDir);

			await fs.writeFile(
				path.join(packageRoot, "pyproject.toml"),
				'[project]\nname = "tiny-runtime-package"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.12"\ndependencies = ["dill==0.4.1", "missing-package-for-stale-lock==0.0.1"]\n\n[tool.uv]\npackage = false\n',
			);
			const staleResolved = await resolvePythonSkillPackages([skill]);
			const stalePackage = staleResolved.packages[0];
			if (!stalePackage) throw new Error("stale package did not validate structurally");
			await expect(ensureIpythonRuntime({ ...packageOptions, pythonPackages: [stalePackage] })).rejects.toThrow();
			const recovered = await ensureIpythonRuntime({
				...packageOptions,
				pythonPackages: [changedPackage],
				uvExecutable: path.join(tempRoot, "uv-must-not-run-after-failure"),
			});
			expect(recovered.runtimeDir).toBe(changed.runtimeDir);
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 180_000);
});

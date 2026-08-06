import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpythonController } from "../../src/ipython/controller.js";
import { ipythonBootstrapEnvironment, ipythonEnvironment } from "../../src/ipython/environment.js";
import { IPYTHON_PYTHON_ASSETS, ipythonPythonAssetHash } from "../../src/ipython/python-assets.js";
import runtimeLock from "../../src/ipython/runtime/uv.lock" with { type: "text" };
import { ensureIpythonRuntime, IPYTHON_RUNTIME_PACKAGES } from "../../src/ipython/runtime-bootstrap.js";

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

describe("IPython runtime environment", () => {
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
			"rlm/harness.py",
			"rlm/mcp_base.py",
			"omp/__init__.py",
			"agent_message/__init__.py",
			"agent_observe/__init__.py",
			"attach_image/__init__.py",
			"compact/__init__.py",
			"edit/__init__.py",
			"goal/__init__.py",
			"refine/__init__.py",
			"rlm_heartbeat/__init__.py",
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
		]) {
			const metadata = IPYTHON_PYTHON_ASSETS.find(asset => asset.path === `skills/${skill}/SKILL.md`);
			expect(metadata?.content).toContain("type: python");
			expect(metadata?.content).toContain("python_import:");
			expect(paths).toContain(`skills/${skill}/pyproject.toml`);
		}
		expect(ipythonPythonAssetHash()).toMatch(/^[a-f0-9]{64}$/);
		const runtimeSource = IPYTHON_PYTHON_ASSETS.map(asset => asset.content).join("\n");
		expect(runtimeSource).not.toContain("auth.json");
		expect(runtimeSource).not.toContain("prime-agent-runtime");
	});

	test("locks PyZMQ wheels covering every release target", () => {
		const wheels = [
			[
				"pyzmq-26.4.0-cp311-cp311-macosx_10_15_universal2.whl",
				"bfcf82644c9b45ddd7cd2a041f3ff8dce4a0904429b74d73a439e8cab1bd9e54",
			],
			[
				"pyzmq-26.4.0-cp311-cp311-manylinux_2_17_aarch64.manylinux2014_aarch64.whl",
				"e9bcae3979b2654d5289d3490742378b2f3ce804b0b5fd42036074e2bf35b030",
			],
			[
				"pyzmq-26.4.0-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
				"4550af385b442dc2d55ab7717837812799d3674cb12f9a3aa897611839c18e9e",
			],
			[
				"pyzmq-26.4.0-cp311-cp311-musllinux_1_1_aarch64.whl",
				"3709c9ff7ba61589b7372923fd82b99a81932b592a5c7f1a24147c91da9a68d6",
			],
			[
				"pyzmq-26.4.0-cp311-cp311-musllinux_1_1_x86_64.whl",
				"382a4a48c8080e273427fc692037e3f7d2851959ffe40864f2db32646eeb3cef",
			],
			["pyzmq-26.4.0-cp311-cp311-win_amd64.whl", "963977ac8baed7058c1e126014f3fe58b3773f45c78cce7af5c26c09b6823896"],
		] as const;
		for (const [filename, hash] of wheels) {
			expect(runtimeLock).toContain(filename);
			expect(runtimeLock).toContain(`sha256:${hash}`);
		}
		expect(IPYTHON_RUNTIME_PACKAGES).toEqual({
			dill: "0.4.1",
			ipykernel: "7.3.0",
			"jupyter-client": "8.9.1",
			pyzmq: "26.4.0",
		});
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
				"import importlib.metadata as m, json, os; print(json.dumps({name: m.version(name) for name in ['dill', 'ipykernel', 'jupyter-client', 'pyzmq']})); assert 'ANTHROPIC_API_KEY' not in os.environ; assert 'PYTHONPATH' not in os.environ",
			);
			expect(JSON.parse(versions)).toEqual(IPYTHON_RUNTIME_PACKAGES);

			controller = new IpythonController({
				pythonExecutable: first.pythonExecutable,
				cwd: tempRoot,
				env: first.environment,
			});
			await controller.start();
			const cell = await controller.execute(
				"import os, sys; sys.path.insert(0, os.environ['OMP_IPYTHON_RUNTIME_PATH']); import dill, ipykernel, jupyter_client, zmq, rlm, omp, edit; (dill.__version__, ipykernel.__version__, jupyter_client.__version__, zmq.__version__, callable(rlm), len(omp.capabilities()), omp.skill_path('edit').is_file(), callable(edit.run))",
			);
			expect(cell.status).toBe("ok");
			expect(cell.result).toBe("('0.4.1', '7.3.0', '8.9.1', '26.4.0', True, 18, True, True)");
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
});

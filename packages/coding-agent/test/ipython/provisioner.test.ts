import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonExtensionHostHandler } from "../../src/extensibility/extensions/types.js";
import type { Skill } from "../../src/extensibility/skills.js";
import { type AgentFamilyService, createAgentFamilyIpythonHostHandlers } from "../../src/ipython/agent-family.js";
import { createIpythonAstHostHandlers } from "../../src/ipython/ast-service.js";
import { IpythonAutoQaService } from "../../src/ipython/autoqa-service.js";
import { IpythonBootGate, resolveIpythonBootConcurrency } from "../../src/ipython/boot-gate.js";
import { IpythonBrowserService } from "../../src/ipython/browser-service.js";
import { createIpythonCodeHostHandlers } from "../../src/ipython/code-service.js";
import { IpythonComputerService } from "../../src/ipython/computer-service.js";
import type {
	IpythonControllerOptions,
	IpythonExecutionResult,
	IpythonHostHandlers,
	IpythonHostRequest,
	IpythonProcessIds,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../../src/ipython/controller.js";
import { IpythonDebugService } from "../../src/ipython/debug-service.js";
import { ipythonEnvironment } from "../../src/ipython/environment.js";
import { IpythonGithubService } from "../../src/ipython/github-service.js";
import { composeIpythonHostHandlers, createFoundationalIpythonHostHandlers } from "../../src/ipython/host-bridge.js";
import {
	type IpythonKernelController,
	IpythonKernelProvisioner,
	type IpythonStartupProgress,
} from "../../src/ipython/provisioner.js";
import { type PythonSkillPackage, resolvePythonSkillPackages } from "../../src/ipython/python-packages.js";
import { IpythonRemoteService } from "../../src/ipython/remote-service.js";
import { createRlmIpythonHostHandlers } from "../../src/ipython/rlm-host.js";
import type { EnsureIpythonRuntimeOptions, IpythonRuntime } from "../../src/ipython/runtime-bootstrap.js";
import { IpythonVibeService } from "../../src/ipython/vibe-service.js";
import { IpythonWebService } from "../../src/ipython/web-service.js";
import type { ToolSession } from "../../src/session/tool-session.js";
import type { TaskAdmissionRequest, TaskAdmissionService } from "../../src/task/admission.js";
import type {
	VibeKillOutcome,
	VibeScreenSnapshot,
	VibeSendOutcome,
	VibeSpawnOutcome,
	VibeWaitOutcome,
} from "../../src/vibe/runtime.js";

function executionResult(result?: string): IpythonExecutionResult {
	return { id: "fake", status: "ok", stdout: "", stderr: "", result, events: [], errors: [], hostArtifacts: [] };
}

function restoreResult(snapshotPath: string): IpythonRestoreResult {
	return { restored: [], failed: [], missing: true, path: snapshotPath };
}

function snapshotResult(snapshotPath: string): IpythonSnapshotResult {
	return {
		saved: [],
		skipped: [],
		oversized: [],
		failed: [],
		bytes: 0,
		path: snapshotPath,
		manifestPath: `${snapshotPath}.json`,
	};
}

function fakeRuntime(options: EnsureIpythonRuntimeOptions): IpythonRuntime {
	return {
		pythonExecutable: "/test/python",
		runtimeDir: "/test/runtime",
		pythonPackageDir: "/test/runtime/python",
		sitePackagesDir: "/test/runtime/site-packages",
		pythonPackagePaths: options.pythonPackages?.map((_, index) => `/test/runtime/source/${index}`) ?? [],
		environment: {
			...ipythonEnvironment(options.environment),
			OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
		},
	};
}

class FakeController implements IpythonKernelController {
	processIds: IpythonProcessIds | undefined;
	readonly events: string[];
	readonly options: IpythonControllerOptions;
	readonly failStart: boolean;
	disposed = false;
	interrupted = false;
	throwExecute = false;

	constructor(options: IpythonControllerOptions, events: string[], failStart = false) {
		this.options = options;
		this.events = events;
		this.failStart = failStart;
	}

	async start(): Promise<void> {
		this.events.push("start");
		if (this.failStart) throw new Error("injected start failure");
		this.processIds = { controllerPid: 10, kernelPid: 11 };
	}

	async execute(code: string): Promise<IpythonExecutionResult> {
		this.events.push(`execute:${code}`);
		if (this.throwExecute) throw new Error("injected controller execution failure");
		return executionResult();
	}

	async snapshot(snapshotPath: string): Promise<IpythonSnapshotResult> {
		this.events.push("snapshot");
		return snapshotResult(snapshotPath);
	}

	async restore(snapshotPath: string): Promise<IpythonRestoreResult> {
		this.events.push("restore");
		return restoreResult(snapshotPath);
	}

	async interrupt(): Promise<void> {
		this.interrupted = true;
	}

	async dispose(): Promise<void> {
		this.events.push("dispose");
		this.disposed = true;
		this.processIds = undefined;
	}
}

class ProcessBackedStartingController extends FakeController {
	readonly entered = Promise.withResolvers<IpythonProcessIds>();
	readonly #releaseStart = Promise.withResolvers<void>();
	readonly #children: Array<{ readonly pid: number; readonly exited: Promise<number>; kill(): void }> = [];

	override async start(): Promise<void> {
		for (let index = 0; index < 2; index += 1) {
			this.#children.push(
				Bun.spawn({
					cmd: [process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		}
		const [controller, kernel] = this.#children;
		if (!controller || !kernel) throw new Error("failed to create test processes");
		this.processIds = { controllerPid: controller.pid, kernelPid: kernel.pid };
		this.entered.resolve(this.processIds);
		await this.#releaseStart.promise;
	}

	override async dispose(): Promise<void> {
		this.#releaseStart.resolve();
		for (const child of this.#children) child.kill();
		await Promise.all(this.#children.map(child => child.exited));
		await super.dispose();
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

describe("IPython boot gate", () => {
	test("resolves bounded host overrides", () => {
		expect(resolveIpythonBootConcurrency({}, 1)).toBe(4);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "20" }, 2)).toBe(20);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "999" }, 2)).toBe(64);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "0" }, 8)).toBe(16);
	});

	test("cancels a queued boot without consuming the permit", async () => {
		const gate = new IpythonBootGate(1);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const first = gate.run(async () => {
			firstEntered.resolve();
			await releaseFirst.promise;
			return "first";
		});
		await firstEntered.promise;

		const abort = new AbortController();
		const queued = gate.run(async () => "cancelled boot ran", abort.signal);
		abort.abort(new Error("cancel queued boot"));
		await expect(queued).rejects.toThrow("cancel queued boot");

		releaseFirst.resolve();
		expect(await first).toBe("first");
		expect(await gate.run(async () => "next")).toBe("next");
	});
});

describe("IPython kernel provisioner", () => {
	function packageRecord(importName: string, index: number): PythonSkillPackage {
		return {
			importName,
			callableName: "run",
			projectName: importName,
			packageRoot: `/test/package/${index}`,
			sourceRoot: `/test/package/${index}/src`,
			skillPath: `/test/package/${index}/SKILL.md`,
			files: [],
			contentHash: `${index}`,
			skill: {
				name: importName,
				description: importName,
				filePath: `/test/package/${index}/SKILL.md`,
				baseDir: `/test/package/${index}`,
				source: "test",
			},
		};
	}

	test("does not interrupt a snapshot or run a queued cell after its signal aborts", async () => {
		const snapshotStarted = Promise.withResolvers<void>();
		const releaseSnapshot = Promise.withResolvers<void>();
		const events: string[] = [];
		class BlockingSnapshotController extends FakeController {
			override async snapshot(snapshotPath: string): Promise<IpythonSnapshotResult> {
				this.events.push("snapshot:start");
				snapshotStarted.resolve();
				await releaseSnapshot.promise;
				this.events.push("snapshot:end");
				return snapshotResult(snapshotPath);
			}
		}
		let controller: BlockingSnapshotController | undefined;
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "snapshot-cancellation", snapshotPath: "/test/snapshot.dill" },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					controller = new BlockingSnapshotController(options, events);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);
		await provisioner.ensure();
		const snapshot = provisioner.flushSnapshot();
		await snapshotStarted.promise;

		const abort = new AbortController();
		const queued = provisioner.execute("cancelled_side_effect = True", undefined, abort.signal);
		abort.abort(new Error("cancel queued cell"));
		await expect(queued).rejects.toThrow("cancel queued cell");
		expect(controller?.interrupted).toBe(false);

		releaseSnapshot.resolve();
		await snapshot;
		await Promise.resolve();
		expect(events).not.toContain("execute:cancelled_side_effect = True");
		await provisioner.dispose();
	});

	test("keeps pending packages before startup and uses one active controller for reload", async () => {
		const first = packageRecord("first_pkg", 1);
		const second = packageRecord("second_pkg", 2);
		let runtimeOptions: EnsureIpythonRuntimeOptions | undefined;
		let controllers = 0;
		const events: string[] = [];
		let controller: FakeController | undefined;
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "reload", pythonPackages: [first] },
			{
				ensureRuntime: async options => {
					runtimeOptions = options;
					return fakeRuntime(options);
				},
				createController: options => {
					controllers += 1;
					controller = new FakeController(options, events);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);
		await provisioner.reloadPythonPackages([second]);
		await provisioner.ensure();
		expect(runtimeOptions?.pythonPackages).toEqual([second]);
		await provisioner.reloadPythonPackages([first]);
		await provisioner.reloadPythonPackages([second]);
		expect(controllers).toBe(1);
		expect(events.filter(event => event.startsWith("execute:")).length).toBe(3);
		expect(events.at(-1)).toContain("second_pkg");
		await provisioner.dispose();
	});

	test("does not commit package paths when the administrative reload cell fails", async () => {
		const first = packageRecord("first_pkg", 1);
		const second = packageRecord("second_pkg", 2);
		let controller: FakeController | undefined;
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "reload-failure", pythonPackages: [first] },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					controller = new FakeController(options, []);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);
		await provisioner.ensure();
		if (!controller) throw new Error("controller was not created");
		controller.throwExecute = true;
		await expect(provisioner.reloadPythonPackages([second])).rejects.toThrow("controller execution failure");
		controller.throwExecute = false;
		await provisioner.reloadPythonPackages([first]);
		await provisioner.dispose();
	});

	test("awaits its gate, restores before bootstrap, and shares one startup", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const snapshotPath = "/test/sidecar/state.dill";
		const progressA: IpythonStartupProgress[] = [];
		const progressB: IpythonStartupProgress[] = [];
		let controllers = 0;
		let createdController: FakeController | undefined;
		let runtimeOptions: EnsureIpythonRuntimeOptions | undefined;
		const provisioner = new IpythonKernelProvisioner(
			{
				cwd: "/work",
				sessionId: "session-a",
				sidecarDir: "/test/sidecar",
				snapshotPath,
				readyGate: gate.promise,
				bootstrapCode: "rlm = 'fresh'",
				environment: { ANTHROPIC_API_KEY: "secret", PATH: "/bin" },
			},
			{
				ensureRuntime: async options => {
					events.push("runtime");
					runtimeOptions = options;
					return fakeRuntime(options);
				},
				createController: options => {
					controllers += 1;
					createdController = new FakeController(options, events);
					return createdController;
				},
				withBootPermit: async boot => await boot(),
			},
		);

		const first = provisioner.ensure(progress => progressA.push(progress));
		const second = provisioner.ensure(progress => progressB.push(progress));
		expect(progressA.at(-1)?.stage).toBe("gate");
		expect(progressB.at(-1)?.stage).toBe("gate");
		gate.resolve();
		expect(await first).toBe(await second);

		expect(controllers).toBe(1);
		expect(events[0]).toBe("runtime");
		expect(events.slice(1, 3)).toEqual(["start", "restore"]);
		expect(events[3]?.startsWith("execute:")).toBe(true);
		expect(events[3]).toContain("import asyncio as _omp_runtime_asyncio");
		expect(events[3]).toContain("rlm = 'fresh'");
		expect(progressA.map(progress => progress.stage)).toEqual([
			"gate",
			"runtime",
			"controller",
			"restore",
			"bootstrap",
			"ready",
		]);
		expect(runtimeOptions?.environment).toMatchObject({
			OMP_SESSION_ID: "session-a",
			OMP_SESSION_CWD: "/work",
			OMP_SESSION_ARTIFACT_DIR: "/test/sidecar",
		});
		expect(createdController?.options.env).toMatchObject({
			OMP_SESSION_ID: "session-a",
			OMP_SESSION_CWD: "/work",
			OMP_SESSION_ARTIFACT_DIR: "/test/sidecar",
		});
		expect(createdController?.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(provisioner.lastRestore).toEqual(restoreResult(snapshotPath));
		expect(provisioner.hasRunningKernel).toBe(true);
		await provisioner.dispose();
	});

	test("disposes a failed generation and retries with a fresh controller", async () => {
		const events: string[] = [];
		const controllers: FakeController[] = [];
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "retry" },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					const controller = new FakeController(options, events, controllers.length === 0);
					controllers.push(controller);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);

		await expect(provisioner.ensure()).rejects.toThrow("injected start failure");
		expect(controllers[0]?.disposed).toBe(true);
		await provisioner.ensure();
		expect(controllers).toHaveLength(2);
		expect(provisioner.processIds).toEqual({ controllerPid: 10, kernelPid: 11 });
		await provisioner.dispose();
	});

	test("disposes controller and kernel processes admitted during startup", async () => {
		const controllerCreated = Promise.withResolvers<ProcessBackedStartingController>();
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "dispose-controller-start" },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					const controller = new ProcessBackedStartingController(options, []);
					controllerCreated.resolve(controller);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);
		const starting = provisioner.ensure();
		const admitted = await controllerCreated.promise;
		const processIds = await admitted.entered.promise;
		try {
			await provisioner.dispose();
			await expect(starting).rejects.toThrow("IPython provisioner disposed");
			expect(processExists(processIds.controllerPid)).toBe(false);
			expect(processExists(processIds.kernelPid)).toBe(false);
		} finally {
			await provisioner.dispose();
		}
	});

	test("cancels runtime setup and never creates a controller when disposed during start", async () => {
		const entered = Promise.withResolvers<void>();
		let controllers = 0;
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "dispose-start" },
			{
				ensureRuntime: async options => {
					entered.resolve();
					const signal = options.signal;
					if (!signal) throw new Error("test requires lifecycle signal");
					if (signal.aborted) throw signal.reason;
					const { promise, reject } = Promise.withResolvers<IpythonRuntime>();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					return await promise;
				},
				createController: options => {
					controllers += 1;
					return new FakeController(options, []);
				},
			},
		);
		const starting = provisioner.ensure();
		await entered.promise;
		await provisioner.dispose();
		await expect(starting).rejects.toThrow("IPython provisioner disposed");
		expect(controllers).toBe(0);
		expect(provisioner.hasRunningKernel).toBe(false);
	});
});

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";

function pythonAbiSourcePath(): string {
	const root = path.resolve(import.meta.dir, "../../src/ipython/python");
	const skills = [
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
	];
	return [root, ...skills.map(skill => path.join(root, "skills", skill, "src"))].join(path.delimiter);
}
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("IPython provisioner real-kernel boundary", () => {
	test("reloads validated packages in one live heap and removes stale imports", async () => {
		const uvExecutable = Bun.env.OMP_IPYTHON_TEST_UV;
		if (!uvExecutable) throw new Error("OMP_IPYTHON_TEST_UV is required");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-package-reload-"));
		const packageRoot = path.join(tempRoot, "reload-package");
		const sourceDir = path.join(packageRoot, "src", "reload_pkg");
		const home = path.join(tempRoot, "home");
		await fs.mkdir(sourceDir, { recursive: true });
		await fs.mkdir(home);
		await fs.writeFile(
			path.join(packageRoot, "pyproject.toml"),
			'[project]\nname = "reload-package"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.12"\ndependencies = ["tomli==2.0.1"]\n\n[tool.uv]\npackage = false\n',
		);
		await fs.writeFile(path.join(packageRoot, "SKILL.md"), "---\nname: reload-package\ndescription: reload\n---\n");
		await fs.writeFile(
			path.join(sourceDir, "__init__.py"),
			'import tomli\nVALUE = "first"\nDEP_VERSION = tomli.__version__\n',
		);
		const environment = {
			HOME: home,
			PATH: `${path.dirname(uvExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
			UV_NO_CONFIG: "1",
		};
		const lock = Bun.spawn([uvExecutable, "lock", "--project", packageRoot, "--no-config"], {
			cwd: packageRoot,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [lockExit, lockError] = await Promise.all([lock.exited, new Response(lock.stderr).text()]);
		if (lockExit !== 0) throw new Error(`uv lock failed: ${lockError}`);
		const skill: Skill = {
			name: "reload-package",
			description: "reload",
			filePath: path.join(packageRoot, "SKILL.md"),
			baseDir: packageRoot,
			source: "test",
			pythonImport: "reload_pkg",
			pythonCallable: "run",
			pythonPath: path.join(packageRoot, "src"),
		};
		const first = await resolvePythonSkillPackages([skill]);
		if (!first.packages[0]) throw new Error(JSON.stringify(first.warnings));
		let initialIds: IpythonProcessIds | undefined;
		const provisioner = new IpythonKernelProvisioner({
			cwd: tempRoot,
			sessionId: "package-reload",
			pythonPackages: first.packages,
			environment,
			runtime: { runtimeRoot: path.join(tempRoot, "runtime"), uvExecutable },
		});
		try {
			await provisioner.ensure();
			initialIds = provisioner.processIds;
			const initial = await provisioner.execute(
				"import rlm, omp, reload_pkg; sentinel = object(); (reload_pkg.VALUE, reload_pkg.DEP_VERSION, id(sentinel), id(rlm), id(omp))",
			);
			expect(initial.status).toBe("ok");
			await fs.writeFile(
				path.join(sourceDir, "__init__.py"),
				'import tomli\nVALUE = "second"\nDEP_VERSION = tomli.__version__\n',
			);
			await fs.writeFile(
				path.join(packageRoot, "pyproject.toml"),
				'[project]\nname = "reload-package"\nversion = "0.1.0"\nrequires-python = ">=3.11,<3.12"\ndependencies = ["tomli==2.2.1"]\n\n[tool.uv]\npackage = false\n',
			);
			const relock = Bun.spawn([uvExecutable, "lock", "--project", packageRoot, "--no-config"], {
				cwd: packageRoot,
				env: environment,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [relockExit, relockError] = await Promise.all([relock.exited, new Response(relock.stderr).text()]);
			if (relockExit !== 0) throw new Error(`uv relock failed: ${relockError}`);
			const changed = await resolvePythonSkillPackages([skill]);
			if (!changed.packages[0]) throw new Error(JSON.stringify(changed.warnings));
			const installFailure = await provisioner.execute(
				"import sys\nclass _BadReloadFinder:\n    def invalidate_caches(self): raise RuntimeError('injected reload failure')\n_bad_reload_finder = _BadReloadFinder()\nsys.meta_path.append(_bad_reload_finder)",
			);
			expect(installFailure.status).toBe("ok");
			await expect(provisioner.reloadPythonPackages(changed.packages)).rejects.toThrow("injected reload failure");
			const rolledBack = await provisioner.execute(
				"import sys, reload_pkg; sys.meta_path.remove(_bad_reload_finder); (reload_pkg.VALUE, reload_pkg.DEP_VERSION)",
			);
			expect(rolledBack.result).toBe("('first', '2.0.1')");
			await provisioner.reloadPythonPackages(changed.packages);
			const reloaded = await provisioner.execute(
				"import rlm, omp, reload_pkg; (reload_pkg.VALUE, reload_pkg.DEP_VERSION, id(sentinel), id(rlm), id(omp))",
			);
			expect(reloaded.status).toBe("ok");
			expect(reloaded.result).toBe(initial.result?.replace("first", "second").replace("2.0.1", "2.2.1"));
			expect(provisioner.processIds).toEqual(initialIds);
			await provisioner.reloadPythonPackages([]);
			const removed = await provisioner.execute("import reload_pkg");
			expect(removed.status).toBe("error");
			const removedDependency = await provisioner.execute("import tomli");
			expect(removedDependency.status).toBe("error");
			const preserved = await provisioner.execute("import rlm, omp; (id(sentinel), id(rlm), id(omp))");
			expect(preserved.status).toBe("ok");
			expect(preserved.result).toBe(initial.result?.replace("('first', '2.0.1', ", "("));
			expect(provisioner.processIds).toEqual(initialIds);
		} finally {
			await provisioner.dispose();
			if (initialIds) {
				expect(processExists(initialIds.controllerPid)).toBe(false);
				expect(processExists(initialIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 180_000);

	test("runs the callable RLM ABI through typed Task admission handlers", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-rlm-"));
		const sidecarDir = path.join(tempRoot, "sidecar");
		await fs.writeFile(path.join(tempRoot, "example.ts"), "export const value = console.log('hello');\n");
		const admissions: TaskAdmissionRequest[] = [];
		const task: TaskAdmissionService = {
			async admit(request) {
				admissions.push(request);
				return {
					id: "child-one",
					name: "child-one",
					jobId: "child-one",
					sessionId: "child-session",
					sessionDir: path.join(tempRoot, "child"),
					model: "provider/model",
					cwd: tempRoot,
				};
			},
			findModels() {
				return [{ provider: "provider", id: "model", name: "Model", selector: "provider/model" }];
			},
			async listDirectChildren() {
				return [
					{
						id: "child-one",
						name: "child-one",
						activeSessionId: "child-session",
						sessionId: "child-session",
						sessionDir: path.join(tempRoot, "child"),
						status: "running" as const,
						lifecycleStatus: "running" as const,
					},
				];
			},
			async deleteDirectChild() {
				return {
					id: "child-one",
					name: "child-one",
					sessionId: "child-session",
					sessionDir: path.join(tempRoot, "child"),
					status: "error" as const,
					lifecycleStatus: "aborted" as const,
				};
			},
		};
		const familySends: Array<{ message: string; id: string }> = [];
		const family: AgentFamilyService = {
			roster: async () => ({
				current: { name: "parent", id: "Main", depth: 0 },
				entries: [{ relationship: "child", name: "child-one", id: "child-one", depth: 1, status: "running" }],
			}),
			async send(request) {
				familySends.push({ message: request.message, id: request.id });
				return {
					id: request.id,
					deliveryStatus: "delivered",
					target: { activeSessionId: "child-one", sessionId: "child-session", sessionName: "child-one" },
					message: request.message,
				};
			},
			inbox: async () => ({ messages: [{ id: "inbox-one", message: "stored" }] }),
			wait: async () => ({ message: { id: "reply-one", message: "reply" } }),
			observeList: async () => ({
				current: { activeSessionId: "Main", sessionId: "rlm-parent", sessionName: "parent" },
				agents: [{ activeSessionId: "child-one", sessionId: "child-session", sessionName: "child-one" }],
			}),
			observeGet: async () => ({ agent: { activeSessionId: "child-one", sessionName: "child-one" } }),
			observeRecent: async () => ({
				agent: { activeSessionId: "child-one", sessionName: "child-one" },
				messages: [{ index: 0, role: "assistant", text: "done", truncated: false }],
				limit: 1,
				maxChars: 80,
				truncated: false,
			}),
		};
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const debug = new IpythonDebugService({ cwd: () => tempRoot });
		const web = new IpythonWebService({
			search: async () => ({
				content: [{ type: "text", text: "answer" }],
				details: { response: { provider: "exa", answer: "answer", sources: [] } },
			}),
			fetch: async params => ({
				content: "fetched",
				details: {
					url: params.path,
					finalUrl: params.path,
					contentType: "text/plain",
					method: "fake",
					truncated: false,
					notes: [],
				},
			}),
		});
		const github = new IpythonGithubService({
			execute: async params => ({ content: [{ type: "text", text: params.op }], details: {} }),
			issue: async params => ({ payload: { number: Number(params.issue) }, status: "fresh" }),
			pullRequest: async params => ({ payload: { number: params.number }, status: "fresh" }),
			pullRequestDiff: async params => ({ payload: { number: params.number, unified: "" }, status: "fresh" }),
		});
		const remote = new IpythonRemoteService({
			cwd: () => tempRoot,
			loadHosts: async () => [
				{
					name: "build",
					host: "build.internal",
					_source: { provider: "test", providerName: "Test", path: "/ssh.json", level: "project" },
				},
			],
		});
		const browserRuns: Array<{ name: string; code: string }> = [];
		const computerRuns: Array<{
			code: string;
			snapshot: { cwd: string; sessionId: string; readOnly: boolean };
		}> = [];
		const browser = new IpythonBrowserService({
			owner: {
				open: async () => ({ created: true, browser: "fake", url: "about:blank" }),
				run: async (name, code) => {
					browserRuns.push({ name, code });
					return { displays: [], returnValue: null, screenshots: [] };
				},
				close: async () => true,
				info: async () => undefined,
			},
			timeoutMs: async value => (value ?? 30) * 1_000,
			sessionId: () => "rlm-parent",
		});
		const computer = new IpythonComputerService({
			createController: async () => ({
				run: async (code, _timeoutMs, snapshot) => {
					computerRuns.push({
						code,
						snapshot: { cwd: snapshot.cwd, sessionId: snapshot.sessionId, readOnly: snapshot.readOnly },
					});
					return { displays: [], returnValue: null, screenshots: [] };
				},
				capabilities: async () => undefined,
				close: async () => {},
			}),
			snapshot: async (readOnly, identity) => ({
				cwd: identity.cwd,
				sessionId: identity.sessionId,
				captureMaxWidth: 1280,
				captureMaxHeight: 896,
				display: "all",
				readOnly,
			}),
			timeoutMs: async value => (value ?? 30) * 1_000,
		});
		const vibeCalls: string[] = [];
		const vibeWaitEntered = Promise.withResolvers<void>();
		let vibeWaitBlocks = false;
		const vibeScreens: VibeScreenSnapshot[] = [];
		const vibe = new IpythonVibeService({
			session: {} as ToolSession,
			registry: {
				spawn: async (
					_session: ToolSession,
					input: { cli: "fast" | "good"; name?: string; prompt: string },
				): Promise<VibeSpawnOutcome> => {
					vibeCalls.push(`spawn:${input.cli}:${input.prompt}`);
					vibeScreens.splice(0, vibeScreens.length, {
						id: "vibe-kernel",
						cli: input.cli,
						state: "running",
						turns: 1,
						queued: 0,
						trace: [],
						outputTail: [],
						lastActivityAt: 1,
					});
					return { id: "vibe-kernel", jobId: "vibe-job-1" };
				},
				send: async (
					_session: ToolSession,
					input: { session: string; message: string },
				): Promise<VibeSendOutcome> => {
					vibeCalls.push(`send:${input.session}:${input.message}`);
					return { id: input.session, mode: "steered" };
				},
				wait: async (_session: ToolSession, input: { signal?: AbortSignal }): Promise<VibeWaitOutcome> => {
					vibeCalls.push("wait");
					vibeWaitEntered.resolve();
					if (vibeWaitBlocks) {
						await new Promise<void>((_resolve, reject) =>
							input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }),
						);
					}
					return { settled: [], stillRunning: ["vibe-kernel"], timedOut: true };
				},
				kill: async (_session: ToolSession, id: string): Promise<VibeKillOutcome> => {
					vibeCalls.push(`kill:${id}`);
					vibeScreens.splice(0, vibeScreens.length);
					return { id, cancelledTurn: true };
				},
				screens: (): VibeScreenSnapshot[] => vibeScreens,
			},
		});
		const typedQaCalls: Array<{ tool: string; report: string; signal: AbortSignal }> = [];
		const autoQa = new IpythonAutoQaService({
			owner: {
				reportIssue: async input => {
					typedQaCalls.push(input);
					return { status: "recorded", pushed: 0, pushOk: false, pushSkipped: true };
				},
			},
		});
		const phase46Calls: Array<{ type: string; data: Readonly<Record<string, unknown>> }> = [];
		const phase46Handlers: IpythonHostHandlers = Object.fromEntries(
			[
				"ask.questions",
				"images.attachments",
				"images.generate",
				"security.plan",
				"security.start",
				"security.status",
				"security.findings",
				"security.validate",
				"security.cancel",
			].map(type => [
				type,
				(request: IpythonHostRequest) => {
					phase46Calls.push({ type, data: request.data });
					if (type === "ask.questions") {
						return { results: [{ id: "choice", selectedOptions: ["A"], multi: false }] };
					}
					if (type === "images.attachments") return { items: [{ label: "Image #1", mime_type: "image/png" }] };
					if (type === "images.generate") return { provider: "fake", model: "image-model", count: 1, images: [] };
					if (type === "security.plan") return { plan: { id: "plan-1" } };
					if (type === "security.start") return { operation: { operationId: "operation-1", phase: "queued" } };
					if (type === "security.status") return { operation: { operationId: "operation-1", phase: "completed" } };
					if (type === "security.findings")
						return { findings: [{ id: "finding-1", severity: { level: "high" } }] };
					if (type === "security.validate") {
						return {
							finding: {
								id: "finding-1",
								validation: {
									status: "validated",
									summary: "The cited source reproduces the issue.",
									evidenceIds: ["evidence-1"],
									validatedAt: "2026-08-09T00:00:00.000Z",
								},
							},
						};
					}
					return { cancelled: true };
				},
			]),
		);
		const phase47Calls: Array<{ type: string; data: Readonly<Record<string, unknown>> }> = [];
		const phase47Handlers: IpythonHostHandlers = Object.fromEntries(
			[
				"cron.create",
				"cron.list",
				"cron.update",
				"cron.delete",
				"mcp.list_tools",
				"mcp.call_tool",
				"mcp.list_resources",
				"mcp.resource_templates",
				"mcp.list_prompts",
				"mcp.notification_state",
				"mcp.wait_notification",
				"mcp.refresh",
			].map(type => [
				type,
				(request: IpythonHostRequest) => {
					phase47Calls.push({ type, data: request.data });
					if (type === "cron.create") {
						return { job: { id: "cron-1", expression: "0 9 * * *", prompt: "report", recurring: true } };
					}
					if (type === "cron.list") return { jobs: [{ id: "cron-1" }] };
					if (type === "cron.update") return { job: { id: "cron-1", prompt: "updated" } };
					if (type === "cron.delete") return { deleted: true };
					if (type === "mcp.list_tools") return { tools: [{ name: "echo" }] };
					if (type === "mcp.call_tool") return { result: "denied", is_error: true };
					if (type === "mcp.list_resources") {
						return { resources: [{ uri: "demo://one" }], templates: [{ uriTemplate: "demo://{id}" }] };
					}
					if (type === "mcp.resource_templates") return { templates: [{ uriTemplate: "demo://{id}" }] };
					if (type === "mcp.list_prompts") return { prompts: [{ name: "summarize" }] };
					if (type === "mcp.notification_state") return { enabled: true, subscriptions: [] };
					if (type === "mcp.wait_notification") return { server: "demo", method: "changed", params: { id: 1 } };
					if (type === "mcp.refresh") return { refreshed: true, connected: true, connection: "connected" };
					throw new Error(`unexpected phase 4.7 operation: ${type}`);
				},
			]),
		);
		const autoresearchCalls: Array<{ operation: string; data: Readonly<Record<string, unknown>> }> = [];
		const autoresearchHandlers: Readonly<Record<string, IpythonExtensionHostHandler>> = Object.fromEntries(
			["init", "run", "log", "notes"].map(operation => [
				`extension.autoresearch.${operation}`,
				(request: Parameters<IpythonExtensionHostHandler>[0]) => {
					autoresearchCalls.push({ operation, data: request.data });
					return {
						text: operation === "run" ? "METRIC latency=1\n" : `${operation} complete`,
						details: operation === "run" ? { parsed_primary: 1, tail_output: "METRIC latency=1" } : {},
					};
				},
			]),
		);
		const provisioner = new IpythonKernelProvisioner(
			{
				cwd: tempRoot,
				sessionId: "rlm-parent",
				sidecarDir,
				extensionHostHandlerResolver: operation => autoresearchHandlers[operation],
				hostHandlers: composeIpythonHostHandlers(
					createFoundationalIpythonHostHandlers(),
					debug.handlers,
					web.handlers,
					github.handlers,
					remote.handlers,
					browser.handlers,
					computer.handlers,
					vibe.handlers,
					autoQa.handlers,
					phase46Handlers,
					phase47Handlers,
					createIpythonAstHostHandlers({ cwd: tempRoot }),
					createIpythonCodeHostHandlers({ cwd: tempRoot }),
					createRlmIpythonHostHandlers(task),
					createAgentFamilyIpythonHostHandlers(family),
				),
			},
			{ ensureRuntime },
		);
		try {
			await provisioner.ensure();
			const hostContext = {
				sessionId: "rlm-parent",
				cwd: tempRoot,
				cellId: "rlm-cell",
				sequence: 1,
				origin: "model" as const,
				authority: "trusted-cell" as const,
			};
			const discovery = await provisioner.execute(
				[
					"import contextlib, inspect, io, json, websearch, linear, notion",
					"help_text = io.StringIO()",
					"with contextlib.redirect_stdout(help_text): help(omp.code.definition)",
					"lsp_status = await omp.lsp.status()",
					"code_lsp_status = await omp.code.lsp_status()",
					"print(json.dumps({'workspace': 'workspace' in dir(omp), 'files': 'files' in dir(omp), 'ast': 'ast' in dir(omp), 'code': 'code' in dir(omp), 'lsp': 'lsp' in dir(omp), 'lsp_status': lsp_status, 'code_lsp_status': code_lsp_status, 'debug': 'debug' in dir(omp), 'web': 'web' in dir(omp), 'github': 'github' in dir(omp), 'remote': 'remote' in dir(omp), 'ask': 'ask' in dir(omp), 'qa': 'qa' in dir(omp), 'browser': 'browser' in dir(omp), 'computer': 'computer' in dir(omp), 'images': 'images' in dir(omp), 'security': 'security' in dir(omp), 'cron': 'cron' in dir(omp), 'websearch': callable(websearch.run), 'linear': linear.linear.server, 'notion': notion.notion.server, 'signature': str(inspect.signature(omp.code.definition)), 'debug_signature': str(inspect.signature(omp.debug.launch)), 'web_signature': str(inspect.signature(omp.web.search)), 'github_signature': str(inspect.signature(omp.github.issue)), 'remote_signature': str(inspect.signature(omp.remote.exec)), 'ask_questions_signature': str(inspect.signature(omp.ask.questions)), 'qa_report_signature': str(inspect.signature(omp.qa.report_issue)), 'images_functions': [name for name in ('attachments', 'generate') if callable(getattr(omp.images, name, None))], 'images_generate_signature': str(inspect.signature(omp.images.generate)), 'security_functions': [name for name in ('plan', 'publish', 'start', 'status', 'operations', 'cancel', 'scans', 'scan', 'findings', 'finding', 'validate', 'compare') if callable(getattr(omp.security, name, None))], 'security_plan_signature': str(inspect.signature(omp.security.plan)), 'security_validate_signature': str(inspect.signature(omp.security.validate)), 'cron_functions': [name for name in ('create', 'list', 'update', 'delete') if callable(getattr(omp.cron, name, None))], 'cron_update_signature': str(inspect.signature(omp.cron.update)), 'mcp_functions': [name for name in ('servers', 'list_tools', 'call_tool', 'list_resources', 'resource_templates', 'read_resource', 'list_prompts', 'get_prompt', 'config', 'refresh', 'notification_state', 'wait_notification') if callable(getattr(omp.mcp, name, None))], 'browser_functions': [name for name in ('tabs', 'open', 'evaluate', 'release') if callable(getattr(omp.browser, name, None))], 'browser_drafts': [name for name in ('run', 'close') if name in dir(omp.browser)], 'browser_open_signature': str(inspect.signature(omp.browser.open)), 'computer_functions': [name for name in ('capabilities', 'evaluate', 'release') if callable(getattr(omp.computer, name, None))], 'computer_drafts': [name for name in ('inspect', 'run', 'close') if name in dir(omp.computer)], 'computer_evaluate_signature': str(inspect.signature(omp.computer.evaluate)), 'help': help_text.getvalue(), 'capabilities': [item.name for item in omp.capabilities()], 'edit_skill': str(omp.skill_path('edit')), 'attach_skill': str(omp.skill_path('attach_image')), 'websearch_skill': str(omp.skill_path('websearch')), 'linear_skill': str(omp.skill_path('linear')), 'notion_skill': str(omp.skill_path('notion'))}, sort_keys=True))",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "discovery-cell", sequence: 0 } },
			);
			if (discovery.status !== "ok") {
				throw new Error(`discovery cell failed: ${discovery.stderr} ${JSON.stringify(discovery.errors)}`);
			}
			const discovered = JSON.parse(discovery.stdout.trim()) as {
				workspace: boolean;
				files: boolean;
				ast: boolean;
				code: boolean;
				lsp: boolean;
				lsp_status: { configured: string[]; active: unknown[]; disabled: boolean };
				code_lsp_status: { configured: string[]; active: unknown[]; disabled: boolean };
				debug: boolean;
				web: boolean;
				github: boolean;
				remote: boolean;
				ask: boolean;
				qa: boolean;
				browser: boolean;
				computer: boolean;
				images: boolean;
				security: boolean;
				cron: boolean;
				websearch: boolean;
				linear: string;
				notion: string;
				signature: string;
				debug_signature: string;
				web_signature: string;
				github_signature: string;
				remote_signature: string;
				ask_questions_signature: string;
				qa_report_signature: string;
				images_functions: string[];
				images_generate_signature: string;
				security_functions: string[];
				security_plan_signature: string;
				security_validate_signature: string;
				cron_functions: string[];
				cron_update_signature: string;
				mcp_functions: string[];
				browser_functions: string[];
				browser_drafts: string[];
				browser_open_signature: string;
				computer_functions: string[];
				computer_drafts: string[];
				computer_evaluate_signature: string;
				help: string;
				capabilities: string[];
				edit_skill: string;
				attach_skill: string;
				websearch_skill: string;
				linear_skill: string;
				notion_skill: string;
			};
			expect(discovered.workspace).toBe(false);
			expect(discovered.files).toBe(false);
			expect(discovered.ast).toBe(true);
			expect(discovered.code).toBe(true);
			expect(discovered.lsp).toBe(true);
			expect(discovered.lsp_status).toEqual({ configured: [], active: [], disabled: true });
			expect(discovered.code_lsp_status).toEqual(discovered.lsp_status);
			expect(discovered.debug).toBe(true);
			expect(discovered.web).toBe(true);
			expect(discovered.github).toBe(true);
			expect(discovered.remote).toBe(true);
			expect(discovered.ask).toBe(true);
			expect(discovered.qa).toBe(true);
			expect(discovered.browser).toBe(true);
			expect(discovered.computer).toBe(true);
			expect(discovered.images).toBe(true);
			expect(discovered.security).toBe(true);
			expect(discovered.cron).toBe(true);
			expect(discovered.websearch).toBe(true);
			expect(discovered.linear).toBe("linear");
			expect(discovered.notion).toBe("notion");
			expect(discovered.signature).toContain("file");
			expect(discovered.debug_signature).toContain("program");
			expect(discovered.web_signature).toContain("query");
			expect(discovered.github_signature).toContain("number_or_url");
			expect(discovered.remote_signature).toContain("command");
			expect(discovered.ask_questions_signature).toContain("questions");
			expect(discovered.qa_report_signature).toContain("report");
			expect(discovered.images_functions).toEqual(["attachments", "generate"]);
			expect(discovered.images_generate_signature).toContain("subject");
			expect(discovered.images_generate_signature).toContain("provider");
			expect(discovered.security_functions).toEqual([
				"plan",
				"publish",
				"start",
				"status",
				"operations",
				"cancel",
				"scans",
				"scan",
				"findings",
				"finding",
				"validate",
				"compare",
			]);
			expect(discovered.security_plan_signature).toContain("target_kind");
			expect(discovered.security_validate_signature).toContain("evidence_ids");
			expect(discovered.cron_functions).toEqual(["create", "list", "update", "delete"]);
			expect(discovered.cron_update_signature).toContain("job_id");
			expect(discovered.mcp_functions).toEqual([
				"servers",
				"list_tools",
				"call_tool",
				"list_resources",
				"resource_templates",
				"read_resource",
				"list_prompts",
				"get_prompt",
				"config",
				"refresh",
				"notification_state",
				"wait_notification",
			]);
			expect(discovered.browser_functions).toEqual(["tabs", "open", "evaluate", "release"]);
			expect(discovered.browser_drafts).toEqual([]);
			expect(discovered.browser_open_signature).toContain("name");
			expect(discovered.browser_open_signature).not.toContain("app");
			expect(discovered.computer_functions).toEqual(["capabilities", "evaluate", "release"]);
			expect(discovered.computer_drafts).toEqual([]);
			expect(discovered.computer_evaluate_signature).toContain("code");
			expect(discovered.help).toContain("definition");
			expect(discovered.capabilities).toEqual(
				expect.arrayContaining([
					"omp.ast",
					"omp.code",
					"omp.lsp",
					"omp.debug",
					"omp.web",
					"omp.github",
					"omp.remote",
					"omp.ask",
					"omp.browser",
					"omp.computer",
					"omp.images",
					"omp.security",
					"omp.cron",
					"edit",
					"attach_image",
					"websearch",
					"linear",
					"notion",
				]),
			);
			expect(discovered.edit_skill).toEndWith("/skills/edit/SKILL.md");
			expect(discovered.attach_skill).toEndWith("/skills/attach-image/SKILL.md");
			expect(discovered.websearch_skill).toEndWith("/skills/websearch/SKILL.md");
			expect(discovered.linear_skill).toEndWith("/skills/linear/SKILL.md");
			expect(discovered.notion_skill).toEndWith("/skills/notion/SKILL.md");
			const sessionResult = await provisioner.execute(
				[
					"info = await omp.session.info()",
					"await omp.session.progress('session parity', {'step': 8})",
					"artifact = await omp.session.allocate_artifact('session parity', mime_type='text/plain', suffix='.txt')",
					"(info['sessionId'], info['cellId'], info['sequence'], info['origin'], info['authority'], artifact['artifact']['path'].endswith('.txt'))",
				].join("\n"),
				{
					hostContext: {
						...hostContext,
						cellId: "session-cell",
						sequence: 8,
						allocateArtifact: async request => ({
							path: path.join(tempRoot, `session${request.suffix}`),
							mimeType: request.mimeType,
							label: request.label,
							bytes: 0,
						}),
					},
				},
			);
			if (sessionResult.status !== "ok") {
				throw new Error(`session cell failed: ${sessionResult.stderr} ${JSON.stringify(sessionResult.errors)}`);
			}
			expect(sessionResult.result).toBe("('rlm-parent', 'session-cell', 8, 'model', 'trusted-cell', True)");
			const codeResult = await provisioner.execute(
				"import omp\ndebug = await omp.debug.sessions()\nweb = await omp.web.search('query')\ngh = await omp.github.issue(7)\nremote = await omp.remote.hosts()\nbrowser = await omp.browser.tabs()\ncomputer = await omp.computer.capabilities()\n(debug['active'], web['response']['provider'], gh['payload']['number'], remote['items'][0]['name'], len(browser['items']), computer['capabilities'])",
				{ hostContext: { ...hostContext, cellId: "code-cell", sequence: 1 } },
			);
			expect(codeResult.status).toBe("ok");
			expect(codeResult.result).toBe("(None, 'exa', 7, 'build', 0, None)");
			const firstPartyResult = await provisioner.execute(
				[
					"import linear, notion, websearch",
					"search = await websearch.run('typed search')",
					"linear_tools = await linear.linear.list_tools()",
					"notion_tools = await notion.notion.list_tools()",
					"(search, linear_tools[0]['name'], notion_tools[0]['name'])",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "first-party-cell", sequence: 2 } },
			);
			expect(firstPartyResult.status).toBe("ok");
			expect(firstPartyResult.result).toBe(`('Results for query "typed search":\\n\\nanswer', 'echo', 'echo')`);
			phase47Calls.length = 0;
			const typedResult = await provisioner.execute(
				[
					"import omp",
					"opened = await omp.browser.open('typed')",
					"navigated = await omp.browser.evaluate(opened['handle'], 'await tab.goto(\"https://example.test\"); return {url: tab.url()}')",
					"shot = await omp.browser.evaluate(opened['handle'], 'return await tab.screenshot()')",
					"browser_released = await omp.browser.release(opened['handle'])",
					"observed = await omp.computer.evaluate('return await desktop.observe()', read_only=True)",
					"keyed = await omp.computer.evaluate('await desktop.press(\"Enter\")')",
					"waited = await omp.computer.evaluate('await wait(1)', read_only=True)",
					"computer_released = await omp.computer.release()",
					"(navigated['handle'] == opened['handle'], shot['screenshots'], browser_released['closed'], observed['read_only'], keyed['read_only'], waited['read_only'], computer_released['closed'])",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "typed-cell", sequence: 2 } },
			);
			expect(typedResult.status).toBe("ok");
			expect(typedResult.result).toBe("(True, [], True, True, False, True, True)");
			expect(browserRuns.map(run => run.code)).toEqual([
				'await tab.goto("https://example.test"); return {url: tab.url()}',
				"return await tab.screenshot()",
			]);
			expect(browserRuns.every(run => run.name.startsWith("rlm-parent:browser-"))).toBe(true);
			expect(computerRuns.map(run => run.code)).toEqual([
				"return await desktop.observe()",
				'await desktop.press("Enter")',
				"await wait(1)",
			]);
			expect(computerRuns.map(run => run.snapshot)).toEqual([
				{ cwd: tempRoot, sessionId: "rlm-parent", readOnly: true },
				{ cwd: tempRoot, sessionId: "rlm-parent", readOnly: false },
				{ cwd: tempRoot, sessionId: "rlm-parent", readOnly: true },
			]);
			const phase46Result = await provisioner.execute(
				[
					"asked = await omp.ask.questions([{'id': 'choice', 'question': 'Choose', 'options': [{'label': 'A', 'description': 'first', 'preview': '# Preview'}, {'label': 'B'}], 'multi': False, 'recommended': 0}])",
					"attachments = await omp.images.attachments()",
					"generated = await omp.images.generate('diagram', style='line art', changes=['add labels'], provider='auto')",
					"plan = await omp.security.plan(target_kind='working_tree', include_paths=['src'])",
					"started = await omp.security.start(plan['plan']['id'])",
					"security_status = await omp.security.status(started['operation']['operationId'])",
					"findings = await omp.security.findings('scan-1')",
					"validation = await omp.security.validate('scan-1', 'finding-1', status='validated', summary='The cited source reproduces the issue.', evidence_ids=['evidence-1'])",
					"cancelled = await omp.security.cancel(started['operation']['operationId'])",
					"qa_report = await omp.qa.report_issue('read', 'typed host request')",
					"(asked['results'][0]['selectedOptions'], attachments['items'][0]['label'], generated['provider'], security_status['operation']['phase'], findings['findings'][0]['severity']['level'], validation['finding']['validation']['status'], cancelled['cancelled'], qa_report['outcome'])",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "phase46-cell", sequence: 3 } },
			);
			expect(phase46Result.status).toBe("ok");
			expect(phase46Result.result).toBe(
				"(['A'], 'Image #1', 'fake', 'completed', 'high', 'validated', True, 'recorded')",
			);
			expect(typedQaCalls.map(call => ({ tool: call.tool, report: call.report }))).toEqual([
				{ tool: "read", report: "typed host request" },
			]);
			// The typed request reaches only the service owner; no legacy tool operation enters the controller.
			expect(phase46Calls.map(call => call.type)).not.toContain("write");
			expect(phase46Calls.map(call => call.type)).toEqual([
				"ask.questions",
				"images.attachments",
				"images.generate",
				"security.plan",
				"security.start",
				"security.status",
				"security.findings",
				"security.validate",
				"security.cancel",
			]);
			expect(phase46Calls[0]?.data.questions).toEqual([
				{
					id: "choice",
					question: "Choose",
					options: [{ label: "A", description: "first", preview: "# Preview" }, { label: "B" }],
					multi: false,
					recommended: 0,
				},
			]);
			expect(phase46Calls[2]?.data).toMatchObject({
				subject: "diagram",
				style: "line art",
				changes: ["add labels"],
				provider: "auto",
			});
			expect(phase46Calls[3]?.data).toMatchObject({ target_kind: "working_tree", include_paths: ["src"] });
			expect(phase46Calls[7]?.data).toEqual({
				type: "security.validate",
				scan_id: "scan-1",
				finding_id: "finding-1",
				status: "validated",
				summary: "The cited source reproduces the issue.",
				evidence_ids: ["evidence-1"],
			});
			const vibeLifecycle = await provisioner.execute(
				[
					"spawned_vibe = await omp.vibe.spawn('fast', 'inspect the change')",
					"sent_vibe = await omp.vibe.send(spawned_vibe['id'], 'continue')",
					"listed_vibe = await omp.vibe.list()",
					"(spawned_vibe['id'], spawned_vibe['job_id'], sent_vibe['mode'], listed_vibe['sessions'][0]['id'])",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "vibe-lifecycle-cell", sequence: 31 } },
			);
			expect(vibeLifecycle.status).toBe("ok");
			expect(vibeLifecycle.result).toBe("('vibe-kernel', 'vibe-job-1', 'steered', 'vibe-kernel')");
			expect(vibeCalls).toEqual(["spawn:fast:inspect the change", "send:vibe-kernel:continue"]);
			vibeWaitBlocks = true;
			const vibeAbort = new AbortController();
			const blockedVibeWait = provisioner.execute(
				"await omp.vibe.wait(['vibe-kernel'], timeout_seconds=60)",
				{ hostContext: { ...hostContext, cellId: "vibe-wait-cell", sequence: 32 } },
				vibeAbort.signal,
			);
			await vibeWaitEntered.promise;
			vibeAbort.abort(new Error("cancel Vibe wait"));
			await expect(blockedVibeWait).rejects.toThrow("cancel Vibe wait");
			vibeWaitBlocks = false;
			const nextVibeCell = await provisioner.execute(
				"after_wait = await omp.vibe.list()\nremoved = await omp.vibe.kill('vibe-kernel')\n(after_wait['sessions'][0]['id'], removed['cancelled_turn'])",
				{ hostContext: { ...hostContext, cellId: "vibe-next-cell", sequence: 33 } },
			);
			expect(nextVibeCell.status).toBe("ok");
			expect(nextVibeCell.result).toBe("('vibe-kernel', True)");
			// The controller sees typed host operations only; no legacy Vibe tool name enters this path.
			expect(phase46Calls.map(call => call.type)).not.toContain("vibe_spawn");
			expect(vibeCalls).toEqual([
				"spawn:fast:inspect the change",
				"send:vibe-kernel:continue",
				"wait",
				"kill:vibe-kernel",
			]);
			const autoresearchResult = await provisioner.execute(
				[
					"ar_init = await omp.autoresearch.init('bench', 'latency', goal='reduce latency')",
					"ar_run = await omp.autoresearch.run(timeout_seconds=30)",
					"ar_log = await omp.autoresearch.log(1.0, 'keep', 'faster')",
					"ar_notes = await omp.autoresearch.notes(append_idea='try batching')",
					"(ar_init['text'], ar_run['details']['parsed_primary'], ar_log['text'], ar_notes['text'])",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "autoresearch-cell", sequence: 34 } },
			);
			expect(autoresearchResult.status).toBe("ok");
			expect(autoresearchResult.result).toBe("('init complete', 1, 'log complete', 'notes complete')");
			expect(autoresearchCalls.map(call => call.operation)).toEqual(["init", "run", "log", "notes"]);
			expect(autoresearchCalls[0]?.data).toMatchObject({
				name: "bench",
				primary_metric: "latency",
			});
			const autoresearchNextCell = await provisioner.execute("40 + 2", {
				hostContext: { ...hostContext, cellId: "autoresearch-next-cell", sequence: 35 },
			});
			expect(autoresearchNextCell.status).toBe("ok");
			expect(autoresearchNextCell.result).toBe("42");
			// The controller resolves focused extension operations; legacy provider-tool names never enter it.
			expect(autoresearchCalls.map(call => call.operation)).not.toContain("run_experiment");
			const phase47Result = await provisioner.execute(
				[
					"created = await omp.cron.create('0 9 * * *', 'report')",
					"listed = await omp.cron.list()",
					"updated = await omp.cron.update(created['job']['id'], prompt='updated')",
					"deleted = await omp.cron.delete(created['job']['id'])",
					"tools = await omp.mcp.list_tools('demo')",
					"resources = await omp.mcp.list_resources('demo')",
					"prompts = await omp.mcp.list_prompts('demo')",
					"try:",
					"    await omp.mcp.call_tool('demo', 'fail')",
					"except RuntimeError as error:",
					"    tool_error = str(error)",
					"templates = await omp.mcp.resource_templates('demo')",
					"notification = await omp.mcp.wait_notification('demo', 'changed', timeout=1)",
					"refreshed = await omp.mcp.refresh('demo')",
					"'|'.join(map(str, (listed['jobs'][0]['id'], updated['job']['prompt'], deleted['deleted'], tools[0]['name'], resources['resources'][0]['uri'], prompts[0]['name'], 'denied' in tool_error, templates[0]['uriTemplate'], notification['params']['id'], refreshed['connection'])))",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "phase47-cell", sequence: 4 } },
			);
			if (phase47Result.status !== "ok") {
				throw new Error(`phase 4.7 cell failed: ${phase47Result.stderr} ${JSON.stringify(phase47Result.errors)}`);
			}
			expect(phase47Result.result).toBe(
				"'cron-1|updated|True|echo|demo://one|summarize|True|demo://{id}|1|connected'",
			);
			expect(phase47Calls.map(call => call.type)).toEqual([
				"cron.create",
				"cron.list",
				"cron.update",
				"cron.delete",
				"mcp.list_tools",
				"mcp.list_resources",
				"mcp.list_prompts",
				"mcp.call_tool",
				"mcp.resource_templates",
				"mcp.wait_notification",
				"mcp.refresh",
			]);
			expect(phase47Calls[2]?.data).toMatchObject({ id: "cron-1", prompt: "updated" });
			const spawned = await provisioner.execute(
				"import rlm\nhandle = await rlm('Inspect this.', name='child-one', model='provider/model', service_tier='flex')\n(handle.rlm_child_id, handle.name, handle.model)",
				{ hostContext },
			);
			expect(spawned.status).toBe("ok");
			expect(spawned.result).toBe("('child-one', 'child-one', 'provider/model')");
			expect(admissions).toHaveLength(1);
			expect(admissions[0]).toMatchObject({
				assignment: "Inspect this.",
				name: "child-one",
				model: "provider/model",
				serviceTier: "flex",
			});
			const projected = await provisioner.execute(
				"models = await rlm.find_models('model')\nchildren = await rlm.list_subagents()\ndeleted = await rlm.delete_subagent(children[0])\n(models[0].selector, models[0].concrete_selector, models[0].available, children[0].rlm_child_id, deleted.status)",
				{ hostContext: { ...hostContext, cellId: "rlm-cell-2", sequence: 2 } },
			);
			expect(projected.status).toBe("ok");
			expect(projected.result).toBe("('provider/model', 'provider/model', True, 'child-one', 'error')");
			const familyResult = await provisioner.execute(
				"import agent_message, agent_observe\n" +
					"roster = await agent_message.list_agents()\n" +
					"receipt = await agent_message.send('hello', receiver_role='child', receiver_name='child-one', message_id='agentmsg_python')\n" +
					"inbox = await agent_message.inbox(limit=1)\n" +
					"reply = await agent_message.wait(timeout=1)\n" +
					"observed = await agent_observe.recent_messages('child-one', limit=1, max_chars=80)\n" +
					"(roster['entries'][0]['relationship'], receipt['id'], inbox['messages'][0]['id'], reply['message']['id'], observed['messages'][0]['text'])",
				{ hostContext: { ...hostContext, cellId: "family-cell", sequence: 3 } },
			);
			expect(familyResult.status).toBe("ok");
			expect(familyResult.result).toBe("('child', 'agentmsg_python', 'inbox-one', 'reply-one', 'done')");
			expect(familySends).toEqual([{ message: "hello", id: "agentmsg_python" }]);
		} finally {
			await provisioner.dispose();
			await debug.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);

	test("isolates concurrent root and child kernels behind shared Task and messaging owners", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-root-child-"));
		const rootCwd = path.join(tempRoot, "root");
		const childCwd = path.join(tempRoot, "worktrees", "child");
		const rootSidecar = path.join(tempRoot, "sessions", "root", "ipython");
		const childSidecar = path.join(tempRoot, "sessions", "child", "ipython");
		await Promise.all(
			[rootCwd, childCwd, rootSidecar, childSidecar].map(directory => fs.mkdir(directory, { recursive: true })),
		);
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const admissions: Array<{ role: string; request: TaskAdmissionRequest }> = [];
		const messages: Array<{ role: string; receiver: string | undefined; message: string }> = [];
		const blocked = Promise.withResolvers<void>();
		let blockedAborted = false;
		const taskFor = (role: "root" | "child"): TaskAdmissionService => ({
			async admit(request) {
				admissions.push({ role, request });
				if (request.assignment === "cancel me") {
					blocked.resolve();
					await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							blockedAborted = true;
							reject(request.signal?.reason ?? new Error("cancelled"));
						};
						if (request.signal?.aborted) abort();
						else request.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				return {
					id: `${role}-worker`,
					name: `${role}-worker`,
					jobId: `${role}-worker`,
					sessionId: `${role}-worker-session`,
					sessionDir: path.join(tempRoot, "sessions", `${role}-worker`),
					model: "provider/model",
					cwd: role === "root" ? rootCwd : childCwd,
				};
			},
			findModels: () => [],
			async listDirectChildren() {
				return role === "root"
					? [
							{
								id: "child-runtime",
								name: "child-runtime",
								activeSessionId: "child-session",
								sessionId: "child-session",
								sessionDir: path.join(tempRoot, "sessions", "child"),
								status: "running" as const,
								lifecycleStatus: "running" as const,
							},
						]
					: [];
			},
			async deleteDirectChild() {
				throw new Error("not used");
			},
		});
		const familyFor = (role: "root" | "child"): AgentFamilyService => ({
			roster: async () =>
				role === "root"
					? {
							current: { name: "root", id: "Main", depth: 0 },
							entries: [
								{
									relationship: "child",
									name: "child-runtime",
									id: "child-runtime",
									depth: 1,
									status: "running",
								},
							],
						}
					: {
							current: { name: "child-runtime", id: "child-runtime", depth: 1 },
							entries: [{ relationship: "parent", name: "root", id: "Main", depth: 0, status: "running" }],
						},
			async send(request) {
				if (request.receiverName === "unrelated") throw new Error("unrelated agent is outside the nuclear family");
				messages.push({ role, receiver: request.receiverName, message: request.message });
				return { id: request.id, deliveryStatus: "delivered", message: request.message };
			},
			inbox: async () => ({ messages: [] }),
			wait: async () => ({ message: null }),
			observeList: async () => ({ agents: [] }),
			observeGet: async () => ({ agent: null }),
			observeRecent: async () => ({ messages: [] }),
		});
		const barrier = Promise.withResolvers<void>();
		const barrierSessions = new Set<string>();
		const handlersFor = (role: "root" | "child") =>
			composeIpythonHostHandlers(
				createFoundationalIpythonHostHandlers(),
				createRlmIpythonHostHandlers(taskFor(role)),
				createAgentFamilyIpythonHostHandlers(familyFor(role)),
				{
					"test.barrier": async request => {
						barrierSessions.add(request.sessionId);
						if (barrierSessions.size === 2) barrier.resolve();
						await barrier.promise;
						return {};
					},
				},
			);
		const root = new IpythonKernelProvisioner(
			{ cwd: rootCwd, sessionId: "root-session", sidecarDir: rootSidecar, hostHandlers: handlersFor("root") },
			{ ensureRuntime },
		);
		const child = new IpythonKernelProvisioner(
			{ cwd: childCwd, sessionId: "child-session", sidecarDir: childSidecar, hostHandlers: handlersFor("child") },
			{ ensureRuntime },
		);
		let rootIds: IpythonProcessIds | undefined;
		let childIds: IpythonProcessIds | undefined;
		const context = (
			role: "root" | "child",
			sequence: number,
		): NonNullable<Parameters<IpythonKernelProvisioner["execute"]>[1]>["hostContext"] => {
			const cwd = role === "root" ? rootCwd : childCwd;
			const sidecar = role === "root" ? rootSidecar : childSidecar;
			return {
				sessionId: `${role}-session`,
				cwd,
				cellId: `${role}-cell-${sequence}`,
				sequence,
				origin: "model",
				authority: "trusted-cell",
				allocateArtifact: async request => ({
					path: path.join(sidecar, `${role}-${request.label}.txt`),
					mimeType: request.mimeType,
					label: request.label,
					bytes: 0,
				}),
			};
		};
		try {
			await Promise.all([root.ensure(), child.ensure()]);
			rootIds = root.processIds;
			childIds = child.processIds;
			if (!rootIds || !childIds) throw new Error("root and child kernels did not start");
			expect(
				new Set([rootIds.controllerPid, rootIds.kernelPid, childIds.controllerPid, childIds.kernelPid]).size,
			).toBe(4);
			const rootCode = [
				"import agent_message, json, rlm",
				"from rlm import host_request",
				"from omp import session",
				"await host_request('test.barrier')",
				"info = await session.info()",
				"artifact = await session.allocate_artifact('proof', mime_type='text/plain', suffix='.txt')",
				"spawned = await rlm('root work', name='root-worker', isolated=False)",
				"children = await rlm.list_subagents()",
				"roster = await agent_message.list_agents()",
				"receipt = await agent_message.send('hello child', receiver_role='child', receiver_name='child-runtime')",
				"print(json.dumps({'info': info, 'artifact': artifact, 'spawned': spawned.name, 'children': [item.rlm_child_id for item in children], 'relations': [item['relationship'] for item in roster['entries']], 'receipt': receipt['deliveryStatus']}, sort_keys=True))",
			].join("\n");
			const childCode = [
				"import agent_message, json, rlm",
				"from rlm import host_request",
				"from omp import session",
				"await host_request('test.barrier')",
				"info = await session.info()",
				"artifact = await session.allocate_artifact('proof', mime_type='text/plain', suffix='.txt')",
				"spawned = await rlm('child work', name='child-worker', isolated=True, apply=False, merge='patch')",
				"children = await rlm.list_subagents()",
				"roster = await agent_message.list_agents()",
				"try:",
				"    await agent_message.send('escape', receiver_role='sibling', receiver_name='unrelated')",
				"    rejection = ''",
				"except RuntimeError as error:",
				"    rejection = str(error)",
				"print(json.dumps({'info': info, 'artifact': artifact, 'spawned': spawned.name, 'children': [item.rlm_child_id for item in children], 'relations': [item['relationship'] for item in roster['entries']], 'rejection': rejection}, sort_keys=True))",
			].join("\n");
			const [rootResult, childResult] = await Promise.all([
				root.execute(rootCode, { hostContext: context("root", 1) }),
				child.execute(childCode, { hostContext: context("child", 1) }),
			]);
			if (rootResult.status !== "ok") {
				throw new Error(`root cell failed: ${rootResult.stderr} ${JSON.stringify(rootResult.errors)}`);
			}
			if (childResult.status !== "ok") {
				throw new Error(`child cell failed: ${childResult.stderr} ${JSON.stringify(childResult.errors)}`);
			}
			const rootPayload = JSON.parse(rootResult.stdout.trim()) as Record<string, unknown>;
			const childPayload = JSON.parse(childResult.stdout.trim()) as Record<string, unknown>;
			expect(rootPayload).toMatchObject({
				info: { sessionId: "root-session", cwd: rootCwd },
				artifact: { artifact: { path: path.join(rootSidecar, "root-proof.txt") } },
				spawned: "root-worker",
				children: ["child-runtime"],
				relations: ["child"],
				receipt: "delivered",
			});
			expect(childPayload).toMatchObject({
				info: { sessionId: "child-session", cwd: childCwd },
				artifact: { artifact: { path: path.join(childSidecar, "child-proof.txt") } },
				spawned: "child-worker",
				children: [],
				relations: ["parent"],
			});
			expect(String(childPayload.rejection)).toContain("outside the nuclear family");
			expect(barrierSessions).toEqual(new Set(["root-session", "child-session"]));
			const policies = admissions.map(item => ({ role: item.role, isolation: item.request.isolation }));
			expect(policies).toHaveLength(2);
			expect(policies).toEqual(
				expect.arrayContaining([
					{ role: "root", isolation: { requested: false } },
					{ role: "child", isolation: { requested: true, apply: false, merge: "patch" } },
				]),
			);
			expect(messages).toEqual([{ role: "root", receiver: "child-runtime", message: "hello child" }]);

			const cancelling = child.execute("import rlm\nawait rlm('cancel me')", { hostContext: context("child", 2) });
			await blocked.promise;
			await child.interrupt();
			const cancelled = await cancelling;
			expect(cancelled.status).toBe("aborted");
			expect(blockedAborted).toBe(true);
		} finally {
			await Promise.all([root.dispose(), child.dispose()]);
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of [rootIds, childIds]) {
			if (!ids) continue;
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);

	test("restores a session snapshot before installing fresh reserved names", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-provisioner-"));
		const home = path.join(tempRoot, "home");
		const sidecarDir = path.join(tempRoot, "sidecar");
		await fs.mkdir(home);
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const baseOptions = {
			cwd: tempRoot,
			sessionId: "persistent-session",
			sidecarDir,
			environment: {
				HOME: home,
				PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				ANTHROPIC_API_KEY: "must-not-reach-kernel",
			},
			hostHandlers: {
				"session.info": (request: IpythonHostRequest) => ({
					sessionId: request.sessionId,
					cwd: request.cwd,
					cellId: request.cellId,
					sequence: request.sequence,
					origin: request.origin,
					authority: request.authority,
				}),
			},
			bootstrapCode: "rlm = {'generation': 'fresh'}\nomp = {'generation': 'fresh'}",
		} as const;
		let firstIds: IpythonProcessIds | undefined;
		let secondIds: IpythonProcessIds | undefined;
		try {
			const firstProgress: IpythonStartupProgress[] = [];
			const first = new IpythonKernelProvisioner(baseOptions, { ensureRuntime });
			await first.ensure(progress => firstProgress.push(progress));
			firstIds = first.processIds;
			expect(first.lastRestore).toMatchObject({ missing: true, restored: [] });
			const reservedModules = await first.execute(
				"import importlib; (hasattr(importlib.import_module('rlm'), 'run'), hasattr(importlib.import_module('omp'), 'capabilities'))",
			);
			expect(reservedModules.result).toBe("(True, True)");
			const hostInfo = await first.execute(
				"import importlib; importlib.import_module('rlm').host_request_sync('session.info')",
				{
					hostContext: {
						sessionId: "persistent-session",
						cwd: tempRoot,
						cellId: "provisioner-cell",
						sequence: 4,
						origin: "model",
						authority: "trusted-cell",
					},
				},
			);
			expect(hostInfo.status).toBe("ok");
			expect(hostInfo.result).toContain("'cellId': 'provisioner-cell'");
			expect(hostInfo.result).toContain("'sessionId': 'persistent-session'");
			const environment = await first.execute(
				"import os\nprint(os.environ['OMP_SESSION_ID'])\nprint(os.environ['OMP_SESSION_CWD'])\nprint(os.environ['OMP_SESSION_ARTIFACT_DIR'])\nprint('ANTHROPIC_API_KEY' in os.environ)",
			);
			expect(environment.stdout.split("\n")).toEqual(["persistent-session", tempRoot, sidecarDir, "False", ""]);
			const stored = await first.execute("persistent_value = 41\nasyncio = 'stale'\nrlm = 'stale'\nomp = 'stale'");
			expect(stored.status).toBe("ok");
			const snapshot = await first.flushSnapshot();
			expect(snapshot?.saved).toContain("persistent_value");
			expect(snapshot?.saved).not.toContain("asyncio");
			expect(snapshot?.saved).not.toContain("rlm");
			expect(snapshot?.saved).not.toContain("omp");
			await first.dispose();

			const second = new IpythonKernelProvisioner(baseOptions, { ensureRuntime });
			await second.ensure();
			secondIds = second.processIds;
			expect(second.lastRestore).toMatchObject({ missing: false });
			expect(second.lastRestore?.restored).toContain("persistent_value");
			const resumed = await second.execute(
				"(persistent_value + 1, asyncio.__name__, rlm['generation'], omp['generation'])",
			);
			expect(resumed.status).toBe("ok");
			expect(resumed.result).toBe("(42, 'asyncio', 'fresh', 'fresh')");
			await second.dispose();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of [firstIds, secondIds]) {
			if (!ids) continue;
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);
});

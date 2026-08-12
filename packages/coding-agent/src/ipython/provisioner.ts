import * as path from "node:path";
import { withIpythonBootPermit } from "./boot-gate";
import {
	IpythonController,
	type IpythonControllerOptions,
	type IpythonExecuteOptions,
	type IpythonExecutionResult,
	type IpythonExtensionHostHandlerResolver,
	type IpythonHostHandler,
	type IpythonProcessIds,
	type IpythonRestoreResult,
	type IpythonSnapshotResult,
} from "./controller";
import type { PythonSkillPackage } from "./python-packages";
import { type EnsureIpythonRuntimeOptions, ensureIpythonRuntime, type IpythonRuntime } from "./runtime-bootstrap";

export const IPYTHON_PRELOAD_NAMES = ["rlm", "omp", "helpers", "show", "rg", "run"] as const;

const SESSION_BOOTSTRAP_CODE = `
import asyncio as _omp_runtime_asyncio
import importlib as _omp_runtime_importlib
import os as _omp_runtime_os
import sys as _omp_runtime_sys
_omp_runtime_paths = _omp_runtime_os.environ.get("OMP_IPYTHON_RUNTIME_PATH", "").split(_omp_runtime_os.pathsep)
for _omp_runtime_path in reversed(_omp_runtime_paths):
    if _omp_runtime_path:
        if _omp_runtime_path in _omp_runtime_sys.path:
            _omp_runtime_sys.path.remove(_omp_runtime_path)
        _omp_runtime_sys.path.insert(0, _omp_runtime_path)
asyncio = _omp_runtime_asyncio
rlm = _omp_runtime_importlib.import_module("rlm")
omp = _omp_runtime_importlib.import_module("omp")
omp.session._install_namespace_tracker()
helpers = _omp_runtime_importlib.import_module("helpers")
show = helpers.show
rg = helpers.rg
run = helpers.run
agent_message = _omp_runtime_importlib.import_module("agent_message")
agent_observe = _omp_runtime_importlib.import_module("agent_observe")
attach_image = _omp_runtime_importlib.import_module("attach_image")
compact = _omp_runtime_importlib.import_module("compact")
edit = _omp_runtime_importlib.import_module("edit")
goal = _omp_runtime_importlib.import_module("goal")
refine = _omp_runtime_importlib.import_module("refine")
rlm_heartbeat = _omp_runtime_importlib.import_module("rlm_heartbeat")
websearch = _omp_runtime_importlib.import_module("websearch")
linear = _omp_runtime_importlib.import_module("linear")
notion = _omp_runtime_importlib.import_module("notion")
_omp_runtime_baseline_modules = frozenset(_omp_runtime_sys.modules)
get_ipython().colors = "NoColor"
`.trim();

export type IpythonStartupStage = "gate" | "runtime" | "controller" | "restore" | "bootstrap" | "ready";

export interface IpythonStartupProgress {
	readonly stage: IpythonStartupStage;
	readonly message: string;
}

export type IpythonStartupProgressHandler = (progress: IpythonStartupProgress) => void;

export interface IpythonKernelController {
	readonly processIds: IpythonProcessIds | undefined;
	start(): Promise<void>;
	execute(code: string, options?: IpythonExecuteOptions, signal?: AbortSignal): Promise<IpythonExecutionResult>;
	snapshot(path: string, maxBytes?: number): Promise<IpythonSnapshotResult>;
	restore(path: string): Promise<IpythonRestoreResult>;
	interrupt(): Promise<void>;
	dispose(): Promise<void>;
}

export interface IpythonReadyStatus {
	readonly restart: boolean;
	readonly namespaceReset?: boolean;
	readonly restoredPreloads?: readonly string[];
	readonly recoveryError?: string;
}

export interface IpythonKernelProvisionerOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly sidecarDir?: string;
	readonly snapshotPath?: string;
	readonly restorePath?: string | null;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly hostHandlers?: Readonly<Record<string, IpythonHostHandler>>;
	readonly extensionHostHandlerResolver?: IpythonExtensionHostHandlerResolver;
	readonly extensionHostOperations?: () => readonly string[];
	readonly bootstrapCode?: string;
	readonly readyGate?: Promise<unknown>;
	readonly runtime?: Omit<EnsureIpythonRuntimeOptions, "environment" | "signal" | "onProgress">;
	readonly pythonPackages?: readonly PythonSkillPackage[];
	readonly onRestore?: (result: IpythonRestoreResult) => void;
	readonly onReady?: (processIds: IpythonProcessIds, status: IpythonReadyStatus) => void;
}

export interface IpythonProvisionerDependencies {
	readonly ensureRuntime?: (options: EnsureIpythonRuntimeOptions) => Promise<IpythonRuntime>;
	readonly createController?: (options: IpythonControllerOptions) => IpythonKernelController;
	readonly withBootPermit?: <T>(boot: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
}

export function ipythonSnapshotPath(sidecarDir: string): string {
	return path.join(sidecarDir, "ipython", "kernel-state.dill");
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return work;
	if (signal.aborted) return Promise.reject(abortError(signal));
	const { promise, reject } = Promise.withResolvers<T>();
	const onAbort = () => reject(abortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([work, promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

function errorText(result: IpythonExecutionResult): string {
	return [result.stderr, ...result.errors.flatMap(error => error.traceback)].filter(Boolean).join("\n");
}

/** Lazily creates and owns one controller and one child kernel for one OMP session. */
export class IpythonKernelProvisioner {
	readonly #options: IpythonKernelProvisionerOptions;
	readonly #ensureRuntime: NonNullable<IpythonProvisionerDependencies["ensureRuntime"]>;
	readonly #createController: NonNullable<IpythonProvisionerDependencies["createController"]>;
	readonly #withBootPermit: NonNullable<IpythonProvisionerDependencies["withBootPermit"]>;
	readonly #lifecycleAbort = new AbortController();
	readonly #progressListeners = new Set<IpythonStartupProgressHandler>();
	#lastProgress: IpythonStartupProgress | undefined;
	#startup: Promise<IpythonKernelController> | undefined;
	#controller: IpythonKernelController | undefined;
	#runtime: IpythonRuntime | undefined;
	#pythonPackages: readonly PythonSkillPackage[];
	#controllerTail: Promise<void> = Promise.resolve();
	#lastRestore: IpythonRestoreResult | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: IpythonKernelProvisionerOptions, dependencies: IpythonProvisionerDependencies = {}) {
		this.#options = options;
		this.#ensureRuntime = dependencies.ensureRuntime ?? ensureIpythonRuntime;
		this.#createController =
			dependencies.createController ?? (controllerOptions => new IpythonController(controllerOptions));
		this.#withBootPermit = dependencies.withBootPermit ?? withIpythonBootPermit;
		this.#pythonPackages = [...(options.pythonPackages ?? options.runtime?.pythonPackages ?? [])];
	}

	get hasRunningKernel(): boolean {
		return this.#controller?.processIds !== undefined;
	}

	get processIds(): IpythonProcessIds | undefined {
		return this.#controller?.processIds;
	}

	get lastRestore(): IpythonRestoreResult | undefined {
		return this.#lastRestore;
	}

	get snapshotPath(): string | undefined {
		return (
			this.#options.snapshotPath ??
			(this.#options.sidecarDir ? ipythonSnapshotPath(this.#options.sidecarDir) : undefined)
		);
	}

	prewarm(): void {
		void this.ensure().catch(() => undefined);
	}

	ensure(onProgress?: IpythonStartupProgressHandler, signal?: AbortSignal): Promise<IpythonKernelController> {
		if (this.#disposed) return Promise.reject(new Error("IPython provisioner is disposed"));
		if (signal?.aborted) return Promise.reject(abortError(signal));
		if (onProgress && !this.#controller) {
			this.#progressListeners.add(onProgress);
			if (this.#lastProgress) onProgress(this.#lastProgress);
		}
		if (!this.#startup) {
			const startup = this.#start();
			this.#startup = startup;
			startup.then(
				controller => {
					if (this.#startup === startup) this.#controller = controller;
					this.#settleProgress();
				},
				() => {
					if (this.#startup === startup) this.#startup = undefined;
					this.#settleProgress();
				},
			);
		}
		return waitWithSignal(this.#startup, signal).finally(() => {
			if (onProgress) this.#progressListeners.delete(onProgress);
		});
	}

	async execute(code: string, options?: IpythonExecuteOptions, signal?: AbortSignal): Promise<IpythonExecutionResult> {
		const controller = await this.ensure(undefined, signal);
		if (signal?.aborted) throw abortError(signal);
		return await this.#withControllerLock(() => controller.execute(code, options, signal), signal);
	}

	async reloadPythonPackages(packages: readonly PythonSkillPackage[]): Promise<void> {
		if (this.#disposed) throw new Error("IPython provisioner is disposed");
		const nextPackages = [...packages];
		if (!this.#startup) {
			this.#pythonPackages = nextPackages;
			return;
		}
		const controller = await this.ensure();
		const nextRuntime = await this.#prepareRuntime(nextPackages);
		await this.#withControllerLock(async () => {
			if (this.#disposed) throw new Error("IPython provisioner is disposed");
			const currentRuntime = this.#runtime;
			if (!currentRuntime) throw new Error("IPython runtime is not prepared");
			if (!currentRuntime.sitePackagesDir || !nextRuntime.sitePackagesDir) {
				throw new Error("Managed runtime site-packages path is unavailable");
			}
			const oldOwnedPaths = [currentRuntime.sitePackagesDir, ...(currentRuntime.pythonPackagePaths ?? [])];
			const newOwnedPaths = [...(nextRuntime.pythonPackagePaths ?? []), nextRuntime.sitePackagesDir];
			const oldImports = this.#pythonPackages.map(pkg => pkg.importName);
			const newImports = nextPackages.map(pkg => pkg.importName);
			const administrativeProgram = [
				"import importlib, os, sys",
				`old_owned_paths = ${JSON.stringify(oldOwnedPaths)}`,
				`new_owned_paths = ${JSON.stringify(newOwnedPaths)}`,
				`owned_imports = ${JSON.stringify([...new Set([...oldImports, ...newImports])])}`,
				`fixed_runtime_path = ${JSON.stringify(currentRuntime.pythonPackageDir)}`,
				"saved_paths = list(sys.path)",
				"def module_uses_owned_path(module):",
				"    locations = [getattr(module, '__file__', None), *(getattr(module, '__path__', ()) or ())]",
				"    return any(isinstance(location, str) and any(os.path.commonpath((os.path.abspath(location), os.path.abspath(owned_path))) == os.path.abspath(owned_path) for owned_path in old_owned_paths) for location in locations)",
				"reload_names = {loaded_name for loaded_name, module in sys.modules.items() if loaded_name not in baseline_modules and module_uses_owned_path(module)}",
				"reload_names.update(loaded_name for loaded_name in sys.modules if any(loaded_name == name or loaded_name.startswith(name + '.') for name in owned_imports))",
				"saved_modules = {loaded_name: sys.modules[loaded_name] for loaded_name in reload_names}",
				"try:",
				"    for owned_path in old_owned_paths:",
				"        while owned_path in sys.path: sys.path.remove(owned_path)",
				"    for loaded_name in reload_names: sys.modules.pop(loaded_name, None)",
				"    if fixed_runtime_path not in sys.path: sys.path.insert(0, fixed_runtime_path)",
				"    fixed_runtime_index = sys.path.index(fixed_runtime_path)",
				"    for owned_path in reversed(new_owned_paths): sys.path.insert(fixed_runtime_index + 1, owned_path)",
				"    importlib.invalidate_caches()",
				"except BaseException:",
				"    sys.path[:] = saved_paths",
				"    for loaded_name in reload_names: sys.modules.pop(loaded_name, None)",
				"    sys.modules.update(saved_modules)",
				"    raise",
			].join("\n");
			const administrativeCell = `exec(${JSON.stringify(administrativeProgram)}, {"__builtins__": __builtins__, "baseline_modules": _omp_runtime_baseline_modules})`;
			const result = await controller.execute(administrativeCell);
			if (result.status !== "ok") throw new Error(`Failed to reload Python packages: ${errorText(result)}`);
			this.#runtime = nextRuntime;
			this.#pythonPackages = nextPackages;
		}, undefined);
	}

	async flushSnapshot(pathOverride?: string, maxBytes?: number): Promise<IpythonSnapshotResult | undefined> {
		const snapshotPath = pathOverride ?? this.snapshotPath;
		if (!snapshotPath || !this.#controller) return undefined;
		const controller = this.#controller;
		return await this.#withControllerLock(() => controller.snapshot(snapshotPath, maxBytes));
	}

	interrupt(): Promise<void> {
		return this.#controller?.interrupt() ?? Promise.resolve();
	}

	async #prepareRuntime(packages: readonly PythonSkillPackage[]): Promise<IpythonRuntime> {
		const sourceEnvironment = {
			...process.env,
			...this.#options.environment,
			PATH: this.#options.environment?.PATH ?? process.env.PATH,
			NO_COLOR: "1",
			OMP_SESSION_CWD: this.#options.cwd,
			OMP_SESSION_ID: this.#options.sessionId,
			...(this.#options.sidecarDir ? { OMP_SESSION_ARTIFACT_DIR: this.#options.sidecarDir } : {}),
		};
		return await this.#ensureRuntime({
			...this.#options.runtime,
			pythonPackages: packages,
			environment: sourceEnvironment,
			signal: this.#lifecycleAbort.signal,
			onProgress: message => this.#emitProgress("runtime", message),
		});
	}

	async #withControllerLock<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const previous = this.#controllerTail;
		const task = previous.then(async () => {
			if (this.#disposed) throw new Error("IPython provisioner is disposed");
			if (signal?.aborted) throw abortError(signal);
			return await work();
		});
		this.#controllerTail = task.then(
			() => undefined,
			() => undefined,
		);
		return await waitWithSignal(task, signal);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.#lifecycleAbort.abort(new Error("IPython provisioner disposed"));
		this.#disposePromise = this.#disposeInternal();
		return this.#disposePromise;
	}

	async #disposeInternal(): Promise<void> {
		const pending = this.#startup;
		this.#startup = undefined;
		this.#controller = undefined;
		this.#settleProgress();
		if (!pending) return;
		try {
			const controller = await pending;
			await controller.dispose();
		} catch {
			// Failed startup disposes the partial controller in #start.
		}
	}

	async #start(): Promise<IpythonKernelController> {
		const signal = this.#lifecycleAbort.signal;
		let controller: IpythonKernelController | undefined;
		try {
			if (this.#options.readyGate) {
				this.#emitProgress("gate", "Waiting for the previous IPython kernel...");
				await waitWithSignal(
					this.#options.readyGate.catch(() => undefined),
					signal,
				);
			}

			this.#emitProgress("runtime", "Preparing the IPython runtime...");
			const sourceEnvironment = {
				...process.env,
				...this.#options.environment,
				PATH: this.#options.environment?.PATH ?? process.env.PATH,
				NO_COLOR: "1",
				OMP_SESSION_CWD: this.#options.cwd,
				OMP_SESSION_ID: this.#options.sessionId,
				...(this.#options.sidecarDir ? { OMP_SESSION_ARTIFACT_DIR: this.#options.sidecarDir } : {}),
			};
			const runtime = await this.#ensureRuntime({
				...this.#options.runtime,
				pythonPackages: this.#pythonPackages,
				environment: sourceEnvironment,
				signal,
				onProgress: message => this.#emitProgress("runtime", message),
			});
			if (signal.aborted) throw abortError(signal);

			this.#runtime = runtime;
			const runtimePaths = [
				...(runtime.environment.OMP_IPYTHON_RUNTIME_PATH?.split(path.delimiter).filter(Boolean) ?? [
					runtime.pythonPackageDir,
				]),
				...(runtime.pythonPackagePaths ?? []),
			].filter((entry, index, all) => all.indexOf(entry) === index);
			const hostCapabilityCensus = (): string[] =>
				[
					"capability.census",
					...Object.keys(this.#options.hostHandlers ?? {}),
					...(this.#options.extensionHostOperations?.() ?? []),
				]
					.filter((entry, index, all) => all.indexOf(entry) === index)
					.sort();
			const negotiatedHostHandlers = Object.freeze({
				...this.#options.hostHandlers,
				"capability.census": () => ({ operations: hostCapabilityCensus() }),
			});
			const startingController = this.#createController({
				pythonExecutable: runtime.pythonExecutable,
				cwd: this.#options.cwd,
				env: {
					...runtime.environment,
					OMP_HOST_CAPABILITY_CENSUS: JSON.stringify(hostCapabilityCensus()),
					OMP_IPYTHON_RUNTIME_PATH: runtimePaths.join(path.delimiter),
				},
				hostHandlers: negotiatedHostHandlers,
				extensionHostHandlerResolver: this.#options.extensionHostHandlerResolver,
				onReady: (processIds, status) => this.#controllerReady(startingController, processIds, status),
			});
			controller = startingController;
			this.#emitProgress("controller", "Starting the IPython controller and kernel...");
			await this.#withBootPermit(() => waitWithSignal(startingController.start(), signal), signal);

			const restorePath =
				this.#options.restorePath === null ? undefined : (this.#options.restorePath ?? this.snapshotPath);
			if (restorePath) {
				this.#emitProgress("restore", "Restoring IPython state...");
				const restore = await waitWithSignal(controller.restore(restorePath), signal);
				this.#lastRestore = restore;
				this.#options.onRestore?.(restore);
			}

			this.#emitProgress("bootstrap", "Preparing the session IPython namespace...");
			const bootstrap = await waitWithSignal(controller.execute(this.#bootstrapCode()), signal);
			if (bootstrap.status !== "ok") {
				throw new Error(`Failed to prepare the session IPython namespace:\n${errorText(bootstrap)}`);
			}
			const restoredPins = this.#lastRestore?.pins ?? [];
			if (restoredPins.length > 0) {
				const pinsCode = `import omp as _omp_runtime_pins; _omp_runtime_pins.session._restore_pins(tuple(${JSON.stringify(restoredPins)})); del _omp_runtime_pins`;
				const pins = await waitWithSignal(controller.execute(pinsCode), signal);
				if (pins.status !== "ok") throw new Error(`Failed to restore IPython pins:\n${errorText(pins)}`);
			}

			if (signal.aborted) throw abortError(signal);
			this.#emitProgress("ready", "IPython kernel ready");
			return controller;
		} catch (error) {
			await controller?.dispose().catch(() => undefined);
			throw error;
		}
	}

	#bootstrapCode(): string {
		return [SESSION_BOOTSTRAP_CODE, this.#options.bootstrapCode?.trim()].filter(Boolean).join("\n\n");
	}

	#controllerReady(
		controller: IpythonKernelController,
		processIds: IpythonProcessIds,
		status: { readonly restart: boolean },
	): void {
		if (!status.restart) {
			this.#options.onReady?.(processIds, status);
			return;
		}
		void this.#withControllerLock(async () => {
			const bootstrap = await controller.execute(this.#bootstrapCode());
			if (bootstrap.status !== "ok") {
				throw new Error(`Failed to restore IPython preloads after restart: ${errorText(bootstrap)}`);
			}
		}).then(
			() =>
				this.#options.onReady?.(processIds, {
					restart: true,
					namespaceReset: true,
					restoredPreloads: IPYTHON_PRELOAD_NAMES,
				}),
			error =>
				this.#options.onReady?.(processIds, {
					restart: true,
					namespaceReset: true,
					restoredPreloads: [],
					recoveryError: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
				}),
		);
	}

	#emitProgress(stage: IpythonStartupStage, message: string): void {
		const progress = { stage, message } as const;
		this.#lastProgress = progress;
		for (const listener of this.#progressListeners) listener(progress);
	}

	#settleProgress(): void {
		this.#lastProgress = undefined;
		this.#progressListeners.clear();
	}
}

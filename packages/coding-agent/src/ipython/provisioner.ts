import * as path from "node:path";
import { withIpythonBootPermit } from "./boot-gate";
import {
	IpythonController,
	type IpythonControllerOptions,
	type IpythonExecuteOptions,
	type IpythonExecutionResult,
	type IpythonHostHandler,
	type IpythonProcessIds,
	type IpythonRestoreResult,
	type IpythonSnapshotResult,
} from "./controller";
import { type EnsureIpythonRuntimeOptions, ensureIpythonRuntime, type IpythonRuntime } from "./runtime-bootstrap";

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
agent_message = _omp_runtime_importlib.import_module("agent_message")
agent_observe = _omp_runtime_importlib.import_module("agent_observe")
attach_image = _omp_runtime_importlib.import_module("attach_image")
compact = _omp_runtime_importlib.import_module("compact")
edit = _omp_runtime_importlib.import_module("edit")
goal = _omp_runtime_importlib.import_module("goal")
refine = _omp_runtime_importlib.import_module("refine")
rlm_heartbeat = _omp_runtime_importlib.import_module("rlm_heartbeat")
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
	execute(code: string, options?: IpythonExecuteOptions): Promise<IpythonExecutionResult>;
	snapshot(path: string, maxBytes?: number): Promise<IpythonSnapshotResult>;
	restore(path: string): Promise<IpythonRestoreResult>;
	interrupt(): Promise<void>;
	dispose(): Promise<void>;
}

export interface IpythonKernelProvisionerOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly sidecarDir?: string;
	readonly snapshotPath?: string;
	readonly restorePath?: string | null;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly pythonPaths?: readonly string[];
	readonly hostHandlers?: Readonly<Record<string, IpythonHostHandler>>;
	readonly bootstrapCode?: string;
	readonly readyGate?: Promise<unknown>;
	readonly runtime?: Omit<EnsureIpythonRuntimeOptions, "environment" | "signal" | "onProgress">;
	readonly onRestore?: (result: IpythonRestoreResult) => void;
	readonly onReady?: (processIds: IpythonProcessIds, status: { readonly restart: boolean }) => void;
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
	#lastRestore: IpythonRestoreResult | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(options: IpythonKernelProvisionerOptions, dependencies: IpythonProvisionerDependencies = {}) {
		this.#options = options;
		this.#ensureRuntime = dependencies.ensureRuntime ?? ensureIpythonRuntime;
		this.#createController =
			dependencies.createController ?? (controllerOptions => new IpythonController(controllerOptions));
		this.#withBootPermit = dependencies.withBootPermit ?? withIpythonBootPermit;
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
		const interrupt = () => void controller.interrupt();
		signal?.addEventListener("abort", interrupt, { once: true });
		const execution = controller.execute(code, options);
		if (signal?.aborted) interrupt();
		try {
			return await execution;
		} finally {
			signal?.removeEventListener("abort", interrupt);
		}
	}

	async flushSnapshot(pathOverride?: string, maxBytes?: number): Promise<IpythonSnapshotResult | undefined> {
		const snapshotPath = pathOverride ?? this.snapshotPath;
		if (!snapshotPath || !this.#controller) return undefined;
		return await this.#controller.snapshot(snapshotPath, maxBytes);
	}

	interrupt(): Promise<void> {
		return this.#controller?.interrupt() ?? Promise.resolve();
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
				...this.#options.environment,
				NO_COLOR: "1",
				OMP_SESSION_CWD: this.#options.cwd,
				OMP_SESSION_ID: this.#options.sessionId,
				...(this.#options.sidecarDir ? { OMP_SESSION_ARTIFACT_DIR: this.#options.sidecarDir } : {}),
			};
			const runtime = await this.#ensureRuntime({
				...this.#options.runtime,
				environment: sourceEnvironment,
				signal,
				onProgress: message => this.#emitProgress("runtime", message),
			});
			if (signal.aborted) throw abortError(signal);

			const runtimePaths = [
				...(runtime.environment.OMP_IPYTHON_RUNTIME_PATH?.split(path.delimiter).filter(Boolean) ?? [
					runtime.pythonPackageDir,
				]),
				...(this.#options.pythonPaths ?? []),
			];
			const startingController = this.#createController({
				pythonExecutable: runtime.pythonExecutable,
				cwd: this.#options.cwd,
				env: {
					...runtime.environment,
					OMP_IPYTHON_RUNTIME_PATH: runtimePaths.join(path.delimiter),
				},
				hostHandlers: this.#options.hostHandlers,
				onReady: this.#options.onReady,
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
			const bootstrapCode = [SESSION_BOOTSTRAP_CODE, this.#options.bootstrapCode?.trim()]
				.filter(Boolean)
				.join("\n\n");
			const bootstrap = await waitWithSignal(controller.execute(bootstrapCode), signal);
			if (bootstrap.status !== "ok") {
				throw new Error(`Failed to prepare the session IPython namespace:\n${errorText(bootstrap)}`);
			}
			if (signal.aborted) throw abortError(signal);
			this.#emitProgress("ready", "IPython kernel ready");
			return controller;
		} catch (error) {
			await controller?.dispose().catch(() => undefined);
			throw error;
		}
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

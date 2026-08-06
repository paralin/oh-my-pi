import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, getIpythonRuntimeDir, ptree, withFileLock } from "@oh-my-pi/pi-utils";
import { ipythonBootstrapEnvironment, ipythonEnvironment } from "./environment";
import { IPYTHON_PYTHON_ASSETS, ipythonPythonAssetHash } from "./python-assets";
import runtimeProject from "./runtime/pyproject.toml" with { type: "text" };
import runtimeLock from "./runtime/uv.lock" with { type: "text" };

const RUNTIME_SCHEMA = 2;
const PYTHON_ASSET_HASH = ipythonPythonAssetHash();
const MANAGED_PYTHON_VERSION = "3.11.15";
const BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1_000;
const LOCK_RETRIES = 6_000;
const LOCK_RETRY_DELAY_MS = 100;
export const IPYTHON_RUNTIME_PACKAGES = Object.freeze({
	dill: "0.4.1",
	ipykernel: "7.3.0",
	"jupyter-client": "8.9.1",
	pyzmq: "26.4.0",
});

const READY_SCRIPT = [
	"import importlib.metadata as m, sys",
	"assert sys.version_info[:3] == (3, 11, 15)",
	`expected = ${JSON.stringify(IPYTHON_RUNTIME_PACKAGES)}`,
	"assert all(m.version(name) == version for name, version in expected.items())",
	"import pathlib",
	"package_dir = pathlib.Path(sys.argv[1])",
	"assert (package_dir / '.omp-assets').read_text().strip() == sys.argv[2]",
	"sys.path.insert(0, str(package_dir))",
	"import dill, ipykernel, jupyter_client, zmq, rlm, omp",
].join("\n");

export interface EnsureIpythonRuntimeOptions {
	readonly runtimeRoot?: string;
	readonly uvExecutable?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly cacheKeyParts?: readonly string[];
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onProgress?: (message: string) => void;
}

export interface IpythonRuntime {
	readonly pythonExecutable: string;
	readonly runtimeDir: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly pythonPackageDir: string;
}

interface IpythonRuntimeBase {
	readonly pythonExecutable: string;
	readonly runtimeDir: string;
}

interface InFlightRuntime {
	readonly promise: Promise<IpythonRuntimeBase>;
	readonly abortController: AbortController;
	readonly progressListeners: Set<(message: string) => void>;
	lastProgress: string | undefined;
	waiters: number;
	settled: boolean;
}

const inFlight = new Map<string, InFlightRuntime>();

function runtimeHash(cacheKeyParts: readonly string[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`schema:${RUNTIME_SCHEMA}\0python:${MANAGED_PYTHON_VERSION}\0`);
	hasher.update(runtimeProject);
	hasher.update("\0");
	hasher.update(runtimeLock);
	hasher.update(`\0python-assets:${PYTHON_ASSET_HASH}`);
	for (const part of cacheKeyParts) {
		hasher.update(`\0${part.length}:`);
		hasher.update(part);
	}
	return hasher.digest("hex");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

function emitRuntimeProgress(entry: InFlightRuntime, message: string): void {
	entry.lastProgress = message;
	for (const listener of entry.progressListeners) {
		try {
			listener(message);
		} catch {
			// Progress listeners cannot control the shared bootstrap lifecycle.
		}
	}
}

function waitForSharedRuntime(
	entry: InFlightRuntime,
	signal: AbortSignal | undefined,
	onProgress: ((message: string) => void) | undefined,
): Promise<IpythonRuntimeBase> {
	if (signal?.aborted) return Promise.reject(abortError(signal));
	entry.waiters += 1;
	if (onProgress) {
		entry.progressListeners.add(onProgress);
		if (entry.lastProgress !== undefined) {
			try {
				onProgress(entry.lastProgress);
			} catch {
				// Progress listeners cannot control the shared bootstrap lifecycle.
			}
		}
	}
	let callerAborted = false;
	const { promise, reject } = Promise.withResolvers<IpythonRuntimeBase>();
	const onAbort = signal
		? () => {
				if (callerAborted) return;
				callerAborted = true;
				reject(abortError(signal));
			}
		: undefined;
	if (signal && onAbort) {
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	}
	const wait = signal ? Promise.race([entry.promise, promise]) : entry.promise;
	return wait.finally(() => {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		if (onProgress) entry.progressListeners.delete(onProgress);
		entry.waiters -= 1;
		if (callerAborted && entry.waiters === 0 && !entry.settled) {
			entry.abortController.abort(new Error("IPython runtime bootstrap has no remaining waiters"));
			return entry.promise.then(
				() => undefined,
				() => undefined,
			);
		}
	});
}

function runtimePython(runtimeDir: string): string {
	return process.platform === "win32"
		? path.join(runtimeDir, ".venv", "Scripts", "python.exe")
		: path.join(runtimeDir, ".venv", "bin", "python");
}

function pythonPackageDir(runtimeDir: string): string {
	return path.join(runtimeDir, "python");
}

async function writePythonAssets(runtimeDir: string): Promise<void> {
	const packageDir = pythonPackageDir(runtimeDir);
	await fs.mkdir(packageDir, { recursive: true });
	for (const asset of IPYTHON_PYTHON_ASSETS) {
		const target = path.resolve(packageDir, asset.path);
		if (target !== packageDir && !target.startsWith(`${packageDir}${path.sep}`)) {
			throw new Error(`Invalid IPython Python asset path: ${asset.path}`);
		}
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, asset.content, "utf8");
	}
	await fs.writeFile(path.join(packageDir, ".omp-assets"), `${PYTHON_ASSET_HASH}\n`, "utf8");
}

async function runtimeReady(
	pythonExecutable: string,
	runtimeDir: string,
	environment: Readonly<Record<string, string>>,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const result = await ptree.exec(
			[pythonExecutable, "-I", "-c", READY_SCRIPT, pythonPackageDir(runtimeDir), PYTHON_ASSET_HASH],
			{
				allowAbort: true,
				allowNonZero: true,
				env: { ...environment },
				signal,
				stderr: "full",
				timeout: 30_000,
			},
		);
		if (result.exitError?.aborted && signal?.aborted) throw result.exitError;
		return result.ok;
	} catch (error) {
		if (signal?.aborted) throw error;
		return false;
	}
}

function resolveUv(options: EnsureIpythonRuntimeOptions, environment: Readonly<Record<string, string>>): string {
	if (options.uvExecutable) return path.resolve(options.uvExecutable);
	const executable = environment.PATH ? $which("uv", { PATH: environment.PATH }) : null;
	if (executable) return executable;
	throw new Error(
		"uv is required for the first IPython runtime bootstrap; install uv or configure an explicit uv executable",
	);
}

async function provisionRuntime(
	runtimeRoot: string,
	runtimeDir: string,
	pythonExecutable: string,
	options: EnsureIpythonRuntimeOptions,
): Promise<IpythonRuntimeBase> {
	const bootstrapEnvironment = ipythonBootstrapEnvironment(runtimeRoot, options.environment ?? process.env);
	if (await runtimeReady(pythonExecutable, runtimeDir, bootstrapEnvironment, options.signal)) {
		return { pythonExecutable, runtimeDir };
	}

	await fs.mkdir(runtimeRoot, { recursive: true });
	const lockPath = path.join(runtimeRoot, `${path.basename(runtimeDir)}.bootstrap`);
	return await withFileLock(
		lockPath,
		async () => {
			await writePythonAssets(runtimeDir);
			if (await runtimeReady(pythonExecutable, runtimeDir, bootstrapEnvironment, options.signal)) {
				return { pythonExecutable, runtimeDir };
			}

			const uv = resolveUv(options, bootstrapEnvironment);
			options.onProgress?.("Setting up the IPython runtime (first use requires network access)…");
			await fs.mkdir(runtimeDir, { recursive: true });
			await Promise.all([
				Bun.write(path.join(runtimeDir, "pyproject.toml"), runtimeProject),
				Bun.write(path.join(runtimeDir, "uv.lock"), runtimeLock),
			]);

			const result = await ptree
				.exec(
					[
						uv,
						"sync",
						"--project",
						runtimeDir,
						"--locked",
						"--no-install-project",
						"--managed-python",
						"--python",
						MANAGED_PYTHON_VERSION,
						"--no-build",
						"--no-config",
						"--default-index",
						"https://pypi.org/simple",
						"--keyring-provider",
						"disabled",
						"--color",
						"never",
						"--no-progress",
					],
					{
						allowAbort: true,
						allowNonZero: true,
						cwd: runtimeDir,
						env: bootstrapEnvironment,
						signal: options.signal,
						stderr: "full",
						timeout: options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
					},
				)
				.catch(error => {
					if (options.signal?.aborted) throw error;
					throw new Error(`Failed to launch uv for the IPython runtime: ${errorMessage(error)}`);
				});
			if (result.exitError?.aborted && options.signal?.aborted) throw result.exitError;
			if (!result.ok) {
				const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
				throw new Error(`Failed to set up the IPython runtime: ${detail}`);
			}
			if (!(await runtimeReady(pythonExecutable, runtimeDir, bootstrapEnvironment, options.signal))) {
				throw new Error("IPython runtime setup completed without the locked Python packages");
			}
			options.onProgress?.("IPython runtime ready");
			return { pythonExecutable, runtimeDir };
		},
		{ retries: LOCK_RETRIES, retryDelayMs: LOCK_RETRY_DELAY_MS, signal: options.signal },
	);
}

function startRuntimeProvision(
	runtimeRoot: string,
	runtimeDir: string,
	options: EnsureIpythonRuntimeOptions,
): InFlightRuntime {
	const abortController = new AbortController();
	const { promise, resolve, reject } = Promise.withResolvers<IpythonRuntimeBase>();
	const entry: InFlightRuntime = {
		promise,
		abortController,
		progressListeners: new Set(),
		lastProgress: undefined,
		waiters: 0,
		settled: false,
	};
	void provisionRuntime(runtimeRoot, runtimeDir, runtimePython(runtimeDir), {
		...options,
		signal: abortController.signal,
		onProgress: message => emitRuntimeProgress(entry, message),
	}).then(
		runtime => {
			entry.settled = true;
			if (inFlight.get(runtimeDir) === entry) inFlight.delete(runtimeDir);
			resolve(runtime);
		},
		error => {
			entry.settled = true;
			if (inFlight.get(runtimeDir) === entry) inFlight.delete(runtimeDir);
			reject(error);
		},
	);
	return entry;
}

/** Ensure and return the shared locked IPython runtime for this build and runtime source identity. */
export function ensureIpythonRuntime(options: EnsureIpythonRuntimeOptions = {}): Promise<IpythonRuntime> {
	if (options.signal?.aborted) return Promise.reject(abortError(options.signal));
	const runtimeRoot = path.resolve(options.runtimeRoot ?? getIpythonRuntimeDir());
	const identity = runtimeHash(options.cacheKeyParts ?? []);
	const runtimeDir = path.join(runtimeRoot, `v${RUNTIME_SCHEMA}-${identity}`);
	let shared = inFlight.get(runtimeDir);
	if (!shared) {
		shared = startRuntimeProvision(runtimeRoot, runtimeDir, options);
		inFlight.set(runtimeDir, shared);
	}
	const environment = ipythonEnvironment(options.environment ?? process.env);
	return waitForSharedRuntime(shared, options.signal, options.onProgress).then(runtime => {
		const packageDir = pythonPackageDir(runtime.runtimeDir);
		return {
			...runtime,
			pythonPackageDir: packageDir,
			environment: {
				...environment,
				OMP_IPYTHON_RUNTIME_PATH: packageDir,
			},
		};
	});
}

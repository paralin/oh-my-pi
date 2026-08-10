import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, getIpythonRuntimeDir, ptree, withFileLock } from "@oh-my-pi/pi-utils";
import { ipythonBootstrapEnvironment, ipythonEnvironment } from "./environment";
import { IPYTHON_PYTHON_ASSETS, ipythonPythonAssetHash } from "./python-assets";
import type { PythonSkillPackage } from "./python-packages";
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
	pillow: "11.3.0",
	pyzmq: "26.4.0",
});

const READY_SCRIPT = [
	"import importlib, importlib.metadata as m, importlib.util, json, pathlib, sys",
	"assert sys.version_info[:3] == (3, 11, 15)",
	`expected = ${JSON.stringify(IPYTHON_RUNTIME_PACKAGES)}`,
	"assert all(m.version(name) == version for name, version in expected.items())",
	"package_dir = pathlib.Path(sys.argv[1])",
	"assert (package_dir / '.omp-assets').read_text().strip() == sys.argv[2]",
	"for package_root in reversed(json.loads(sys.argv[3])): sys.path.insert(0, package_root)",
	"sys.path.insert(0, str(package_dir))",
	"assert all(importlib.util.find_spec(name) is not None for name in ('dill', 'ipykernel', 'jupyter_client', 'zmq', 'rlm', 'omp'))",
	"assert all(importlib.util.find_spec(package_name) is not None for package_name in json.loads(sys.argv[4]))",
].join("\n");

export interface EnsureIpythonRuntimeOptions {
	readonly runtimeRoot?: string;
	readonly uvExecutable?: string;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly cacheKeyParts?: readonly string[];
	readonly pythonPackages?: readonly PythonSkillPackage[];
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly onProgress?: (message: string) => void;
}

export interface IpythonRuntime {
	readonly pythonExecutable: string;
	readonly runtimeDir: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly pythonPackageDir: string;
	readonly sitePackagesDir?: string;
	readonly pythonPackagePaths?: readonly string[];
}

interface IpythonRuntimeBase {
	readonly pythonExecutable: string;
	readonly runtimeDir: string;
	readonly sitePackagesDir: string;
	readonly pythonPackagePaths: readonly string[];
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

export function normalizePythonProjectName(name: string): string {
	return name
		.trim()
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[-_.]+/gu, "-");
}

export function runtimePythonPackageIdentity(packages: readonly PythonSkillPackage[]): string {
	return JSON.stringify(
		packages.map(pkg => ({
			importName: pkg.importName,
			projectName: normalizePythonProjectName(pkg.projectName),
			contentHash: pkg.contentHash,
		})),
	);
}

export function runtimePythonPackageMarkerText(packages: readonly PythonSkillPackage[]): string {
	return `${runtimePythonPackageIdentity(packages)}\n`;
}

function runtimePythonPackageMarkerPath(runtimeDir: string): string {
	return path.join(runtimeDir, ".omp-python-packages");
}

function runtimePythonSitePackagesDir(runtimeDir: string): string {
	return process.platform === "win32"
		? path.join(runtimeDir, ".venv", "Lib", "site-packages")
		: path.join(
				runtimeDir,
				".venv",
				"lib",
				`python${MANAGED_PYTHON_VERSION.split(".").slice(0, 2).join(".")}`,
				"site-packages",
			);
}

function runtimeHash(cacheKeyParts: readonly string[], pythonPackages: readonly PythonSkillPackage[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(`schema:${RUNTIME_SCHEMA}\0python:${MANAGED_PYTHON_VERSION}\0`);
	hasher.update(runtimeProject);
	hasher.update("\0");
	hasher.update(runtimeLock);
	hasher.update(`\0python-assets:${PYTHON_ASSET_HASH}`);
	hasher.update(`\0python-packages:${runtimePythonPackageIdentity(pythonPackages)}`);
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

function stagedPythonPackageRoot(runtimeDir: string, index: number): string {
	return path.join(runtimeDir, "python-sources", String(index).padStart(4, "0"));
}

function stagedPythonPackagePaths(runtimeDir: string, packages: readonly PythonSkillPackage[]): string[] {
	return packages.map((pkg, index) => {
		const relativeSourceRoot = path.relative(path.resolve(pkg.packageRoot), path.resolve(pkg.sourceRoot));
		if (!relativeSourceRoot || relativeSourceRoot === ".." || relativeSourceRoot.startsWith(`..${path.sep}`)) {
			throw new Error(`Python source root escapes its package root: ${pkg.sourceRoot}`);
		}
		return path.join(stagedPythonPackageRoot(runtimeDir, index), relativeSourceRoot);
	});
}

export async function stagePythonPackageInventory(
	runtimeDir: string,
	packages: readonly PythonSkillPackage[],
): Promise<string[]> {
	const paths: string[] = [];
	for (const [index, pkg] of packages.entries()) {
		const packageRoot = path.resolve(pkg.packageRoot);
		const stageRoot = stagedPythonPackageRoot(runtimeDir, index);
		const temporaryRoot = `${stageRoot}.staging`;
		const hasher = new Bun.CryptoHasher("sha256");
		const rootStat = await fs.lstat(packageRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
			throw new Error(`Python package root is not a directory: ${packageRoot}`);
		await fs.rm(temporaryRoot, { recursive: true, force: true });
		await fs.mkdir(temporaryRoot, { recursive: true });
		try {
			for (const file of pkg.files) {
				if (path.isAbsolute(file.path) || file.path === ".." || file.path.startsWith(`..${path.sep}`)) {
					throw new Error(`Python package inventory escapes its root: ${file.path}`);
				}
				const source = path.resolve(packageRoot, file.path);
				if (source !== packageRoot && !source.startsWith(`${packageRoot}${path.sep}`)) {
					throw new Error(`Python package inventory escapes its root: ${file.path}`);
				}
				const target = path.join(temporaryRoot, file.path);
				const before = await fs.lstat(source);
				if (before.isSymbolicLink() || !before.isFile() || before.size !== file.bytes) {
					throw new Error(`Python package inventory changed during staging: ${file.path}`);
				}
				const bytes = await fs.readFile(source);
				const after = await fs.lstat(source);
				if (after.isSymbolicLink() || !after.isFile() || after.size !== file.bytes) {
					throw new Error(`Python package inventory changed during staging: ${file.path}`);
				}
				hasher.update(`${file.path.length}:${file.path}\0${file.bytes}:`);
				hasher.update(bytes);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, bytes, { flag: "wx" });
			}
			if (hasher.digest("hex") !== pkg.contentHash) {
				throw new Error(`Python package content changed during staging: ${pkg.importName}`);
			}
			await fs.rm(stageRoot, { recursive: true, force: true });
			await fs.rename(temporaryRoot, stageRoot);
		} catch (error) {
			await fs.rm(temporaryRoot, { recursive: true, force: true });
			throw error;
		}
		paths.push(path.join(stageRoot, path.relative(packageRoot, path.resolve(pkg.sourceRoot))));
	}
	return paths;
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
	packageMarkerPath: string,
	packageMarkerText: string,
	packagePaths: readonly string[],
	packageImports: readonly string[],
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		if ((await fs.readFile(packageMarkerPath, "utf8")) !== packageMarkerText) return false;
		const result = await ptree.exec(
			[
				pythonExecutable,
				"-I",
				"-c",
				READY_SCRIPT,
				pythonPackageDir(runtimeDir),
				PYTHON_ASSET_HASH,
				JSON.stringify(packagePaths),
				JSON.stringify(packageImports),
			],
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

async function executeUv(
	uv: string,
	args: readonly string[],
	cwd: string,
	environment: Readonly<Record<string, string>>,
	signal: AbortSignal | undefined,
	timeout: number,
	label: string,
): Promise<{ stdout: string; stderr: string }> {
	const result = await ptree
		.exec([uv, ...args], {
			allowAbort: true,
			allowNonZero: true,
			cwd,
			env: environment,
			signal,
			stderr: "full",
			timeout,
		})
		.catch(error => {
			if (signal?.aborted) throw error;
			throw new Error(`Failed to launch uv for ${label}: ${errorMessage(error)}`);
		});
	if (result.exitError?.aborted && signal?.aborted) throw result.exitError;
	if (!result.ok) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode ?? "unknown"}`;
		throw new Error(`Failed ${label}: ${detail}`);
	}
	return { stdout: result.stdout, stderr: result.stderr };
}

function isLocalRequirement(line: string): boolean {
	const value = line.trim().toLowerCase();
	return (
		value === "-e" ||
		value.startsWith("-e ") ||
		value === "--editable" ||
		value.startsWith("--editable ") ||
		value.startsWith("--editable=") ||
		value.startsWith("file:") ||
		value.startsWith("./") ||
		value.startsWith("../") ||
		value.startsWith("/") ||
		/\s@\s*(?:file:|\.?\.?\/|[a-z]:[\\/])/u.test(value)
	);
}

function isVcsOrDirectUrlRequirement(line: string): boolean {
	const value = line.trim().toLowerCase();
	const url = "(?:https?|ssh|git|hg|svn|bzr|file)://";
	return (
		new RegExp(`^(?:git|hg|svn|bzr)\\+${url}`, "u").test(value) ||
		new RegExp(`^${url}`, "u").test(value) ||
		new RegExp(`\\s@\\s*(?:${url}|(?:git|hg|svn|bzr)\\+)`, "u").test(value)
	);
}

export function validatePythonPackageExport(content: string, packageName: string): void {
	for (const line of content.split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (isLocalRequirement(trimmed))
			throw new Error(`uv export for ${packageName} contains a local/editable/file requirement`);
		if (isVcsOrDirectUrlRequirement(trimmed))
			throw new Error(`uv export for ${packageName} contains a VCS/direct-URL requirement`);
		if (trimmed.startsWith("--") && !trimmed.startsWith("--hash="))
			throw new Error(`uv export for ${packageName} contains an unsupported global option`);
	}
}

async function installPythonPackageDependencies(
	uv: string,
	runtimeDir: string,
	pythonExecutable: string,
	packages: readonly PythonSkillPackage[],
	environment: Readonly<Record<string, string>>,
	signal: AbortSignal | undefined,
	timeout: number,
): Promise<void> {
	if (packages.length === 0) return;
	const requirementsDir = path.join(runtimeDir, "python-packages");
	await fs.mkdir(requirementsDir, { recursive: true });
	const exports: string[] = [];
	for (const [index, pkg] of packages.entries()) {
		const packageRoot = await fs.realpath(pkg.packageRoot);
		const outputPath = path.join(requirementsDir, `${String(index).padStart(4, "0")}-${pkg.importName}.txt`);
		await executeUv(
			uv,
			["export", "--locked", "--no-emit-project", "--no-config", "--output-file", outputPath],
			packageRoot,
			environment,
			signal,
			timeout,
			`dependency export for ${pkg.importName}`,
		);
		const exported = await fs.readFile(outputPath, "utf8");
		validatePythonPackageExport(exported, pkg.importName);
		exports.push(exported);
	}
	const combinedPath = path.join(requirementsDir, "all.txt");
	await fs.writeFile(combinedPath, exports.join("\n"), "utf8");
	const hasRequirements = exports.some(content =>
		content.split(/\r?\n/u).some(line => {
			const trimmed = line.trim();
			return trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("--");
		}),
	);
	if (!hasRequirements) return;
	await executeUv(
		uv,
		[
			"pip",
			"install",
			"--python",
			pythonExecutable,
			"--require-hashes",
			"--no-deps",
			"--no-config",
			"--no-progress",
			"-r",
			combinedPath,
		],
		runtimeDir,
		environment,
		signal,
		timeout,
		"locked Python package installation",
	);
}

async function provisionRuntime(
	runtimeRoot: string,
	runtimeDir: string,
	pythonExecutable: string,
	options: EnsureIpythonRuntimeOptions,
): Promise<IpythonRuntimeBase> {
	const packages = options.pythonPackages ?? [];
	const packageMarkerText = runtimePythonPackageMarkerText(packages);
	const packageMarkerPath = runtimePythonPackageMarkerPath(runtimeDir);
	const packagePaths = stagedPythonPackagePaths(runtimeDir, packages);
	const packageImports = packages.map(pkg => pkg.importName);
	const bootstrapEnvironment = ipythonBootstrapEnvironment(runtimeRoot, options.environment ?? process.env);
	if (
		await runtimeReady(
			pythonExecutable,
			runtimeDir,
			bootstrapEnvironment,
			packageMarkerPath,
			packageMarkerText,
			packagePaths,
			packageImports,
			options.signal,
		)
	) {
		return {
			pythonExecutable,
			runtimeDir,
			sitePackagesDir: runtimePythonSitePackagesDir(runtimeDir),
			pythonPackagePaths: packagePaths,
		};
	}

	await fs.mkdir(runtimeRoot, { recursive: true });
	const lockPath = path.join(runtimeRoot, `${path.basename(runtimeDir)}.bootstrap`);
	return await withFileLock(
		lockPath,
		async () => {
			await writePythonAssets(runtimeDir);
			if (
				await runtimeReady(
					pythonExecutable,
					runtimeDir,
					bootstrapEnvironment,
					packageMarkerPath,
					packageMarkerText,
					packagePaths,
					packageImports,
					options.signal,
				)
			) {
				return {
					pythonExecutable,
					runtimeDir,
					sitePackagesDir: runtimePythonSitePackagesDir(runtimeDir),
					pythonPackagePaths: packagePaths,
				};
			}

			const uv = resolveUv(options, bootstrapEnvironment);
			options.onProgress?.("Setting up the IPython runtime (first use requires network access)…");
			await fs.mkdir(runtimeDir, { recursive: true });
			await Promise.all([
				Bun.write(path.join(runtimeDir, "pyproject.toml"), runtimeProject),
				Bun.write(path.join(runtimeDir, "uv.lock"), runtimeLock),
			]);
			await executeUv(
				uv,
				[
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
				runtimeDir,
				bootstrapEnvironment,
				options.signal,
				options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
				"set up the IPython runtime",
			);
			await installPythonPackageDependencies(
				uv,
				runtimeDir,
				pythonExecutable,
				packages,
				bootstrapEnvironment,
				options.signal,
				options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
			);
			const stagedPaths = await stagePythonPackageInventory(runtimeDir, packages);
			if (JSON.stringify(stagedPaths) !== JSON.stringify(packagePaths)) {
				throw new Error("Staged Python package paths do not match the runtime inventory");
			}
			const pendingMarkerPath = `${packageMarkerPath}.pending`;
			await fs.writeFile(pendingMarkerPath, packageMarkerText, "utf8");
			try {
				if (
					!(await runtimeReady(
						pythonExecutable,
						runtimeDir,
						bootstrapEnvironment,
						pendingMarkerPath,
						packageMarkerText,
						packagePaths,
						packageImports,
						options.signal,
					))
				) {
					throw new Error("IPython runtime setup completed without the locked Python packages");
				}
				await fs.rm(packageMarkerPath, { force: true });
				await fs.rename(pendingMarkerPath, packageMarkerPath);
			} finally {
				await fs.rm(pendingMarkerPath, { force: true });
			}
			options.onProgress?.("IPython runtime ready");
			return {
				pythonExecutable,
				runtimeDir,
				sitePackagesDir: runtimePythonSitePackagesDir(runtimeDir),
				pythonPackagePaths: packagePaths,
			};
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
	const identity = runtimeHash(options.cacheKeyParts ?? [], options.pythonPackages ?? []);
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
			sitePackagesDir: runtime.sitePackagesDir,
			pythonPackagePaths: runtime.pythonPackagePaths,
			environment: {
				...environment,
				OMP_IPYTHON_RUNTIME_PATH: packageDir,
			},
		};
	});
}

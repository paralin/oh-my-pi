import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
	ProgressInfo,
	TextGenerationPipeline,
	TextGenerationStringOutput,
	StoppingCriteria as TransformersStoppingCriteria,
} from "@huggingface/transformers";
import { getTinyModelsCacheDir, isCompiledBinary, prompt } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import tinyTitleSystemPrompt from "../prompts/system/tiny-title-system.md" with { type: "text" };
import { resolveTinyModelDevicePreference, type TinyModelDevice, tinyModelDeviceLoadOrder } from "./device";
import { resolveTinyModelDtypeOverride, type TinyModelDtype } from "./dtype";
import {
	getTinyLocalModelSpec,
	type TinyLocalModelKey,
	type TinyTitleLocalModelKey,
	type TinyTitleLocalModelSpec,
} from "./models";
import { formatTitleUserMessage, normalizeGeneratedTitle } from "./text";
import type { TinyTitleProgressEvent, TinyTitleTransport, TinyTitleWorkerInbound } from "./title-protocol";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const STOP_DECODE_WINDOW_TOKENS = 32;
const MEMORY_COMPLETION_MAX_NEW_TOKENS = 256;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(tinyTitleSystemPrompt);
const TRANSFORMERS_PACKAGE = "@huggingface/transformers";
const COMPILED_TRANSFORMERS_VERSION_SPEC = process.env.PI_COMPILED_TRANSFORMERS_VERSION_SPEC;
const sourceRequire = createRequire(import.meta.url);
const INSTALL_LOCK_ATTEMPTS = 240;
const INSTALL_LOCK_SLEEP_MS = 250;

const tinyModelDevicePreference = resolveTinyModelDevicePreference();
const tinyModelDtypeOverride = resolveTinyModelDtypeOverride();

interface TransformersRuntime {
	env: {
		cacheDir?: string;
		allowLocalModels?: boolean;
		logLevel?: unknown;
	};
	LogLevel: {
		ERROR: unknown;
	};
	StoppingCriteria: new () => TransformersStoppingCriteria;
	pipeline: (
		task: "text-generation",
		model: string,
		options: {
			device: TinyModelDevice;
			dtype: TinyModelDtype;
			progress_callback: (info: ProgressInfo) => void;
		},
	) => Promise<TextGenerationPipeline>;
}

const pipelines = new Map<TinyLocalModelKey, Promise<TextGenerationPipeline>>();

interface TransformersVersionManifest {
	optionalDependencies?: Record<string, string>;
	dependencies?: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Resolves the Transformers.js semver spec used for compiled runtime installs. */
export function resolveTransformersVersionSpecFromManifest(
	manifest: TransformersVersionManifest,
	compiledVersionSpec: string | undefined,
	readInstalledVersion: () => string,
): string {
	const versionSpec =
		manifest.optionalDependencies?.[TRANSFORMERS_PACKAGE] ?? manifest.dependencies?.[TRANSFORMERS_PACKAGE];
	if (!versionSpec) throw new Error(`${TRANSFORMERS_PACKAGE} is missing from package.json optionalDependencies`);
	if (!versionSpec.startsWith("catalog:")) return versionSpec;
	if (compiledVersionSpec) return compiledVersionSpec;
	return readInstalledVersion();
}

function readInstalledTransformersVersion(): string {
	const installed: unknown = sourceRequire(`${TRANSFORMERS_PACKAGE}/package.json`);
	if (!isRecord(installed) || typeof installed.version !== "string") {
		throw new Error(`${TRANSFORMERS_PACKAGE}/package.json is missing a string version`);
	}
	return installed.version;
}

function resolveTransformersVersionSpec(): string {
	return resolveTransformersVersionSpecFromManifest(
		packageJson,
		COMPILED_TRANSFORMERS_VERSION_SPEC,
		readInstalledTransformersVersion,
	);
}
let cachedTransformersVersionSpec: string | undefined;
/**
 * Lazily resolve (and memoize) the transformers version spec. In the
 * `catalog:` case {@link resolveTransformersVersionSpec} `require`s the
 * installed `@huggingface/transformers/package.json`, so touching it forces
 * the dependency to exist. Defer it to the compiled-binary runtime-install
 * path — which only runs when a local title model is actually generated or
 * downloaded — so loading this worker (smoke-test ping, online title path)
 * never triggers the transformers resolve/install dance.
 */
function getTransformersVersionSpec(): string {
	cachedTransformersVersionSpec ??= resolveTransformersVersionSpec();
	return cachedTransformersVersionSpec;
}
function getTransformersRuntimeKey(): string {
	return getTransformersVersionSpec().replace(/[^A-Za-z0-9._-]/g, "_");
}
let generateQueue = Promise.resolve();
let transformersRuntime: Promise<TransformersRuntime> | null = null;

function errorText(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function isErrnoCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function sendLog(
	transport: TinyTitleTransport,
	level: "debug" | "warn" | "error",
	msg: string,
	meta?: Record<string, unknown>,
): void {
	transport.send({ type: "log", level, msg, meta });
}

function getTinyTitleRuntimeDir(): string {
	return path.join(
		path.dirname(getTinyModelsCacheDir()),
		"tiny-title-runtime",
		`transformers-${getTransformersRuntimeKey()}`,
	);
}

export async function acquireTinyRuntimeInstallLock(runtimeDir: string): Promise<() => Promise<void>> {
	const lockDir = `${runtimeDir}.lock`;
	await fs.mkdir(path.dirname(lockDir), { recursive: true });
	for (let attempt = 0; attempt < INSTALL_LOCK_ATTEMPTS; attempt++) {
		try {
			await fs.mkdir(lockDir);
			return async () => {
				await fs.rm(lockDir, { recursive: true, force: true });
			};
		} catch (error) {
			if (!isErrnoCode(error, "EEXIST")) throw error;
			await Bun.sleep(INSTALL_LOCK_SLEEP_MS);
		}
	}
	throw new Error(`Timed out waiting for tiny title runtime install lock: ${lockDir}`);
}

/** Returns the absolute CommonJS entrypoint for the compiled runtime's installed Transformers.js package. */
export function compiledTransformersEntrypoint(runtimeDir: string): string {
	return path.join(runtimeDir, "node_modules", "@huggingface", "transformers", "dist", "transformers.node.cjs");
}

function compiledSharpStubEntrypoint(runtimeDir: string): string {
	return path.join(runtimeDir, "omp-sharp-stub.cjs");
}
const RUNTIME_REQUIRE_REWRITES: readonly string[] = ["onnxruntime-node", "onnxruntime-common", "sharp"];

function splitPackageSpecifier(specifier: string): { packageName: string; subpath: string | undefined } {
	if (specifier.startsWith("@")) {
		const firstSlash = specifier.indexOf("/");
		if (firstSlash < 0) return { packageName: specifier, subpath: undefined };
		const secondSlash = specifier.indexOf("/", firstSlash + 1);
		if (secondSlash < 0) return { packageName: specifier, subpath: undefined };
		return { packageName: specifier.slice(0, secondSlash), subpath: specifier.slice(secondSlash + 1) };
	}
	const slash = specifier.indexOf("/");
	if (slash < 0) return { packageName: specifier, subpath: undefined };
	return { packageName: specifier.slice(0, slash), subpath: specifier.slice(slash + 1) };
}

function packageEntrypoint(packageDir: string): string {
	const manifestText = nodeFs.readFileSync(path.join(packageDir, "package.json"), "utf8");
	const manifest: unknown = JSON.parse(manifestText);
	if (isRecord(manifest) && typeof manifest.main === "string") return path.join(packageDir, manifest.main);
	return path.join(packageDir, "index.js");
}
function runtimePackageEntrypoint(runtimeDir: string, specifier: string): string {
	const { packageName, subpath } = splitPackageSpecifier(specifier);
	const packageDir = path.join(runtimeDir, "node_modules", ...packageName.split("/"));
	return subpath ? path.join(packageDir, subpath) : packageEntrypoint(packageDir);
}

/** Rewrites compiled runtime bare requires to absolute paths Bun app-mode can resolve. */
export function rewriteCompiledRuntimeRequires(source: string, runtimeDir: string): string {
	let rewritten = source;
	for (const specifier of RUNTIME_REQUIRE_REWRITES) {
		const entrypoint =
			specifier === "sharp"
				? compiledSharpStubEntrypoint(runtimeDir)
				: runtimePackageEntrypoint(runtimeDir, specifier);
		rewritten = rewritten.replaceAll(`require("${specifier}")`, `require(${JSON.stringify(entrypoint)})`);
	}
	rewritten = rewritten.replaceAll(
		`require(${JSON.stringify(runtimePackageEntrypoint(runtimeDir, "sharp"))})`,
		`require(${JSON.stringify(compiledSharpStubEntrypoint(runtimeDir))})`,
	);
	return rewritten;
}

async function patchRuntimeRequireFile(filePath: string, runtimeDir: string): Promise<void> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return;
	const source = await file.text();
	const rewritten = rewriteCompiledRuntimeRequires(source, runtimeDir);
	if (rewritten !== source) await Bun.write(filePath, rewritten);
}

const RUNTIME_PATCH_ROOTS: readonly string[] = [
	path.join("node_modules", "@huggingface", "transformers", "dist"),
	path.join("node_modules", "onnxruntime-node", "dist"),
];
const RUNTIME_PATCH_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".cjs", ".mjs"]);

async function* walkRuntimeJsFiles(root: string): AsyncGenerator<string> {
	let entries: nodeFs.Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true });
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) yield* walkRuntimeJsFiles(entryPath);
		else if (entry.isFile() && RUNTIME_PATCH_EXTENSIONS.has(path.extname(entry.name))) yield entryPath;
	}
}

export async function patchCompiledRuntimeRequires(runtimeDir: string): Promise<void> {
	await Bun.write(compiledSharpStubEntrypoint(runtimeDir), "module.exports = {};\n");
	for (const relativeRoot of RUNTIME_PATCH_ROOTS) {
		const root = path.join(runtimeDir, relativeRoot);
		for await (const filePath of walkRuntimeJsFiles(root)) {
			await patchRuntimeRequireFile(filePath, runtimeDir);
		}
	}
}

async function isCompiledRuntimeInstalled(runtimeDir: string): Promise<boolean> {
	return Bun.file(path.join(runtimeDir, "node_modules", "@huggingface", "transformers", "package.json")).exists();
}

async function writeRuntimeManifest(runtimeDir: string): Promise<void> {
	await fs.mkdir(runtimeDir, { recursive: true });
	await Bun.write(
		path.join(runtimeDir, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: "module",
				dependencies: {
					[TRANSFORMERS_PACKAGE]: getTransformersVersionSpec(),
				},
				trustedDependencies: ["onnxruntime-node"],
			},
			null,
			"\t",
		)}\n`,
	);
}

async function readPipe(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return new Response(stream).text();
}

interface RuntimeInstallCommand {
	cmd: string[];
	cwd: string;
	env: Record<string, string | undefined>;
}

/** Builds the Bun install invocation used for compiled Transformers.js runtime dependencies. */
export function createRuntimeInstallCommand(
	runtimeDir: string,
	env: Record<string, string | undefined>,
): RuntimeInstallCommand {
	return {
		cmd: [process.execPath, "install", "--production", "--force", "--backend=copyfile"],
		cwd: runtimeDir,
		env: { ...env, BUN_BE_BUN: "1" },
	};
}

async function runRuntimeInstall(runtimeDir: string): Promise<void> {
	const install = createRuntimeInstallCommand(runtimeDir, Bun.env);
	const proc = Bun.spawn(install.cmd, {
		cwd: install.cwd,
		env: install.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		readPipe(proc.stdout as ReadableStream<Uint8Array> | null),
		readPipe(proc.stderr as ReadableStream<Uint8Array> | null),
		proc.exited,
	]);
	if (exitCode === 0) return;
	const output = `${stdout}\n${stderr}`.trim();
	throw new Error(
		`Failed to install tiny title runtime with ${process.execPath} install (exit ${exitCode}): ${output}`,
	);
}

function sendRuntimeInstallProgress(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
	status: "initiate" | "download" | "done",
): void {
	transport.send({
		type: "progress",
		id: requestId,
		event: {
			modelKey,
			status,
			name: `${TRANSFORMERS_PACKAGE}@${getTransformersVersionSpec()}`,
		},
	});
}

async function ensureCompiledTransformersRuntime(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
): Promise<string> {
	const runtimeDir = getTinyTitleRuntimeDir();
	if (await isCompiledRuntimeInstalled(runtimeDir)) {
		await patchCompiledRuntimeRequires(runtimeDir);
		return runtimeDir;
	}

	sendRuntimeInstallProgress(transport, requestId, modelKey, "initiate");
	const releaseLock = await acquireTinyRuntimeInstallLock(runtimeDir);
	try {
		if (await isCompiledRuntimeInstalled(runtimeDir)) {
			await patchCompiledRuntimeRequires(runtimeDir);
			return runtimeDir;
		}
		await writeRuntimeManifest(runtimeDir);
		sendRuntimeInstallProgress(transport, requestId, modelKey, "download");
		await runRuntimeInstall(runtimeDir);
		await patchCompiledRuntimeRequires(runtimeDir);
		sendRuntimeInstallProgress(transport, requestId, modelKey, "done");
		return runtimeDir;
	} finally {
		await releaseLock();
	}
}

function configureTransformers(transformers: TransformersRuntime): TransformersRuntime {
	transformers.env.cacheDir = getTinyModelsCacheDir();
	transformers.env.allowLocalModels = false;
	transformers.env.logLevel = transformers.LogLevel.ERROR;
	return transformers;
}

async function loadTransformers(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
): Promise<TransformersRuntime> {
	if (transformersRuntime) return transformersRuntime;
	transformersRuntime = (async () => {
		if (!isCompiledBinary()) return configureTransformers(sourceRequire(TRANSFORMERS_PACKAGE) as TransformersRuntime);
		const runtimeDir = await ensureCompiledTransformersRuntime(transport, requestId, modelKey);
		const entrypoint = compiledTransformersEntrypoint(runtimeDir);
		const require_ = createRequire(entrypoint);
		return configureTransformers(require_(entrypoint) as TransformersRuntime);
	})().catch(error => {
		transformersRuntime = null;
		throw error;
	});
	return transformersRuntime;
}

function createStopOnTextCriteria(
	transformers: TransformersRuntime,
	tokenizer: TextGenerationPipeline["tokenizer"],
	text: string,
): TransformersStoppingCriteria {
	class StopOnTextCriteria extends transformers.StoppingCriteria {
		#tokenizer: TextGenerationPipeline["tokenizer"];
		#text: string;

		constructor() {
			super();
			this.#tokenizer = tokenizer;
			this.#text = text;
		}

		_call(inputIds: number[][]): boolean[] {
			return inputIds.map(ids => {
				const tail = ids.slice(-STOP_DECODE_WINDOW_TOKENS);
				const decoded = this.#tokenizer.decode(tail, {
					skip_special_tokens: false,
					clean_up_tokenization_spaces: false,
				});
				return decoded.includes(this.#text);
			});
		}
	}
	return new StopOnTextCriteria();
}

function toProgressEvent(modelKey: TinyLocalModelKey, info: ProgressInfo): TinyTitleProgressEvent {
	if (info.status === "ready") {
		return { modelKey, status: info.status, task: info.task, model: info.model };
	}
	if (info.status === "progress_total") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
			files: info.files,
		};
	}
	if (info.status === "progress") {
		return {
			modelKey,
			status: info.status,
			name: info.name,
			file: info.file,
			progress: info.progress,
			loaded: info.loaded,
			total: info.total,
		};
	}
	return { modelKey, status: info.status, name: info.name, file: info.file };
}

function sendProgress(
	transport: TinyTitleTransport,
	id: string,
	modelKey: TinyLocalModelKey,
	info: ProgressInfo,
): void {
	transport.send({ type: "progress", id, event: toProgressEvent(modelKey, info) });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function loadPipelineOnDevice(
	transformers: TransformersRuntime,
	spec: TinyTitleLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
	device: TinyModelDevice,
): Promise<TextGenerationPipeline> {
	return transformers.pipeline("text-generation", spec.repo, {
		device,
		dtype: tinyModelDtypeOverride ?? spec.dtype,
		progress_callback: info => sendProgress(transport, requestId, modelKey, info),
	});
}

async function loadPipelineWithDeviceFallback(
	transformers: TransformersRuntime,
	spec: TinyTitleLocalModelSpec,
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
): Promise<{ generator: TextGenerationPipeline; device: TinyModelDevice }> {
	const devices = tinyModelDeviceLoadOrder(tinyModelDevicePreference);
	if (devices[0] !== tinyModelDevicePreference.device) {
		sendLog(transport, "warn", "tiny-model: requested device is unsafe in the worker; using CPU", {
			modelKey,
			repo: spec.repo,
			requestedDevice: tinyModelDevicePreference.device,
			device: devices[0],
		});
	}
	for (let i = 0; i < devices.length; i += 1) {
		const device = devices[i]!;
		try {
			return {
				generator: await loadPipelineOnDevice(transformers, spec, modelKey, transport, requestId, device),
				device,
			};
		} catch (error) {
			if (i === devices.length - 1) throw error;
			const fallbackDevice = devices[i + 1]!;
			sendLog(transport, "warn", "tiny-model: accelerated device failed; falling back", {
				modelKey,
				repo: spec.repo,
				device,
				fallbackDevice,
				error: errorMessage(error),
			});
		}
	}
	throw new Error("No tiny model devices configured");
}

async function loadPipeline(
	modelKey: TinyLocalModelKey,
	transport: TinyTitleTransport,
	requestId: string,
): Promise<TextGenerationPipeline> {
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	const cached = pipelines.get(modelKey);
	if (cached) {
		void cached
			.then(() => {
				transport.send({
					type: "progress",
					id: requestId,
					event: { modelKey, status: "ready", task: "text-generation", model: spec.repo },
				});
			})
			.catch(() => undefined);
		return cached;
	}

	const transformers = await loadTransformers(transport, requestId, modelKey);
	const startedAt = performance.now();
	const loaded = loadPipelineWithDeviceFallback(transformers, spec, modelKey, transport, requestId).then(
		({ generator, device }) => {
			sendLog(transport, "debug", "tiny-model: local model loaded", {
				modelKey,
				repo: spec.repo,
				device,
				requestedDevice: tinyModelDevicePreference.device,
				dtype: tinyModelDtypeOverride ?? spec.dtype,
				elapsedMs: Math.round(performance.now() - startedAt),
			});
			transport.send({
				type: "progress",
				id: requestId,
				event: { modelKey, status: "ready", task: "text-generation", model: spec.repo },
			});
			return generator;
		},
		error => {
			pipelines.delete(modelKey);
			throw error;
		},
	);
	pipelines.set(modelKey, loaded);
	return loaded;
}

function buildPrompt(generator: TextGenerationPipeline, message: string): string {
	const chat = [
		{ role: "system", content: TINY_TITLE_SYSTEM_PROMPT },
		{ role: "user", content: formatTitleUserMessage(message) },
	];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${generator.tokenizer.apply_chat_template(chat, chatTemplateOptions)}${TITLE_PREFILL}`;
}

function extractTinyTitle(text: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag);
}

async function generateTitle(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyTitleLocalModelKey,
	message: string,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport, requestId);
	const promptText = buildPrompt(generator, message);
	const transformers = await loadTransformers(transport, requestId, modelKey);
	const output = (await generator(promptText, {
		max_new_tokens: TITLE_MAX_NEW_TOKENS,
		do_sample: false,
		return_full_text: false,
		stopping_criteria: createStopOnTextCriteria(transformers, generator.tokenizer, TITLE_CLOSE),
	})) as TextGenerationStringOutput;
	return extractTinyTitle(output[0]?.generated_text ?? "");
}

function buildCompletionPrompt(generator: TextGenerationPipeline, promptText: string): string {
	const chat = [{ role: "user", content: promptText }];
	const chatTemplateOptions = {
		add_generation_prompt: true,
		tokenize: false,
		enable_thinking: false,
	};
	return `${generator.tokenizer.apply_chat_template(chat, chatTemplateOptions)}`;
}

/**
 * Generic single-turn completion used by Mnemopi memory tasks (fact extraction
 * and consolidation). The caller (Mnemopi) supplies the full task prompt; we
 * wrap it as the user turn, decode greedily, and return the raw text for the
 * caller's own parser. Output is capped to keep local inference latency bounded.
 */
async function generateCompletion(
	transport: TinyTitleTransport,
	requestId: string,
	modelKey: TinyLocalModelKey,
	promptText: string,
	maxTokens: number | undefined,
): Promise<string | null> {
	const generator = await loadPipeline(modelKey, transport, requestId);
	const text = buildCompletionPrompt(generator, promptText);
	const requested = maxTokens ?? MEMORY_COMPLETION_MAX_NEW_TOKENS;
	const maxNewTokens = Math.min(Math.max(1, requested), MEMORY_COMPLETION_MAX_NEW_TOKENS);
	const output = (await generator(text, {
		max_new_tokens: maxNewTokens,
		do_sample: false,
		return_full_text: false,
	})) as TextGenerationStringOutput;
	const generated = (output[0]?.generated_text ?? "").trim();
	return generated === "" ? null : generated;
}

function enqueueRequest(
	transport: TinyTitleTransport,
	request: Extract<TinyTitleWorkerInbound, { type: "generate" | "complete" | "download" }>,
): void {
	generateQueue = generateQueue.then(
		async () => {
			await handleQueuedRequest(transport, request);
		},
		async () => {
			await handleQueuedRequest(transport, request);
		},
	);
}

async function handleQueuedRequest(
	transport: TinyTitleTransport,
	request: Extract<TinyTitleWorkerInbound, { type: "generate" | "complete" | "download" }>,
): Promise<void> {
	try {
		if (request.type === "download") {
			await loadPipeline(request.modelKey, transport, request.id);
			transport.send({ type: "downloaded", id: request.id });
			return;
		}
		if (request.type === "complete") {
			const text = await generateCompletion(
				transport,
				request.id,
				request.modelKey,
				request.prompt,
				request.maxTokens,
			);
			transport.send({ type: "completion", id: request.id, text });
			return;
		}
		const title = await generateTitle(transport, request.id, request.modelKey, request.message);
		transport.send({ type: "title", id: request.id, title });
	} catch (error) {
		transport.send({ type: "error", id: request.id, error: errorText(error) });
	}
}

export function startTinyTitleWorker(transport: TinyTitleTransport): void {
	transport.onMessage(message => {
		if (message.type === "ping") {
			transport.send({ type: "pong", id: message.id });
			return;
		}
		enqueueRequest(transport, message);
	});
}

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client.js";
import type {
	DaemonOperation,
	DaemonRestartPolicy,
	DaemonRpcResult,
	DaemonSignal,
	DaemonSpec,
} from "../launch/protocol.js";
import { truncateTailBytes } from "../session/streaming-output.js";
import { terminateProcessTree } from "../subprocess/process-termination.js";
import { confineToWorkspace } from "../tools/path-utils.js";
import type { IpythonHostArtifact, IpythonHostHandlers, IpythonHostRequest } from "./controller.js";
import { ipythonEnvironment } from "./environment.js";

const MAX_STRING_CHARS = 16_384;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_TIMEOUT_MS = 3_600_000;
const PROCESS_RESULT_WINDOW_BYTES = 16 * 1024;
const PROCESS_PROGRESS_TAIL_BYTES = 1_800;
const MAX_PROCESS_PROGRESS_UPDATES = 64;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

export interface IpythonProcessServiceOptions {
	readonly client?: (cwd: string) => Promise<DaemonBrokerClient>;
	readonly enabled?: () => boolean;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string, max = MAX_STRING_CHARS): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalString(
	data: Readonly<Record<string, unknown>>,
	name: string,
	max = MAX_STRING_CHARS,
): string | undefined {
	if (data[name] === undefined) return undefined;
	return requiredString(data, name, max);
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	const value = data[name] ?? fallback;
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
	}
	return value as number;
}

function stringList(data: Readonly<Record<string, unknown>>, name: string): string[] {
	const value = data[name] ?? [];
	if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
		throw new TypeError(`${name} must be a list of at most ${MAX_ARGUMENTS} strings`);
	}
	return value.map((item, index) => {
		if (typeof item !== "string" || item.length > MAX_STRING_CHARS) {
			throw new TypeError(`${name}[${index}] must be a bounded string`);
		}
		return item;
	});
}

function environment(data: Readonly<Record<string, unknown>>): Record<string, string> {
	const value = data.env ?? {};
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length > MAX_ENVIRONMENT_ENTRIES
	) {
		throw new TypeError(`env must be an object with at most ${MAX_ENVIRONMENT_ENTRIES} entries`);
	}
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => {
			if (!key || key.length > 256 || typeof item !== "string" || item.length > MAX_STRING_CHARS) {
				throw new TypeError("env entries must have bounded string keys and values");
			}
			return [key, item];
		}),
	);
}

function processRunEnvironment(data: Readonly<Record<string, unknown>>): Record<string, string> {
	const parsed = environment(data);
	for (const [key, value] of Object.entries(parsed)) {
		if (!ENVIRONMENT_NAME.test(key) || value.includes("\0")) {
			throw new TypeError("env entries must have valid bounded string keys and values");
		}
	}
	return parsed;
}

function ready(data: Readonly<Record<string, unknown>>): DaemonSpec["ready"] {
	const value = data.ready;
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("ready must be an object");
	const source = value as Readonly<Record<string, unknown>>;
	strict(source, ["log", "port", "host", "timeout_ms"]);
	const log = optionalString(source, "log", 1_024);
	const port = source.port;
	if (port !== undefined && (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535)) {
		throw new RangeError("ready.port must be an integer from 1 through 65535");
	}
	const host = optionalString(source, "host", 255);
	if (!log && port === undefined) throw new TypeError("ready requires log or port");
	return {
		log,
		port: port as number | undefined,
		host,
		timeoutMs: integerValue(source, "timeout_ms", 30_000, 0, MAX_TIMEOUT_MS),
	};
}

function restartPolicy(data: Readonly<Record<string, unknown>>): DaemonRestartPolicy {
	const value = data.restart ?? "no";
	if (value !== "no" && value !== "on-failure" && value !== "always") {
		throw new TypeError("restart must be no, on-failure, or always");
	}
	return value;
}

function daemonSignal(data: Readonly<Record<string, unknown>>): DaemonSignal | undefined {
	const value = data.signal;
	if (value === undefined) return undefined;
	if (value !== "SIGINT" && value !== "SIGTERM" && value !== "SIGHUP" && value !== "SIGQUIT" && value !== "SIGKILL") {
		throw new TypeError("signal must be a supported process signal");
	}
	return value;
}

function projectPath(value: string, cwd: string, name: string): string {
	const confined = confineToWorkspace(value, cwd);
	if (!confined) throw new TypeError(`${name} must be a relative path inside the project`);
	return confined;
}

function startOperation(request: IpythonHostRequest): DaemonOperation {
	strict(request.data, [
		"name",
		"application",
		"args",
		"env",
		"cwd",
		"pty",
		"ready",
		"restart",
		"persist",
		"detached",
	]);
	const detached = booleanValue(request.data, "detached", false);
	const cwdInput = optionalString(request.data, "cwd", 4_096);
	return {
		op: "start",
		owner: request.sessionId,
		spec: {
			name: requiredString(request.data, "name", 48),
			application: requiredString(request.data, "application", 4_096),
			args: stringList(request.data, "args"),
			env: environment(request.data),
			cwd: cwdInput === undefined ? request.cwd : projectPath(cwdInput, request.cwd, "cwd"),
			pty: detached ? false : booleanValue(request.data, "pty", true),
			ready: ready(request.data),
			restart: restartPolicy(request.data),
			persist: booleanValue(request.data, "persist", false) || detached,
			detached,
		},
	};
}

function namedOperation(
	request: IpythonHostRequest,
	op: "describe" | "restart" | "stop" | "wait" | "logs" | "send",
): DaemonOperation {
	const name = requiredString(request.data, "name", 48);
	switch (op) {
		case "describe":
		case "restart":
			strict(request.data, ["name"]);
			return { op, name };
		case "stop":
			strict(request.data, ["name", "timeout_ms"]);
			return { op, name, timeoutMs: integerValue(request.data, "timeout_ms", 5_000, 0, MAX_TIMEOUT_MS) };
		case "wait": {
			strict(request.data, ["name", "for", "pattern", "timeout_ms"]);
			const target = request.data.for ?? "exit";
			if (target !== "ready" && target !== "exit") throw new TypeError("for must be ready or exit");
			return {
				op,
				name,
				for: target,
				pattern: optionalString(request.data, "pattern", 1_024),
				timeoutMs: integerValue(request.data, "timeout_ms", 30_000, 0, MAX_TIMEOUT_MS),
			};
		}
		case "logs":
			strict(request.data, ["name", "lines", "head", "grep", "follow", "cursor", "timeout_ms"]);
			return {
				op,
				name,
				lines: integerValue(request.data, "lines", 100, 1, 1_000),
				head: booleanValue(request.data, "head", false),
				grep: optionalString(request.data, "grep", 1_024),
				follow: booleanValue(request.data, "follow", false),
				cursor:
					request.data.cursor === undefined
						? undefined
						: integerValue(request.data, "cursor", 0, 0, Number.MAX_SAFE_INTEGER),
				timeoutMs: integerValue(request.data, "timeout_ms", 30_000, 0, MAX_TIMEOUT_MS),
			};
		case "send": {
			strict(request.data, ["name", "data", "signal"]);
			const data = optionalString(request.data, "data", MAX_STRING_CHARS);
			const signal = daemonSignal(request.data);
			if (data === undefined && signal === undefined) throw new TypeError("send requires data or signal");
			return { op, name, data, signal };
		}
	}
}

type ProcessRunState = "exited" | "signaled" | "timed_out" | "cancelled";

type PipedProcess = Subprocess<"ignore", "pipe", "pipe">;

function timeoutMilliseconds(data: Readonly<Record<string, unknown>>): number | undefined {
	const value = data.timeout;
	if (value === undefined || value === null) return undefined;
	let milliseconds: number;
	if (typeof value === "number") {
		milliseconds = value * 1_000;
	} else if (typeof value === "string") {
		const match = DURATION.exec(value.trim());
		if (!match) throw new TypeError("timeout must be seconds or a duration such as 250ms, 5s, 2m, or 1h");
		const unit = match[2];
		const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
		milliseconds = Number(match[1]) * multiplier;
	} else {
		throw new TypeError("timeout must be a number of seconds or a duration string");
	}
	if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > MAX_TIMEOUT_MS) {
		throw new RangeError(`timeout must be from 0 through ${MAX_TIMEOUT_MS / 1_000} seconds`);
	}
	return Math.round(milliseconds);
}

function boundedHead(previous: Uint8Array, chunk: Uint8Array): Uint8Array {
	const retained = Math.min(chunk.byteLength, PROCESS_RESULT_WINDOW_BYTES - previous.byteLength);
	if (retained <= 0) return previous;
	const result = new Uint8Array(previous.byteLength + retained);
	result.set(previous);
	result.set(chunk.subarray(0, retained), previous.byteLength);
	return result;
}

function boundedTail(previous: Uint8Array, chunk: Uint8Array): Uint8Array {
	if (chunk.byteLength >= PROCESS_RESULT_WINDOW_BYTES) return chunk.slice(-PROCESS_RESULT_WINDOW_BYTES);
	const retained = Math.min(previous.byteLength, PROCESS_RESULT_WINDOW_BYTES - chunk.byteLength);
	const result = new Uint8Array(retained + chunk.byteLength);
	result.set(previous.subarray(previous.byteLength - retained));
	result.set(chunk, retained);
	return result;
}

class ProcessProgressTail {
	readonly #decoder = new TextDecoder();
	#complete = "";
	#current = "";
	#pendingReturn = false;

	append(chunk: Uint8Array): void {
		this.#appendText(this.#decoder.decode(chunk, { stream: true }));
	}

	finish(): void {
		this.#appendText(this.#decoder.decode());
	}

	text(): string {
		return truncateTailBytes(`${this.#complete}${this.#current}`, PROCESS_PROGRESS_TAIL_BYTES).text;
	}

	#appendText(text: string): void {
		for (const character of text.toWellFormed()) {
			if (this.#pendingReturn) {
				this.#pendingReturn = false;
				if (character === "\n") {
					this.#commitLine();
					continue;
				}
				this.#current = "";
			}
			if (character === "\r") {
				this.#pendingReturn = true;
			} else if (character === "\n") {
				this.#commitLine();
			} else {
				this.#current = truncateTailBytes(`${this.#current}${character}`, PROCESS_PROGRESS_TAIL_BYTES).text;
			}
		}
	}

	#commitLine(): void {
		this.#complete = truncateTailBytes(`${this.#complete}${this.#current}\n`, PROCESS_PROGRESS_TAIL_BYTES).text;
		this.#current = "";
	}
}

function processProgressMessage(state: string, stdout: string, stderr: string): string {
	const sections = [state];
	if (stdout) sections.push(`stdout:\n${stdout}`);
	if (stderr) sections.push(`stderr:\n${stderr}`);
	return sections.join("\n");
}

function processRunCwd(request: IpythonHostRequest): string {
	const input = optionalString(request.data, "cwd", 4_096);
	if (input === undefined) return request.cwd;
	if (path.resolve(request.cwd, input) === path.resolve(request.cwd)) return request.cwd;
	return projectPath(input, request.cwd, "cwd");
}

function safeArgument(value: string, name: string): string {
	if (value.includes("\0")) throw new TypeError(`${name} must not contain NUL bytes`);
	return value;
}

async function runOneShotProcess(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
	strict(request.data, ["application", "args", "timeout", "cwd", "env"]);
	request.signal.throwIfAborted();
	const application = safeArgument(requiredString(request.data, "application", 4_096), "application");
	const args = stringList(request.data, "args").map((argument, index) => safeArgument(argument, `args[${index}]`));
	const timeoutMs = timeoutMilliseconds(request.data);
	const cwd = processRunCwd(request);
	const cwdStats = await fs.stat(cwd).catch(() => undefined);
	if (!cwdStats?.isDirectory()) throw new TypeError("cwd must be an existing directory inside the project");
	const env = { ...ipythonEnvironment(), ...processRunEnvironment(request.data) };
	const artifact = await request.allocateArtifact({
		label: "OMP process transcript",
		mimeType: "text/plain",
		suffix: ".txt",
	});
	if (!path.isAbsolute(artifact.path)) throw new Error("runtime artifact path must be absolute");
	request.signal.throwIfAborted();

	await using transcript = await fs.open(artifact.path, "w");
	let write = Promise.resolve();
	const append = async (bytes: string | Uint8Array): Promise<void> => {
		write = write.then(async () => {
			if (typeof bytes === "string") await transcript.write(bytes);
			else await transcript.write(bytes);
		});
		await write;
	};
	const appendChunk = async (channel: "stdout" | "stderr", chunk: Uint8Array): Promise<void> => {
		write = write.then(async () => {
			await transcript.write(`\n[${channel} ${chunk.byteLength} bytes]\n`);
			await transcript.write(chunk);
		});
		await write;
	};
	await append(
		`OMP process transcript\napplication: ${JSON.stringify(application)}\nargs: ${JSON.stringify(args)}\ncwd: ${JSON.stringify(cwd)}\n`,
	);
	await request.publishProgress("Process run started", { path: artifact.path, count: 0, unit: "bytes" });

	const startedAt = performance.now();
	const detached = process.platform !== "win32";
	let child: PipedProcess;
	try {
		child = Bun.spawn([application, ...args], {
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached,
			windowsHide: true,
		});
	} catch (error) {
		await append(`\n[spawn error]\n${error instanceof Error ? error.message : String(error)}\n`);
		throw error;
	}

	let stdoutHead: Uint8Array = new Uint8Array();
	let stderrHead: Uint8Array = new Uint8Array();
	let stdoutTail: Uint8Array = new Uint8Array();
	let stderrTail: Uint8Array = new Uint8Array();
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let progressUpdates = 0;
	let lastProgressMessage = "";
	let progress = Promise.resolve();
	const stdoutProgress = new ProcessProgressTail();
	const stderrProgress = new ProcessProgressTail();
	const publishOutputProgress = async (): Promise<void> => {
		if (progressUpdates >= MAX_PROCESS_PROGRESS_UPDATES - 2 || request.signal.aborted) return;
		const message = processProgressMessage("Process output received", stdoutProgress.text(), stderrProgress.text());
		if (message === lastProgressMessage) return;
		lastProgressMessage = message;
		progressUpdates += 1;
		const total = stdoutBytes + stderrBytes;
		progress = progress.then(() =>
			request.publishProgress(message, { path: artifact.path, count: total, unit: "bytes" }),
		);
		await progress;
	};
	const drain = async (stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr"): Promise<void> => {
		for await (const chunk of stream) {
			if (channel === "stdout") {
				stdoutBytes += chunk.byteLength;
				stdoutHead = boundedHead(stdoutHead, chunk);
				stdoutTail = boundedTail(stdoutTail, chunk);
				stdoutProgress.append(chunk);
			} else {
				stderrBytes += chunk.byteLength;
				stderrHead = boundedHead(stderrHead, chunk);
				stderrTail = boundedTail(stderrTail, chunk);
				stderrProgress.append(chunk);
			}
			await appendChunk(channel, chunk);
			await publishOutputProgress();
		}
		if (channel === "stdout") stdoutProgress.finish();
		else stderrProgress.finish();
	};
	const stdoutDone = drain(child.stdout, "stdout");
	const stderrDone = drain(child.stderr, "stderr");

	const { promise: interruption, resolve: interrupt } = Promise.withResolvers<"cancelled" | "timed_out">();
	const onAbort = () => interrupt("cancelled");
	request.signal.addEventListener("abort", onAbort, { once: true });
	if (request.signal.aborted) onAbort();
	let timer: NodeJS.Timeout | undefined;
	if (timeoutMs !== undefined) timer = setTimeout(() => interrupt("timed_out"), timeoutMs);
	let interrupted: "cancelled" | "timed_out" | undefined;
	try {
		const completion = child.exited.then(() => "exited" as const);
		const outcome = await Promise.race([completion, interruption]);
		if (outcome !== "exited") {
			interrupted = outcome;
			await terminateProcessTree(child, detached);
			await child.exited;
		} else if (detached) {
			// A one-shot leader may exit while background descendants still hold its
			// pipes. Sweep the private POSIX group before awaiting stream EOF.
			await terminateProcessTree(child, true);
		}
		await Promise.all([stdoutDone, stderrDone]);
	} finally {
		request.signal.removeEventListener("abort", onAbort);
		if (timer !== undefined) clearTimeout(timer);
	}

	const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
	const state: ProcessRunState = interrupted ?? (child.signalCode === null ? "exited" : "signaled");
	await append(
		`\n[terminal]\nstate: ${state}\nexit_code: ${child.exitCode ?? "null"}\nsignal: ${child.signalCode ?? "null"}\nduration_ms: ${durationMs}\n`,
	);
	const bytes = (await fs.stat(artifact.path)).size;
	const transcriptArtifact: IpythonHostArtifact = { ...artifact, bytes };
	if (!request.signal.aborted) {
		await request.publishProgress(
			processProgressMessage(`Process run ${state}`, stdoutProgress.text(), stderrProgress.text()),
			{
				path: artifact.path,
				count: stdoutBytes + stderrBytes,
				unit: "bytes",
			},
		);
	}
	return {
		application,
		args,
		cwd,
		state,
		exit_code: child.exitCode,
		signal: child.signalCode,
		timed_out: state === "timed_out",
		cancelled: state === "cancelled",
		duration_ms: durationMs,
		stdout_head: new TextDecoder().decode(stdoutHead),
		stderr_head: new TextDecoder().decode(stderrHead),
		stdout_tail: new TextDecoder().decode(stdoutTail),
		stderr_tail: new TextDecoder().decode(stderrTail),
		stdout_bytes: stdoutBytes,
		stderr_bytes: stderrBytes,
		stdout_omitted_bytes: Math.max(0, stdoutBytes - stdoutHead.byteLength - stdoutTail.byteLength),
		stderr_omitted_bytes: Math.max(0, stderrBytes - stderrHead.byteLength - stderrTail.byteLength),
		stdout_truncated: stdoutBytes > stdoutHead.byteLength + stdoutTail.byteLength,
		stderr_truncated: stderrBytes > stderrHead.byteLength + stderrTail.byteLength,
		transcript_path: artifact.path,
		transcript_artifact: transcriptArtifact,
	};
}

/** Exposes the retained project-scoped launch broker to the active IPython session. */
export class IpythonProcessService {
	readonly handlers: IpythonHostHandlers;
	readonly #client: (cwd: string) => Promise<DaemonBrokerClient>;
	readonly #enabled: () => boolean;

	constructor(options: IpythonProcessServiceOptions = {}) {
		this.#client = options.client ?? daemonClientForProject;
		this.#enabled = options.enabled ?? (() => true);
		this.handlers = {
			"process.run": runOneShotProcess,
			"process.start": async request => this.#run(request, startOperation(request)),
			"process.list": async request => {
				strict(request.data, []);
				return this.#run(request, { op: "list" });
			},
			"process.describe": async request => this.#run(request, namedOperation(request, "describe")),
			"process.logs": async request => this.#run(request, namedOperation(request, "logs")),
			"process.wait": async request => this.#run(request, namedOperation(request, "wait")),
			"process.send": async request => this.#run(request, namedOperation(request, "send")),
			"process.stop": async request => this.#run(request, namedOperation(request, "stop")),
			"process.restart": async request => this.#run(request, namedOperation(request, "restart")),
		};
	}

	async #run(request: IpythonHostRequest, operation: DaemonOperation): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		if (!this.#enabled()) throw new Error("Process supervision is disabled (launch.enabled=false).");
		const client = await this.#client(request.cwd);
		request.signal.throwIfAborted();
		await request.publishProgress(`Process ${operation.op} started`);
		const result = await client.request(operation, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress(`Process ${operation.op} completed`);
		return publicResult(result);
	}
}

function publicResult(result: DaemonRpcResult): Readonly<Record<string, unknown>> {
	if (result.op === "ping" || result.op === "shutdown")
		throw new Error(`Internal daemon result ${result.op} is not process-visible`);
	return result;
}

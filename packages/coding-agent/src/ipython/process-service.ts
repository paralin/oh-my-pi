import { type DaemonBrokerClient, daemonClientForProject } from "../launch/client";
import type {
	DaemonOperation,
	DaemonRestartPolicy,
	DaemonRpcResult,
	DaemonSignal,
	DaemonSpec,
} from "../launch/protocol";
import { confineToWorkspace } from "../tools/path-utils";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_STRING_CHARS = 16_384;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_ENTRIES = 128;
const MAX_TIMEOUT_MS = 3_600_000;

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

/** Exposes the retained project-scoped launch broker to the active IPython session. */
export class IpythonProcessService {
	readonly handlers: IpythonHostHandlers;
	readonly #client: (cwd: string) => Promise<DaemonBrokerClient>;
	readonly #enabled: () => boolean;

	constructor(options: IpythonProcessServiceOptions = {}) {
		this.#client = options.client ?? daemonClientForProject;
		this.#enabled = options.enabled ?? (() => true);
		this.handlers = {
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

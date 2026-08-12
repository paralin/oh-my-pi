import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";
import type { IpythonExtensionHostHandler, IpythonExtensionHostRequest } from "../extensibility/extensions/types";
import { terminateProcessTree } from "../subprocess/process-termination";
import controllerSource from "./controller.py" with { type: "text" };
import { ipythonEnvironment } from "./environment";
import {
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	type IpythonRestoreResult,
	type IpythonSnapshotResult,
	parseRestoreResult,
	parseSnapshotResult,
	snapshotManifestPath,
} from "./state-snapshot";

export type { IpythonRestoreResult, IpythonSnapshotResult };
export { DEFAULT_SNAPSHOT_MAX_BYTES, snapshotManifestPath };

const CONTROLLER_CACHE_DIR = path.join(os.tmpdir(), "omp-ipython-controller");
const MAX_CONTROLLER_STDERR = 64 * 1024;
const MAX_CONTROLLER_FRAME = 8 * 1024 * 1024;
const MAX_CONTROLLER_CAPTURE_BYTES = 1024 * 1024;
const MAX_CONTROLLER_RICH_EVENTS = 256;
const MAX_HOST_REQUEST_BYTES = 1024 * 1024;
const MAX_HOST_PROGRESS_BYTES = 64 * 1024;
const MAX_HOST_MESSAGE_CHARS = 4_000;
const MAX_HOST_SUMMARY_PATH_CHARS = 200;
const MAX_HOST_SUMMARY_UNIT_CHARS = 32;
// This wait covers the controller's bounded graceful and forced kernel shutdown phases.
const SHUTDOWN_GRACE_MS = 7_000;
const SHUTDOWN_ESCALATION_MS = 7_000;

export type IpythonStreamName = "stdout" | "stderr";
export type IpythonExecutionStatus = "ok" | "error" | "aborted";

export interface IpythonProcessIds {
	readonly controllerPid: number;
	readonly kernelPid: number;
}

export interface IpythonStreamEvent {
	readonly kind: "stream";
	readonly name: IpythonStreamName;
	readonly text: string;
}

export interface IpythonResultEvent {
	readonly kind: "result";
	readonly data: Readonly<Record<string, unknown>>;
	readonly chunkStart?: boolean;
	readonly chunkEnd?: boolean;
}

export interface IpythonDisplayEvent {
	readonly kind: "display";
	readonly data: Readonly<Record<string, unknown>>;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly transient: Readonly<Record<string, unknown>>;
	readonly update: boolean;
	readonly text: string;
	readonly chunkStart?: boolean;
	readonly chunkEnd?: boolean;
}

export interface IpythonErrorEvent {
	readonly kind: "error";
	readonly ename: string;
	readonly evalue: string;
	readonly traceback: readonly string[];
	readonly chunkStart?: boolean;
	readonly chunkEnd?: boolean;
}

/**
 * Flattened host progress recorded by sessions written before the nested
 * operation lifecycle. Kept readable for replay; nothing produces it now.
 */
export interface IpythonHostProgressEvent {
	readonly kind: "host_progress";
	readonly operation: string;
	readonly message: string;
	readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The only structured facts a handler may add to its operation's presentation.
 * Every other field of a host request or response is dropped, so raw payloads
 * and credential material cannot reach the journal or a renderer.
 */
export interface IpythonHostOperationSummary {
	readonly path?: string;
	readonly count?: number;
	readonly unit?: string;
	readonly dryRun?: boolean;
}

/**
 * One record in a nested host operation's lifecycle. The controller owns
 * `operationId` (the request's comm identity), phase order, timestamps, and
 * terminal status; the handler contributes only `message` and {@link
 * IpythonHostOperationSummary} fields it publishes on purpose.
 */
export interface IpythonHostOperationEvent {
	readonly kind: "host_operation";
	readonly operationId: string;
	readonly operation: string;
	readonly phase: "start" | "progress" | "terminal";
	readonly at: number;
	readonly status?: IpythonExecutionStatus;
	readonly durationMs?: number;
	readonly message?: string;
	readonly summary?: IpythonHostOperationSummary;
}

export type IpythonExecutionEvent =
	| IpythonStreamEvent
	| IpythonResultEvent
	| IpythonDisplayEvent
	| IpythonErrorEvent
	| IpythonHostProgressEvent
	| IpythonHostOperationEvent;

export interface IpythonHostArtifact {
	readonly id?: string;
	readonly path: string;
	readonly mimeType?: string;
	readonly bytes?: number;
	readonly label?: string;
}

export interface IpythonHostArtifactRequest {
	readonly label: string;
	readonly mimeType: string;
	readonly suffix: string;
}

export interface IpythonExecutionHostContext {
	readonly sessionId: string;
	readonly cwd: string;
	readonly cellId: string;
	readonly sequence: number;
	readonly origin: "model" | "direct";
	readonly authority: "trusted-cell";
	readonly allocateArtifact?: (
		request: IpythonHostArtifactRequest,
		signal: AbortSignal,
	) => Promise<IpythonHostArtifact>;
}

export interface IpythonNamespaceEntry {
	readonly name: string;
	readonly type: string;
}

export interface IpythonExecutionNamespaceDelta {
	readonly executionCount: number;
	readonly added: readonly IpythonNamespaceEntry[];
	readonly rebound: readonly IpythonNamespaceEntry[];
	readonly deleted: readonly IpythonNamespaceEntry[];
	readonly omitted: Readonly<{ added: number; rebound: number; deleted: number }>;
}

export interface IpythonExecutionResult {
	readonly id: string;
	readonly status: IpythonExecutionStatus;
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string | undefined;
	readonly events: readonly IpythonExecutionEvent[];
	readonly errors: readonly IpythonErrorEvent[];
	readonly hostArtifacts: readonly IpythonHostArtifact[];
	readonly namespaceDelta?: IpythonExecutionNamespaceDelta;
}

export interface IpythonExecuteOptions {
	readonly onEvent?: (event: IpythonExecutionEvent) => void | Promise<void>;
	readonly onStream?: (event: IpythonStreamEvent) => void | Promise<void>;
	readonly hostContext?: IpythonExecutionHostContext;
}

export interface IpythonHostRequestChannel {
	readonly signal: AbortSignal;
	send(data: Readonly<Record<string, unknown>>): Promise<void>;
	receive(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

export interface IpythonHostRequest {
	readonly requestId: string;
	readonly commId: string;
	readonly targetName: "host.request";
	readonly data: Readonly<Record<string, unknown>>;
	readonly signal: AbortSignal;
	readonly executionId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly cellId: string;
	readonly sequence: number;
	readonly origin: "model" | "direct";
	readonly authority: "trusted-cell";
	readonly channel?: IpythonHostRequestChannel;
	publishProgress(message: string, data?: Readonly<Record<string, unknown>>): Promise<void>;
	publishDisplay(display: Omit<IpythonDisplayEvent, "kind">): Promise<void>;
	allocateArtifact(request: IpythonHostArtifactRequest): Promise<IpythonHostArtifact>;
}

export type IpythonHostHandler = (
	request: IpythonHostRequest,
) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;

export type IpythonHostHandlers = Readonly<Record<string, IpythonHostHandler>>;

export type IpythonExtensionHostHandlerResolver = (operation: string) => IpythonExtensionHostHandler | undefined;

export interface IpythonControllerOptions {
	readonly pythonExecutable: string;
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly controllerPath?: string;
	readonly controllerArgs?: readonly string[];
	readonly hostHandlers?: IpythonHostHandlers;
	readonly extensionHostHandlerResolver?: IpythonExtensionHostHandlerResolver;
	readonly onReady?: (processIds: IpythonProcessIds, status: { readonly restart: boolean }) => void;
	readonly shutdownGraceMs?: number;
}

export class IpythonControllerError extends Error {
	readonly exitCode: number | undefined;
	readonly stderr: string;

	constructor(message: string, options?: { exitCode?: number; stderr?: string }) {
		super(message);
		this.name = "IpythonControllerError";
		this.exitCode = options?.exitCode;
		this.stderr = options?.stderr ?? "";
	}
}

type ControllerFrame =
	| { readonly event: "ready"; readonly controller_pid: number; readonly kernel_pid: number }
	| { readonly event: "stream"; readonly id: string; readonly name: IpythonStreamName; readonly text: string }
	| {
			readonly event: "result";
			readonly id: string;
			readonly data: Readonly<Record<string, unknown>>;
			readonly chunk_start: boolean;
			readonly chunk_end: boolean;
	  }
	| {
			readonly event: "display";
			readonly id: string;
			readonly data: Readonly<Record<string, unknown>>;
			readonly metadata: Readonly<Record<string, unknown>>;
			readonly transient: Readonly<Record<string, unknown>>;
			readonly update: boolean;
			readonly text: string;
			readonly chunk_start: boolean;
			readonly chunk_end: boolean;
	  }
	| {
			readonly event: "namespace";
			readonly id: string;
			readonly execution_count: number;
			readonly added: readonly IpythonNamespaceEntry[];
			readonly rebound: readonly IpythonNamespaceEntry[];
			readonly deleted: readonly IpythonNamespaceEntry[];
			readonly omitted: Readonly<{ added: number; rebound: number; deleted: number }>;
	  }
	| {
			readonly event: "error";
			readonly id: string;
			readonly ename: string;
			readonly evalue: string;
			readonly traceback: readonly string[];
			readonly chunk_start: boolean;
			readonly chunk_end: boolean;
	  }
	| {
			readonly event: "comm";
			readonly id: string;
			readonly operation: "open" | "msg" | "close";
			readonly comm_id: string;
			readonly target_name?: string;
			readonly data?: Readonly<Record<string, unknown>>;
	  }
	| {
			readonly event: "done";
			readonly id: string;
			readonly status: IpythonExecutionStatus;
			readonly result: string | null;
	  }
	| { readonly event: "failed"; readonly id: string; readonly error: string }
	| { readonly event: "interrupted"; readonly id: string | null; readonly active: boolean }
	| { readonly event: "shutdown"; readonly controller_pid: number; readonly kernel_pid: number }
	| { readonly event: "protocol_error"; readonly error: string };

type ControllerCommand =
	| { readonly op: "execute"; readonly id: string; readonly code: string; readonly track_namespace?: boolean }
	| { readonly op: "interrupt"; readonly id?: string }
	| { readonly op: "comm_reply"; readonly comm_id: string; readonly data: Readonly<Record<string, unknown>> }
	| { readonly op: "shutdown" };

class BoundedHostRequestChannel implements HostRequestChannel {
	readonly signal: AbortSignal;
	readonly #messages: Readonly<Record<string, unknown>>[] = [];
	readonly #waiters: Array<{
		resolve: (value: Readonly<Record<string, unknown>>) => void;
		reject: (error: Error) => void;
		cleanup: () => void;
	}> = [];
	#closed: Error | undefined;
	readonly #sourceSignal: AbortSignal;
	readonly #abortListener: () => void;

	constructor(
		signal: AbortSignal,
		private readonly sendEvent: (data: Readonly<Record<string, unknown>>) => Promise<void>,
	) {
		this.signal = signal;
		this.#sourceSignal = signal;
		this.#abortListener = () => this.close(abortError(signal));
		signal.addEventListener("abort", this.#abortListener, { once: true });
	}

	async send(data: Readonly<Record<string, unknown>>): Promise<void> {
		if (this.#closed) throw this.#closed;
		if (data.status !== undefined) throw new IpythonControllerError("host request channel status is reserved");
		const event = { ...data, status: "event" };
		assertBoundedJson(event, "host request channel message");
		await this.sendEvent(event);
	}

	receive(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> {
		if (signal?.aborted) return Promise.reject(abortError(signal));
		const message = this.#messages.shift();
		if (message) return Promise.resolve(message);
		if (this.#closed) return Promise.reject(this.#closed);
		const { promise, resolve, reject } = Promise.withResolvers<Readonly<Record<string, unknown>>>();
		const waiter = { resolve, reject, cleanup: () => {} };
		const abort = () => {
			const index = this.#waiters.indexOf(waiter);
			if (index >= 0) this.#waiters.splice(index, 1);
			waiter.cleanup();
			reject(abortError(signal!));
		};
		waiter.cleanup = () => signal?.removeEventListener("abort", abort);
		signal?.addEventListener("abort", abort, { once: true });
		this.#waiters.push(waiter);
		return promise;
	}

	deliver(data: Readonly<Record<string, unknown>>): void {
		if (this.#closed) return;
		assertBoundedJson(data, "host request channel message");
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter.cleanup();
			waiter.resolve(data);
		} else if (this.#messages.length < 256) this.#messages.push(data);
		else this.close(new IpythonControllerError("host request channel message queue is full"));
	}

	close(error: Error = new IpythonControllerError("host request channel closed")): void {
		if (this.#closed) return;
		this.#closed = error;
		this.#sourceSignal.removeEventListener("abort", this.#abortListener);
		for (const waiter of this.#waiters.splice(0)) {
			waiter.cleanup();
			waiter.reject(error);
		}
		this.#messages.length = 0;
	}
}

interface HostRequestChannel extends IpythonHostRequestChannel {
	deliver(data: Readonly<Record<string, unknown>>): void;
	close(error?: Error): void;
}

interface PendingExecution {
	readonly id: string;
	readonly code: string;
	readonly options: IpythonExecuteOptions | undefined;
	readonly resolve: (result: IpythonExecutionResult) => void;
	readonly reject: (error: unknown) => void;
	readonly resolveCompletion: () => void;
	readonly rejectCompletion: (error: unknown) => void;
	readonly completion: Promise<void>;
	readonly events: IpythonExecutionEvent[];
	readonly errors: IpythonErrorEvent[];
	readonly hostArtifacts: IpythonHostArtifact[];
	readonly hostAbort: AbortController;
	readonly hostChannels: Map<string, HostRequestChannel>;
	/** Started operations awaiting a terminal record, keyed by request identity. */
	readonly hostOperations: Map<string, { readonly operation: string; readonly startedAt: number }>;
	readonly unlinkSignal: () => void;
	stdout: string;
	stderr: string;
	result: string | undefined;
	namespaceDelta: IpythonExecutionNamespaceDelta | undefined;
}

let controllerScriptPath: string | undefined;
async function bundledControllerPath(): Promise<string> {
	if (controllerScriptPath) return controllerScriptPath;
	const hash = Bun.hash(controllerSource).toString(36);
	const target = path.join(CONTROLLER_CACHE_DIR, `controller-${hash}.py`);
	await Bun.write(target, controllerSource);
	controllerScriptPath = target;
	return target;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function extensionRequestData(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	const { type: _operation, ...requestData } = data;
	return Object.freeze(requestData);
}

function assertBoundedJson(value: unknown, label: string, maxBytes = MAX_HOST_REQUEST_BYTES): void {
	let json: string;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new IpythonControllerError(`${label} is not JSON-compatible: ${errorMessage(error)}`);
	}
	if (json === undefined) throw new IpythonControllerError(`${label} is not JSON-compatible`);
	const bytes = Buffer.byteLength(json, "utf8");
	if (bytes > maxBytes) throw new IpythonControllerError(`${label} exceeds ${maxBytes} bytes`);
}

/**
 * Reduces the data a handler publishes to the presentation-safe summary
 * allowlist. Unknown keys — request arguments, response bodies, tokens — are
 * dropped rather than truncated, so no raw payload can leak through progress.
 */
export function ipythonHostOperationSummary(
	data: Readonly<Record<string, unknown>>,
): IpythonHostOperationSummary | undefined {
	const summary: { path?: string; count?: number; unit?: string; dryRun?: boolean } = {};
	const target = data.path;
	if (typeof target === "string" && target.trim()) summary.path = target.trim().slice(0, MAX_HOST_SUMMARY_PATH_CHARS);
	const count = data.count;
	if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) summary.count = count;
	const unit = data.unit;
	if (typeof unit === "string" && unit.trim()) summary.unit = unit.trim().slice(0, MAX_HOST_SUMMARY_UNIT_CHARS);
	const dryRun = data.dryRun ?? data.dry_run;
	if (typeof dryRun === "boolean") summary.dryRun = dryRun;
	return Object.keys(summary).length > 0 ? Object.freeze(summary) : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseFrame(value: unknown): ControllerFrame {
	const object = asObject(value);
	const event = asString(object?.event);
	if (!object || !event) throw new Error("controller emitted a malformed frame");
	if (event === "ready" || event === "shutdown") {
		const controllerPid = asNumber(object.controller_pid);
		const kernelPid = asNumber(object.kernel_pid);
		if (controllerPid === undefined || kernelPid === undefined) throw new Error(`${event} frame has invalid PIDs`);
		return { event, controller_pid: controllerPid, kernel_pid: kernelPid };
	}
	if (event === "stream") {
		const id = asString(object.id);
		const name = object.name;
		const text = asString(object.text);
		if (!id || (name !== "stdout" && name !== "stderr") || text === undefined) {
			throw new Error("stream frame has invalid fields");
		}
		return { event, id, name, text };
	}
	if (event === "result") {
		const id = asString(object.id);
		const data = asObject(object.data);
		if (!id || !data) throw new Error("result frame has invalid fields");
		return { event, id, data, chunk_start: object.chunk_start !== false, chunk_end: object.chunk_end !== false };
	}
	if (event === "display") {
		const id = asString(object.id);
		const data = asObject(object.data);
		const metadata = asObject(object.metadata);
		const transient = asObject(object.transient);
		const text = asString(object.text);
		if (!id || !data || !metadata || !transient || text === undefined || typeof object.update !== "boolean") {
			throw new Error("display frame has invalid fields");
		}
		return {
			event,
			id,
			data,
			metadata,
			transient,
			update: object.update,
			text,
			chunk_start: object.chunk_start !== false,
			chunk_end: object.chunk_end !== false,
		};
	}
	if (event === "namespace") {
		const id = asString(object.id);
		const executionCount = asNumber(object.execution_count);
		const entryList = (value: unknown): IpythonNamespaceEntry[] | undefined => {
			if (!Array.isArray(value)) return undefined;
			const entries: IpythonNamespaceEntry[] = [];
			for (const item of value) {
				const candidate = asObject(item);
				const name = asString(candidate?.name);
				const type = asString(candidate?.type);
				if (!name || type === undefined) return undefined;
				entries.push({ name, type });
			}
			return entries;
		};
		const added = entryList(object.added);
		const rebound = entryList(object.rebound);
		const deleted = entryList(object.deleted);
		const omitted = asObject(object.omitted);
		const omittedAdded = asNumber(omitted?.added);
		const omittedRebound = asNumber(omitted?.rebound);
		const omittedDeleted = asNumber(omitted?.deleted);
		if (
			!id ||
			executionCount === undefined ||
			!added ||
			!rebound ||
			!deleted ||
			omittedAdded === undefined ||
			omittedRebound === undefined ||
			omittedDeleted === undefined
		)
			throw new Error("namespace frame has invalid fields");
		return {
			event,
			id,
			execution_count: executionCount,
			added,
			rebound,
			deleted,
			omitted: { added: omittedAdded, rebound: omittedRebound, deleted: omittedDeleted },
		};
	}
	if (event === "error") {
		const id = asString(object.id);
		const ename = asString(object.ename);
		const evalue = asString(object.evalue);
		const traceback = object.traceback;
		if (
			!id ||
			ename === undefined ||
			evalue === undefined ||
			!Array.isArray(traceback) ||
			!traceback.every(item => typeof item === "string")
		) {
			throw new Error("error frame has invalid fields");
		}
		return {
			event,
			id,
			ename,
			evalue,
			traceback,
			chunk_start: object.chunk_start !== false,
			chunk_end: object.chunk_end !== false,
		};
	}
	if (event === "comm") {
		const id = asString(object.id);
		const operation = object.operation;
		const commId = asString(object.comm_id);
		const targetName = object.target_name;
		const data = object.data;
		if (
			!id ||
			commId === undefined ||
			(operation !== "open" && operation !== "msg" && operation !== "close") ||
			(targetName !== undefined && typeof targetName !== "string") ||
			(data !== undefined && !asObject(data))
		) {
			throw new Error("comm frame has invalid fields");
		}
		return {
			event,
			id,
			operation,
			comm_id: commId,
			...(targetName === undefined ? {} : { target_name: targetName }),
			...(data === undefined ? {} : { data: asObject(data) }),
		};
	}
	if (event === "done") {
		const id = asString(object.id);
		const status = object.status;
		const result = object.result;
		if (
			!id ||
			(status !== "ok" && status !== "error" && status !== "aborted") ||
			(result !== null && typeof result !== "string")
		) {
			throw new Error("done frame has invalid fields");
		}
		return { event, id, status, result };
	}
	if (event === "failed") {
		const id = asString(object.id);
		const error = asString(object.error);
		if (!id || error === undefined) throw new Error("failed frame has invalid fields");
		return { event, id, error };
	}
	if (event === "interrupted") {
		const id = object.id;
		if (id !== null && typeof id !== "string") throw new Error("interrupted frame has invalid id");
		if (typeof object.active !== "boolean") throw new Error("interrupted frame has invalid active flag");
		return { event, id, active: object.active };
	}
	if (event === "protocol_error") {
		const error = asString(object.error);
		if (error === undefined) throw new Error("protocol_error frame has invalid error");
		return { event, error };
	}
	throw new Error(`controller emitted unknown event ${event}`);
}

function appendBounded(current: string, next: string, limit: number): string {
	if (current.length >= limit) return current;
	return `${current}${next}`.slice(0, limit);
}

function appendTailBounded(current: string, next: string, maxBytes: number): string {
	const combined = `${current}${next}`;
	if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
	const bytes = Buffer.from(combined, "utf8");
	return new TextDecoder().decode(bytes.subarray(bytes.length - maxBytes)).replace(/^�/u, "");
}

function retainRichEvent(events: IpythonExecutionEvent[], event: IpythonExecutionEvent): void {
	if (events.length >= MAX_CONTROLLER_RICH_EVENTS) return;
	if (Buffer.byteLength(JSON.stringify(event), "utf8") > MAX_CONTROLLER_CAPTURE_BYTES) return;
	events.push(event);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

export class IpythonController {
	readonly #options: IpythonControllerOptions;
	#proc: Subprocess<"pipe", "pipe", "pipe"> | undefined;
	#startPromise: Promise<void> | undefined;
	#ready: PromiseWithResolvers<IpythonProcessIds> | undefined;
	#stderr = "";
	#readBuffer = "";
	#processIds: IpythonProcessIds | undefined;
	#kernel: Process | undefined;
	#everReady = false;
	#active: PendingExecution | undefined;
	#queue: PendingExecution[] = [];
	#pumpActive = false;
	#writeTail = Promise.resolve();
	#disposed = false;
	#disposePromise: Promise<void> | undefined;
	#nextId = 0;
	#generation = 0;
	#comms = new Map<
		string,
		{ readonly executionId: string; readonly targetName: string; readonly channel?: HostRequestChannel }
	>();
	#commTasks = new Set<Promise<void>>();
	#hostAbort = new AbortController();

	constructor(options: IpythonControllerOptions) {
		this.#options = options;
	}

	get processIds(): IpythonProcessIds | undefined {
		return this.#processIds;
	}

	async start(): Promise<void> {
		if (this.#disposed) throw new IpythonControllerError("IPython controller is disposed");
		if (this.#startPromise) return this.#startPromise;
		if (this.#hostAbort.signal.aborted) this.#hostAbort = new AbortController();
		const generation = ++this.#generation;
		this.#ready = Promise.withResolvers<IpythonProcessIds>();
		this.#ready.promise.catch(() => {});
		const startPromise = this.#startInternal(generation);
		this.#startPromise = startPromise;
		void startPromise.catch(() => {
			if (this.#startPromise === startPromise) this.#startPromise = undefined;
		});
		return startPromise;
	}

	async execute(code: string, options?: IpythonExecuteOptions, signal?: AbortSignal): Promise<IpythonExecutionResult> {
		if (this.#disposed) throw new IpythonControllerError("IPython controller is disposed");
		if (signal?.aborted) throw abortError(signal);
		const { promise, resolve, reject } = Promise.withResolvers<IpythonExecutionResult>();
		const {
			promise: completion,
			resolve: resolveCompletion,
			reject: rejectCompletion,
		} = Promise.withResolvers<void>();
		completion.catch(() => {});
		const id = `${Snowflake.next()}-${++this.#nextId}`;
		let pending!: PendingExecution;
		const onAbort = () => this.#cancelExecution(pending, abortError(signal!));
		pending = {
			id,
			code,
			options,
			resolve,
			reject,
			resolveCompletion,
			rejectCompletion,
			completion,
			events: [],
			errors: [],
			hostArtifacts: [],
			hostAbort: new AbortController(),
			hostChannels: new Map(),
			hostOperations: new Map(),
			unlinkSignal: () => signal?.removeEventListener("abort", onAbort),
			stdout: "",
			stderr: "",
			result: undefined,
			namespaceDelta: undefined,
		};
		this.#queue.push(pending);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		void this.#pump();
		return promise;
	}

	async snapshot(path: string, maxBytes = DEFAULT_SNAPSHOT_MAX_BYTES): Promise<IpythonSnapshotResult> {
		if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
			throw new RangeError("snapshot size cap must be a positive integer");
		const manifestPath = snapshotManifestPath(path);
		const result = await this.execute(buildSnapshotCode(path, manifestPath, maxBytes));
		const snapshot = parseSnapshotResult(result.stdout, path, manifestPath);
		if (!snapshot) throw new IpythonControllerError("snapshot did not return a result", { stderr: result.stderr });
		return snapshot;
	}

	async restore(path: string): Promise<IpythonRestoreResult> {
		const result = await this.execute(buildRestoreCode(path));
		const restore = parseRestoreResult(result.stdout, path);
		if (!restore) throw new IpythonControllerError("restore did not return a result", { stderr: result.stderr });
		return restore;
	}

	async interrupt(): Promise<void> {
		if (!this.#proc || !this.#active || this.#disposed) return;
		this.#active.hostAbort.abort(new Error("IPython cell interrupted"));
		await this.#write({ op: "interrupt", id: this.#active.id }, this.#generation);
	}

	async dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposePromise = this.#disposeInternal();
		return this.#disposePromise;
	}

	async #startInternal(generation: number): Promise<void> {
		const controllerPath = this.#options.controllerPath ?? (await bundledControllerPath());
		const proc = Bun.spawn(
			[this.#options.pythonExecutable, ...(this.#options.controllerArgs ?? ["-u"]), controllerPath],
			{
				cwd: this.#options.cwd,
				env: ipythonEnvironment(this.#options.env ?? process.env),
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			},
		);
		this.#proc = proc;
		this.#stderr = "";
		this.#readBuffer = "";
		const stderrDone = this.#drainStderr(proc.stderr as ReadableStream<Uint8Array>, generation);
		void this.#readStdout(proc.stdout as ReadableStream<Uint8Array>, generation);
		void this.#handleExit(proc, generation, stderrDone);
		try {
			const ready = this.#ready;
			if (!ready) throw new IpythonControllerError("IPython controller ready state is unavailable");
			await ready.promise;
		} catch (error) {
			throw error instanceof IpythonControllerError
				? error
				: new IpythonControllerError(errorMessage(error), { stderr: this.#stderr });
		}
	}

	#cancelExecution(pending: PendingExecution, error: Error): void {
		if (this.#active === pending) {
			pending.hostAbort.abort(error);
			void this.#write({ op: "interrupt", id: pending.id }, this.#generation).catch(() => undefined);
			return;
		}
		const index = this.#queue.indexOf(pending);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		pending.unlinkSignal();
		pending.reject(error);
		pending.rejectCompletion(error);
	}

	async #pump(): Promise<void> {
		if (this.#pumpActive) return;
		this.#pumpActive = true;
		try {
			await this.start();
			while (this.#queue.length > 0 && !this.#disposed) {
				const pending = this.#queue.shift();
				if (!pending) continue;
				this.#active = pending;
				const generation = this.#generation;
				try {
					await this.#write(
						{
							op: "execute",
							id: pending.id,
							code: pending.code,
							track_namespace: pending.options?.hostContext !== undefined,
						},
						generation,
					);
					await pending.completion;
				} catch (error) {
					pending.reject(error);
					pending.rejectCompletion(error);
					throw error;
				} finally {
					pending.unlinkSignal();
					this.#active = undefined;
				}
			}
		} catch (error) {
			this.#active = undefined;
			for (const pending of this.#queue.splice(0)) {
				pending.unlinkSignal();
				pending.reject(error);
				pending.rejectCompletion(error);
			}
		} finally {
			this.#pumpActive = false;
			if (this.#queue.length > 0 && !this.#disposed) void this.#pump();
		}
	}

	async #write(command: ControllerCommand, generation: number): Promise<void> {
		const write = this.#writeTail.then(() => {
			if (generation !== this.#generation || !this.#proc)
				throw new IpythonControllerError("IPython controller is not running", { stderr: this.#stderr });
			this.#proc.stdin.write(`${JSON.stringify(command)}\n`);
			this.#proc.stdin.flush();
		});
		this.#writeTail = write.catch(() => {});
		await write;
	}

	async #readStdout(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (generation !== this.#generation) return;
				this.#readBuffer += decoder.decode(value, { stream: true });
				if (this.#readBuffer.length > MAX_CONTROLLER_FRAME) throw new Error("controller frame exceeds the limit");
				await this.#flushFrames(generation);
			}
			if (generation !== this.#generation) return;
			this.#readBuffer += decoder.decode();
			await this.#flushFrames(generation);
		} catch (error) {
			this.#fail(error, generation);
		} finally {
			reader.releaseLock();
		}
	}

	async #flushFrames(generation: number): Promise<void> {
		while (generation === this.#generation) {
			const newline = this.#readBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#readBuffer.slice(0, newline);
			this.#readBuffer = this.#readBuffer.slice(newline + 1);
			if (!line) continue;
			await this.#dispatch(parseFrame(JSON.parse(line)), generation);
		}
	}

	async #drainStderr(stream: ReadableStream<Uint8Array>, generation: number): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (generation === this.#generation) {
					this.#stderr = appendBounded(
						this.#stderr,
						decoder.decode(value, { stream: true }),
						MAX_CONTROLLER_STDERR,
					);
				}
			}
			if (generation === this.#generation)
				this.#stderr = appendBounded(this.#stderr, decoder.decode(), MAX_CONTROLLER_STDERR);
		} finally {
			reader.releaseLock();
		}
	}

	async #dispatch(frame: ControllerFrame, generation: number): Promise<void> {
		if (generation !== this.#generation) return;
		if (frame.event === "ready") {
			this.#processIds = { controllerPid: frame.controller_pid, kernelPid: frame.kernel_pid };
			this.#kernel = Process.fromPid(frame.kernel_pid) ?? undefined;
			const restart = this.#everReady;
			this.#everReady = true;
			try {
				this.#options.onReady?.(this.#processIds, { restart });
			} catch {
				// Lifecycle presentation cannot change controller readiness.
			}
			this.#ready?.resolve(this.#processIds);
			return;
		}
		if (frame.event === "shutdown") return;
		if (frame.event === "comm") {
			if (frame.operation === "close") {
				const comm = this.#comms.get(frame.comm_id);
				comm?.channel?.close(new IpythonControllerError("host request comm closed"));
				this.#active?.hostChannels.delete(frame.comm_id);
				this.#comms.delete(frame.comm_id);
				return;
			}
			if (frame.operation === "open") {
				if (frame.target_name !== "host.request") return;
				const channel = new BoundedHostRequestChannel(
					this.#active?.hostAbort.signal ?? this.#hostAbort.signal,
					data => this.#write({ op: "comm_reply", comm_id: frame.comm_id, data }, generation),
				);
				this.#comms.set(frame.comm_id, { executionId: frame.id, targetName: frame.target_name, channel });
				this.#active?.hostChannels.set(frame.comm_id, channel);
			}
			const comm = this.#comms.get(frame.comm_id);
			if (comm?.targetName !== "host.request") return;
			if (frame.operation === "msg") {
				comm.channel?.deliver(frame.data ?? {});
				return;
			}
			const task =
				this.#active?.id === frame.id
					? this.#handleComm(frame, generation)
					: this.#write(
							{
								op: "comm_reply",
								comm_id: frame.comm_id,
								data: { status: "error", error: "host request has no active IPython cell" },
							},
							generation,
						);
			this.#commTasks.add(task);
			void task.then(
				() => this.#commTasks.delete(task),
				error => {
					this.#commTasks.delete(task);
					this.#fail(error, generation);
				},
			);
			return;
		}

		if (frame.event === "namespace") {
			if (!this.#active || this.#active.id !== frame.id) return;
			this.#active.namespaceDelta = {
				executionCount: frame.execution_count,
				added: frame.added,
				rebound: frame.rebound,
				deleted: frame.deleted,
				omitted: frame.omitted,
			};
			return;
		}
		if (
			frame.event === "stream" ||
			frame.event === "result" ||
			frame.event === "display" ||
			frame.event === "error"
		) {
			if (!this.#active || this.#active.id !== frame.id) return;
			const event =
				frame.event === "stream"
					? ({ kind: "stream", name: frame.name, text: frame.text } satisfies IpythonStreamEvent)
					: frame.event === "result"
						? ({
								kind: "result",
								data: frame.data,
								chunkStart: frame.chunk_start,
								chunkEnd: frame.chunk_end,
							} satisfies IpythonResultEvent)
						: frame.event === "display"
							? ({
									kind: "display",
									data: frame.data,
									metadata: frame.metadata,
									transient: frame.transient,
									update: frame.update,
									text: frame.text,
									chunkStart: frame.chunk_start,
									chunkEnd: frame.chunk_end,
								} satisfies IpythonDisplayEvent)
							: ({
									kind: "error",
									ename: frame.ename,
									evalue: frame.evalue,
									traceback: frame.traceback,
								} satisfies IpythonErrorEvent);
			if (event.kind === "stream") {
				if (event.name === "stdout")
					this.#active.stdout = appendTailBounded(this.#active.stdout, event.text, MAX_CONTROLLER_CAPTURE_BYTES);
				else this.#active.stderr = appendTailBounded(this.#active.stderr, event.text, MAX_CONTROLLER_CAPTURE_BYTES);
				await this.#active.options?.onStream?.(event);
			} else retainRichEvent(this.#active.events, event);
			if (event.kind === "error" && this.#active.errors.length < MAX_CONTROLLER_RICH_EVENTS)
				this.#active.errors.push(event);
			await this.#active.options?.onEvent?.(event);
			if (event.kind === "result") {
				const plain = event.data["text/plain"];
				if (typeof plain === "string")
					this.#active.result = appendTailBounded(this.#active.result ?? "", plain, MAX_CONTROLLER_CAPTURE_BYTES);
			}
			return;
		}
		if (frame.event === "done") {
			if (!this.#active || this.#active.id !== frame.id) return;
			const active = this.#active;
			await this.#closeHostRequests(
				active,
				generation,
				frame.status === "aborted"
					? "IPython cell interrupted"
					: frame.status === "error"
						? "IPython cell failed"
						: "IPython cell completed",
				frame.status === "aborted" ? "aborted" : "error",
			);
			active.unlinkSignal();
			active.resolve({
				id: active.id,
				status: frame.status,
				stdout: active.stdout,
				stderr: active.stderr,
				result: frame.result ?? active.result,
				events: active.events,
				errors: active.errors,
				hostArtifacts: active.hostArtifacts,
				namespaceDelta: active.namespaceDelta,
			});
			active.resolveCompletion();
			return;
		}
		if (frame.event === "failed") {
			if (this.#active?.id === frame.id) {
				const active = this.#active;
				const error = new IpythonControllerError(frame.error, { stderr: this.#stderr });
				await this.#closeHostRequests(active, generation, error.message, "error");
				active.unlinkSignal();
				active.reject(error);
				active.rejectCompletion(error);
			}
			return;
		}
		if (frame.event === "protocol_error") {
			this.#fail(new IpythonControllerError(frame.error, { stderr: this.#stderr }), generation);
		}
	}

	/** Records one terminal operation event and stops any later duplicate. */
	async #terminateHostOperation(
		active: PendingExecution,
		operationId: string,
		status: IpythonExecutionStatus,
	): Promise<void> {
		const started = active.hostOperations.get(operationId);
		if (!started) return;
		active.hostOperations.delete(operationId);
		const at = Date.now();
		await this.#publishHostOperation(active, {
			kind: "host_operation",
			operationId,
			operation: started.operation,
			phase: "terminal",
			at,
			status,
			durationMs: Math.max(0, at - started.startedAt),
		});
	}

	async #publishHostOperation(active: PendingExecution, event: IpythonHostOperationEvent): Promise<void> {
		active.events.push(event);
		try {
			await active.options?.onEvent?.(event);
		} catch {
			// Nested operation presentation cannot change host request handling.
		}
	}

	async #closeHostRequests(
		active: PendingExecution,
		generation: number,
		reason: string,
		status: IpythonExecutionStatus,
		sendReplies = true,
	): Promise<void> {
		// Terminal records are written before the abort so a handler that
		// rejects from the same abort cannot report a different outcome.
		for (const operationId of [...active.hostOperations.keys()]) {
			await this.#terminateHostOperation(active, operationId, status);
		}
		active.hostAbort.abort(new Error(reason));
		for (const channel of active.hostChannels.values()) channel.close(new IpythonControllerError(reason));
		active.hostChannels.clear();
		const commIds = [...this.#comms].filter(([, comm]) => comm.executionId === active.id).map(([commId]) => commId);
		for (const commId of commIds) {
			this.#comms.delete(commId);
			if (sendReplies) {
				await this.#write(
					{ op: "comm_reply", comm_id: commId, data: { status: "error", error: reason } },
					generation,
				);
			}
		}
	}

	async #handleComm(frame: Extract<ControllerFrame, { event: "comm" }>, generation: number): Promise<void> {
		const active = this.#active;
		const comm = this.#comms.get(frame.comm_id);
		if (generation !== this.#generation || active?.id !== frame.id || !comm) return;
		const data = frame.data ?? {};
		const type = data.type;
		let response: Readonly<Record<string, unknown>>;
		let terminalStatus: IpythonExecutionStatus = "ok";
		try {
			assertBoundedJson(data, "host request");
			if (typeof type !== "string" || type.trim().length === 0) {
				throw new IpythonControllerError("host request data.type must be a nonempty string");
			}
			const operation = type.trim();
			if (operation === "tool.call") throw new IpythonControllerError("host operation is reserved: tool.call");
			const fixedHandler = this.#options.hostHandlers?.[operation];
			const extensionHandler = fixedHandler ? undefined : this.#options.extensionHostHandlerResolver?.(operation);
			if (!fixedHandler && !extensionHandler)
				throw new IpythonControllerError(`unknown host request type: ${operation}`);
			if (active.hostAbort.signal.aborted) throw abortError(active.hostAbort.signal);
			const startedAt = Date.now();
			active.hostOperations.set(frame.comm_id, { operation, startedAt });
			await this.#publishHostOperation(active, {
				kind: "host_operation",
				operationId: frame.comm_id,
				operation,
				phase: "start",
				at: startedAt,
			});
			const context = active.options?.hostContext;
			if (!context) throw new IpythonControllerError("host request has no active cell context");
			const publish = async (event: IpythonExecutionEvent): Promise<void> => {
				if (active.hostAbort.signal.aborted) throw abortError(active.hostAbort.signal);
				if (generation !== this.#generation || this.#active !== active) {
					throw new IpythonControllerError("host request cell is no longer active");
				}
				if (event.kind === "host_operation") {
					await this.#publishHostOperation(active, event);
					return;
				}
				active.events.push(event);
				await active.options?.onEvent?.(event);
			};
			const commChannel = comm.channel;
			if (!commChannel) throw new IpythonControllerError("host request channel is unavailable");
			const publishProgress = async (
				message: string,
				progressData: Readonly<Record<string, unknown>> = {},
			): Promise<void> => {
				if (!asObject(progressData)) throw new TypeError("host progress data must be an object");
				if (typeof message !== "string" || !message.trim()) {
					throw new TypeError("host progress message must be a nonempty string");
				}
				if (message.length > MAX_HOST_MESSAGE_CHARS) {
					throw new RangeError(`host progress message exceeds ${MAX_HOST_MESSAGE_CHARS} characters`);
				}
				assertBoundedJson(progressData, "host progress", MAX_HOST_PROGRESS_BYTES);
				const summary = ipythonHostOperationSummary(progressData);
				await publish({
					kind: "host_operation",
					operationId: frame.comm_id,
					operation,
					phase: "progress",
					at: Date.now(),
					message,
					...(summary ? { summary } : {}),
				});
			};
			const publishDisplay = async (display: Omit<IpythonDisplayEvent, "kind">): Promise<void> => {
				assertBoundedJson(display, "host rich display");
				if (!asObject(display.data) || !asObject(display.metadata) || !asObject(display.transient)) {
					throw new TypeError("host rich display data, metadata, and transient values must be objects");
				}
				if (typeof display.text !== "string" || typeof display.update !== "boolean") {
					throw new TypeError("host rich display requires safe text and an update flag");
				}
				await publish({ ...display, kind: "display" });
			};
			const allocateArtifact = async (request: IpythonHostArtifactRequest): Promise<IpythonHostArtifact> => {
				if (
					typeof request.label !== "string" ||
					!request.label.trim() ||
					typeof request.mimeType !== "string" ||
					!request.mimeType.trim() ||
					typeof request.suffix !== "string"
				) {
					throw new TypeError("host artifact allocation requires label, MIME type, and suffix strings");
				}
				if (request.label.trim().length > 200 || request.mimeType.trim().length > 200) {
					throw new RangeError("host artifact label and MIME type must not exceed 200 characters");
				}
				if (request.suffix && !/^\.[a-zA-Z0-9]{1,16}$/.test(request.suffix)) {
					throw new TypeError(
						"host artifact suffix must be empty or a dot followed by 1 to 16 alphanumeric characters",
					);
				}
				if (!context.allocateArtifact) throw new Error("artifact allocation is unavailable in this session");
				const artifact = await context.allocateArtifact(request, active.hostAbort.signal);
				if (
					(artifact.id !== undefined && typeof artifact.id !== "string") ||
					typeof artifact.path !== "string" ||
					!artifact.path ||
					typeof artifact.mimeType !== "string" ||
					!artifact.mimeType ||
					typeof artifact.label !== "string" ||
					!artifact.label ||
					typeof artifact.bytes !== "number" ||
					!Number.isSafeInteger(artifact.bytes) ||
					artifact.bytes < 0
				) {
					throw new TypeError("host artifact allocator returned an invalid reference");
				}
				assertBoundedJson(artifact, "host artifact reference", MAX_HOST_PROGRESS_BYTES);
				active.hostArtifacts.push(artifact);
				return artifact;
			};
			const result = fixedHandler
				? await fixedHandler({
						requestId: frame.id,
						executionId: frame.id,
						commId: frame.comm_id,
						targetName: "host.request",
						data,
						signal: active.hostAbort.signal,
						sessionId: context.sessionId,
						cwd: context.cwd,
						cellId: context.cellId,
						sequence: context.sequence,
						origin: context.origin,
						authority: context.authority,
						channel: commChannel,
						publishProgress,
						publishDisplay,
						allocateArtifact,
					})
				: await extensionHandler!({
						data: extensionRequestData(data),
						requestId: frame.id,
						executionId: frame.id,
						commId: frame.comm_id,
						sessionId: context.sessionId,
						cwd: context.cwd,
						cell: Object.freeze({
							id: context.cellId,
							sequence: context.sequence,
							origin: context.origin,
							authority: context.authority,
						}),
						signal: active.hostAbort.signal,
						publishProgress,
						allocateArtifact,
					} satisfies IpythonExtensionHostRequest);
			const resultObject = asObject(result ?? {});
			if (!resultObject) throw new TypeError("host response must be an object");
			assertBoundedJson(resultObject, "host response");
			response = { ...resultObject, status: "ok" };
		} catch (error) {
			const message = errorMessage(error);
			terminalStatus =
				active.hostAbort.signal.aborted || (error instanceof Error && error.name === "AbortError")
					? "aborted"
					: "error";
			response = {
				status: "error",
				error: message.length > MAX_HOST_MESSAGE_CHARS ? `${message.slice(0, MAX_HOST_MESSAGE_CHARS)}…` : message,
			};
		}
		// The terminal record carries status and duration only: a thrown message
		// may quote the request, so it stays with the cell's own traceback.
		await this.#terminateHostOperation(active, frame.comm_id, terminalStatus);
		assertBoundedJson(response, "host response");
		if (generation !== this.#generation) return;
		const finalComm = this.#comms.get(frame.comm_id);
		if (!finalComm || finalComm.executionId !== frame.id) return;
		await this.#write({ op: "comm_reply", comm_id: frame.comm_id, data: response }, generation);
		if (this.#comms.get(frame.comm_id) === finalComm) {
			finalComm.channel?.close(new IpythonControllerError("host request completed"));
			active.hostChannels.delete(frame.comm_id);
			this.#comms.delete(frame.comm_id);
		}
	}

	async #handleExit(
		proc: Subprocess<"pipe", "pipe", "pipe">,
		generation: number,
		stderrDone: Promise<void>,
	): Promise<void> {
		const code = await proc.exited;
		await stderrDone;
		if (generation !== this.#generation || proc !== this.#proc) return;
		const stderr = this.#stderr;
		if (!this.#disposed) {
			try {
				this.#kernel?.killTree();
			} catch {
				// The kernel may have already exited with its controller.
			}
		}
		if (!this.#disposed) {
			const error = new IpythonControllerError(
				`IPython controller exited${code === 0 ? "" : ` with code ${code}`}${stderr ? `: ${stderr.trim()}` : ""}`,
				{ exitCode: code, stderr },
			);
			const active = this.#active;
			if (active) {
				await this.#closeHostRequests(
					active,
					generation,
					error.message,
					active.hostAbort.signal.aborted ? "aborted" : "error",
					false,
				);
			}
			this.#hostAbort.abort(error);
			active?.hostAbort.abort(error);
			this.#ready?.reject(error);
			active?.unlinkSignal();
			active?.reject(error);
			active?.rejectCompletion(error);
			for (const pending of this.#queue.splice(0)) {
				pending.unlinkSignal();
				pending.reject(error);
				pending.rejectCompletion(error);
			}
		}
		this.#active = undefined;
		this.#proc = undefined;
		this.#processIds = undefined;
		this.#kernel = undefined;
		this.#startPromise = undefined;
		this.#ready = undefined;
		this.#stderr = "";
		this.#readBuffer = "";
		this.#comms.clear();
		this.#generation++;
	}

	#fail(error: unknown, generation: number): void {
		if (generation !== this.#generation) return;
		const failure =
			error instanceof IpythonControllerError
				? error
				: new IpythonControllerError(errorMessage(error), { stderr: this.#stderr });
		this.#active?.hostAbort.abort(failure);
		this.#ready?.reject(failure);
		this.#active?.unlinkSignal();
		this.#active?.reject(failure);
		this.#active?.rejectCompletion(failure);
		for (const pending of this.#queue.splice(0)) {
			pending.unlinkSignal();
			pending.reject(failure);
			pending.rejectCompletion(failure);
		}
		try {
			this.#proc?.kill("SIGTERM");
		} catch {
			// The exit watcher reports the final process state.
		}
	}

	async #disposeInternal(): Promise<void> {
		this.#disposed = true;
		const disposed = new IpythonControllerError("IPython controller disposed", { stderr: this.#stderr });
		if (this.#active) {
			await this.#closeHostRequests(this.#active, this.#generation, disposed.message, "aborted", false);
		}
		this.#hostAbort.abort(disposed);
		this.#active?.hostAbort.abort(disposed);
		this.#ready?.reject(disposed);
		this.#active?.unlinkSignal();
		this.#active?.reject(disposed);
		this.#active?.rejectCompletion(disposed);
		for (const pending of this.#queue.splice(0)) {
			pending.unlinkSignal();
			pending.reject(disposed);
			pending.rejectCompletion(disposed);
		}
		for (const task of this.#commTasks) task.catch(() => {});
		const proc = this.#proc;
		const kernel = this.#kernel;
		if (!proc) return;
		try {
			await this.#write({ op: "shutdown" }, this.#generation);
			proc.stdin.end();
		} catch {
			// The process may have exited before the cooperative request was written.
		}
		await this.#exitedWithin(proc, this.#options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
		const shutdownGraceMs = this.#options.shutdownGraceMs ?? SHUTDOWN_ESCALATION_MS;
		await terminateProcessTree(proc, process.platform !== "win32", process.platform, {
			termMs: shutdownGraceMs,
			killMs: shutdownGraceMs,
		});
		// The detached-group sweep is intentionally fire-and-forget for a leader
		// that already exited. The stable kernel reference makes disposal await the
		// recorded kernel tree on every platform before releasing ownership.
		await kernel?.terminate({ gracefulMs: -1, timeoutMs: shutdownGraceMs });
	}

	async #exitedWithin(proc: Subprocess<"pipe", "pipe", "pipe">, timeoutMs: number): Promise<boolean> {
		return Promise.race([proc.exited.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
	}
}

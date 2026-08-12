import * as fs from "node:fs/promises";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_BYTES, truncateTailBytes } from "../session/streaming-output";
import { truncateHeadBytes } from "../session/streaming-output-constants";
import type {
	IpythonErrorEvent,
	IpythonExecutionEvent,
	IpythonExecutionHostContext,
	IpythonExecutionNamespaceDelta,
	IpythonExecutionResult,
	IpythonHostArtifact,
	IpythonHostArtifactRequest,
} from "./controller";
import { createIpythonCellText, createIpythonCellTextFromBounds, validateIpythonCellTextBudget } from "./projection";
import type { IpythonStartupProgress, IpythonStartupProgressHandler } from "./provisioner";

export type IpythonCellOrigin = "model" | "direct";

export interface IpythonCellNamespaceDelta extends IpythonExecutionNamespaceDelta {
	readonly origin: IpythonCellOrigin;
}

export interface IpythonCellStartupUpdate {
	readonly kind: "startup";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly progress: IpythonStartupProgress;
}

export interface IpythonCellArtifactUpdate {
	readonly kind: "artifact";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly artifact: IpythonArtifactReference;
}

export interface IpythonCellExecutionUpdate {
	readonly kind: "execution";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly event: IpythonExecutionEvent;
}

export interface IpythonCellOutputUpdate {
	readonly kind: "output";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly modelText: IpythonCellText;
}

export type IpythonCellUpdate =
	| IpythonCellStartupUpdate
	| IpythonCellExecutionUpdate
	| IpythonCellArtifactUpdate
	| IpythonCellOutputUpdate;

export interface IpythonArtifactReference {
	readonly id?: string;
	readonly path: string;
	readonly mimeType?: string;
	readonly bytes?: number;
	readonly label?: string;
}

export interface IpythonCellText {
	readonly text: string;
	readonly truncated: boolean;
	readonly totalLines?: number;
	readonly totalBytes: number;
	readonly omittedLines?: number;
	/** Bytes omitted between the retained head and tail when text is truncated. */
	readonly omittedBytes?: number;
	readonly outputBytes: number;
}

export interface IpythonCellResult {
	readonly cellId: string;
	readonly executionId: string | undefined;
	readonly sequence: number;
	readonly origin: IpythonCellOrigin;
	readonly authority: "trusted-cell";
	readonly code: string;
	readonly status: "ok" | "error" | "aborted";
	readonly requestedAt: number;
	readonly startedAt: number | undefined;
	readonly finishedAt: number;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string | undefined;
	readonly events: readonly IpythonExecutionEvent[];
	readonly errors: readonly IpythonErrorEvent[];
	readonly updates: readonly IpythonCellUpdate[];
	readonly artifacts: readonly IpythonArtifactReference[];
	readonly modelText: IpythonCellText;
	readonly namespaceDelta?: IpythonCellNamespaceDelta;
}

export interface IpythonCellRequest {
	readonly code: string;
	readonly origin: IpythonCellOrigin;
	readonly signal?: AbortSignal;
	readonly onUpdate?: (update: IpythonCellUpdate) => void | Promise<void>;
	/** The provider tool persists this completed cell after its paired tool result. */
	readonly deferJournal?: boolean;
}

export interface IpythonArtifactWriter {
	write(data: string): Promise<unknown>;
	close(): Promise<unknown>;
}

export interface IpythonCellServiceOptions {
	readonly maxModelBytes?: number;
	readonly sessionId?: string;
	readonly cwd?: string;
	readonly allocateArtifact?: (
		request: IpythonHostArtifactRequest,
		signal: AbortSignal,
		cellId: string,
	) => Promise<IpythonHostArtifact>;
	readonly openArtifact?: (path: string) => Promise<IpythonArtifactWriter>;
	readonly removeArtifact?: (path: string) => Promise<void>;
	readonly projectOutput?: typeof createIpythonCellTextFromBounds;
}

export interface IpythonCellProvisioner {
	ensure(onProgress?: IpythonStartupProgressHandler, signal?: AbortSignal): Promise<unknown>;
	execute(
		code: string,
		options?: {
			readonly onEvent?: (event: IpythonExecutionEvent) => void | Promise<void>;
			readonly hostContext?: IpythonExecutionHostContext;
		},
		signal?: AbortSignal,
	): Promise<IpythonExecutionResult>;
	dispose(): Promise<void>;
}

interface PendingCell {
	readonly cellId: string;
	readonly sequence: number;
	readonly request: IpythonCellRequest;
	readonly requestedAt: number;
	readonly abortController: AbortController;
	readonly resolve: (result: IpythonCellResult) => void;
	readonly promise: Promise<IpythonCellResult>;
	readonly unlinkSignal: () => void;
	readonly updates: IpythonCellUpdate[];
	startedAt: number | undefined;
	settled: boolean;
}

/** Strip only leading blank or comment-only lines before an exact %%bash cell magic. */
export function normalizeIpythonCellCode(code: string): string {
	let offset = 0;
	while (offset < code.length) {
		const newline = code.indexOf("\n", offset);
		const next = newline < 0 ? code.length : newline + 1;
		const rawLine = code.slice(offset, newline < 0 ? code.length : newline);
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line === "%%bash") return offset === 0 ? code : code.slice(offset);
		if (line.trim() !== "" && !/^\s*#/u.test(line)) return code;
		offset = next;
	}
	return code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
	return error instanceof Error && error.name ? error.name : "Error";
}

function syntheticExecution(error: unknown, aborted: boolean): IpythonExecutionResult {
	const name = aborted ? "AbortError" : errorName(error);
	const message = aborted ? "IPython cell aborted" : errorMessage(error);
	const structured: IpythonErrorEvent = { kind: "error", ename: name, evalue: message, traceback: [] };
	return {
		id: "",
		status: aborted ? "aborted" : "error",
		stdout: "",
		stderr: "",
		result: undefined,
		events: aborted ? [] : [structured],
		errors: aborted ? [] : [structured],
		hostArtifacts: [],
		namespaceDelta: undefined,
	};
}

const MAX_RETAINED_EVENT_BYTES = 64 * 1024;
const MAX_RETAINED_EVENTS = 256;

function boundedSafeText(text: string, maxBytes = MAX_RETAINED_EVENT_BYTES): string {
	const clean = Bun.stripANSI(text.toWellFormed()).replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/gu, "");
	return truncateHeadBytes(clean, maxBytes).text;
}

function retainedEvent(event: IpythonExecutionEvent): IpythonExecutionEvent | undefined {
	if (event.kind === "stream") return undefined;
	if (event.kind === "result" || event.kind === "display") {
		const data = Object.fromEntries(Object.entries(event.data).filter(([mime]) => mime !== "text/plain"));
		if (Object.keys(data).length === 0) return undefined;
		if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_RETAINED_EVENT_BYTES) return undefined;
		return event.kind === "result" ? { kind: "result", data } : { ...event, data, text: boundedSafeText(event.text) };
	}
	if (event.kind === "error")
		return {
			kind: "error",
			ename: boundedSafeText(event.ename, 1_024),
			evalue: boundedSafeText(event.evalue, 4_096),
			traceback: event.traceback.map(line => boundedSafeText(line)).slice(0, 32),
		};
	return event;
}

class StreamingTextSanitizer {
	#state: "text" | "escape" | "csi" | "osc" | "osc-escape" = "text";

	write(input: string): string {
		let output = "";
		for (const character of input.toWellFormed().replaceAll("�", "")) {
			const code = character.codePointAt(0)!;
			if (this.#state === "text") {
				if (character === "\x1b") this.#state = "escape";
				else if (character === "\n" || character === "\t" || (code >= 0x20 && code < 0x7f) || code >= 0xa0)
					output += character;
				continue;
			}
			if (this.#state === "escape") {
				if (character === "[") this.#state = "csi";
				else if (character === "]") this.#state = "osc";
				else this.#state = "text";
				continue;
			}
			if (this.#state === "csi") {
				if (code >= 0x40 && code <= 0x7e) this.#state = "text";
				continue;
			}
			if (this.#state === "osc") {
				if (character === "\x07") this.#state = "text";
				else if (character === "\x1b") this.#state = "osc-escape";
				continue;
			}
			this.#state = character === "\\" ? "text" : character === "\x1b" ? "osc-escape" : "osc";
		}
		return output;
	}
}

class IpythonPresentationTranscript {
	readonly #sanitizer = new StreamingTextSanitizer();
	readonly #maxBytes: number;
	readonly #path: string | undefined;
	readonly #writer: IpythonArtifactWriter | undefined;
	readonly #project: typeof createIpythonCellTextFromBounds;
	#head = "";
	#tail = "";
	#totalBytes = 0;
	#newlines = 0;
	#endsWithNewline = false;

	constructor(
		maxBytes: number,
		path: string | undefined,
		writer: IpythonArtifactWriter | undefined,
		project: typeof createIpythonCellTextFromBounds,
	) {
		this.#maxBytes = maxBytes;
		this.#path = path;
		this.#writer = writer;
		this.#project = project;
	}

	async append(event: IpythonExecutionEvent): Promise<void> {
		if (event.kind === "host_operation") return;
		let raw: string;
		let recordStart = true;
		let recordEnd = true;
		if (event.kind === "stream") {
			raw = event.text;
			recordStart = false;
			recordEnd = false;
		} else if (event.kind === "result") {
			const plain = event.data["text/plain"];
			raw = typeof plain === "string" ? plain : `[result MIME types: ${Object.keys(event.data).sort().join(", ")}]`;
			recordStart = event.chunkStart !== false;
			recordEnd = event.chunkEnd !== false;
		} else if (event.kind === "display") {
			raw = event.text;
			recordStart = event.chunkStart !== false;
			recordEnd = event.chunkEnd !== false;
		} else if (event.kind === "host_progress") raw = `[${event.operation}] ${event.message}`;
		else {
			raw = event.traceback.length > 0 ? event.traceback.join("\n") : `${event.ename}: ${event.evalue}`;
			recordStart = event.chunkStart !== false;
			recordEnd = event.chunkEnd !== false;
		}
		const text = this.#sanitizer.write(raw);
		if (!text) return;
		if (recordStart && this.#totalBytes > 0 && !this.#endsWithNewline) await this.#appendSanitized("\n");
		await this.#appendSanitized(text);
		if (recordEnd && !this.#endsWithNewline) await this.#appendSanitized("\n");
	}

	async close(): Promise<void> {
		await this.#writer?.close();
	}

	project(): IpythonCellText {
		const totalLines = this.#totalBytes === 0 ? 0 : this.#newlines + (this.#endsWithNewline ? 0 : 1);
		return this.#project(
			this.#head,
			this.#tail,
			this.#totalBytes,
			totalLines,
			this.#newlines,
			this.#maxBytes,
			this.#path,
		);
	}

	async #appendSanitized(text: string): Promise<void> {
		await this.#writer?.write(text);
		const bytes = Buffer.byteLength(text, "utf8");
		this.#totalBytes += bytes;
		this.#newlines += text.match(/\n/g)?.length ?? 0;
		this.#endsWithNewline = text.endsWith("\n");
		if (Buffer.byteLength(this.#head, "utf8") < this.#maxBytes)
			this.#head = truncateHeadBytes(`${this.#head}${text}`, this.#maxBytes).text;
		this.#tail = truncateTailBytes(`${this.#tail}${text}`, this.#maxBytes).text;
	}
}

/** Serializes model and direct-user cells through one session provisioner. */
export class IpythonCellService {
	readonly #provisioner: IpythonCellProvisioner;
	readonly #maxModelBytes: number;
	readonly #hostContext: Pick<IpythonCellServiceOptions, "sessionId" | "cwd" | "allocateArtifact">;
	readonly #openArtifact: (path: string) => Promise<IpythonArtifactWriter>;
	readonly #removeArtifact: (path: string) => Promise<void>;
	readonly #projectOutput: typeof createIpythonCellTextFromBounds;
	#sequence = 0;
	#queue: PendingCell[] = [];
	#active: PendingCell | undefined;
	#pumpTask: Promise<void> | undefined;
	#disposed = false;
	#disposePromise: Promise<void> | undefined;

	constructor(provisioner: IpythonCellProvisioner, options: IpythonCellServiceOptions = {}) {
		this.#provisioner = provisioner;
		this.#maxModelBytes = options.maxModelBytes ?? DEFAULT_MAX_BYTES;
		this.#hostContext = options;
		this.#openArtifact = options.openArtifact ?? (async artifactPath => await fs.open(artifactPath, "a"));
		this.#removeArtifact =
			options.removeArtifact ?? (async artifactPath => await fs.rm(artifactPath, { force: true }));
		this.#projectOutput = options.projectOutput ?? createIpythonCellTextFromBounds;
		validateIpythonCellTextBudget(this.#maxModelBytes);
	}

	get isRunning(): boolean {
		return this.#active !== undefined;
	}

	get pendingCount(): number {
		return this.#queue.length + (this.#active ? 1 : 0);
	}

	execute(request: IpythonCellRequest): Promise<IpythonCellResult> {
		if (this.#disposed) return Promise.reject(new Error("IPython cell service is disposed"));
		const requestedAt = Date.now();
		const sequence = ++this.#sequence;
		const cellId = `${Snowflake.next()}-${sequence}`;
		const abortController = new AbortController();
		const { promise, resolve } = Promise.withResolvers<IpythonCellResult>();
		const onAbort = () => abortController.abort(request.signal?.reason);
		request.signal?.addEventListener("abort", onAbort, { once: true });
		const item: PendingCell = {
			cellId,
			sequence,
			request,
			requestedAt,
			abortController,
			resolve,
			promise,
			unlinkSignal: () => request.signal?.removeEventListener("abort", onAbort),
			updates: [],
			startedAt: undefined,
			settled: false,
		};
		this.#queue.push(item);
		abortController.signal.addEventListener("abort", () => this.#cancelQueued(item), { once: true });
		if (request.signal?.aborted) abortController.abort(request.signal.reason);
		this.#schedulePump();
		return promise;
	}

	async waitForIdle(): Promise<void> {
		while (this.#pumpTask) await this.#pumpTask;
	}

	abort(reason: unknown = new Error("IPython cells aborted")): void {
		this.#active?.abortController.abort(reason);
		for (const item of [...this.#queue]) item.abortController.abort(reason);
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		this.abort(new Error("IPython cell service disposed"));
		this.#disposePromise = this.#disposeInternal();
		return this.#disposePromise;
	}

	async #disposeInternal(): Promise<void> {
		const pump = this.#pumpTask;
		await this.#provisioner.dispose();
		await pump;
	}

	#cancelQueued(item: PendingCell): void {
		if (item.settled || this.#active === item) return;
		const index = this.#queue.indexOf(item);
		if (index < 0) return;
		this.#queue.splice(index, 1);
		this.#settle(item, this.#finish(item, undefined, syntheticExecution(item.abortController.signal.reason, true)));
	}

	#schedulePump(): void {
		if (this.#pumpTask || this.#disposed) return;
		const pump = this.#pump();
		this.#pumpTask = pump;
		const settled = () => {
			if (this.#pumpTask === pump) this.#pumpTask = undefined;
			if (this.#queue.length > 0 && !this.#disposed) this.#schedulePump();
		};
		void pump.then(settled, settled);
	}

	async #pump(): Promise<void> {
		while (!this.#disposed) {
			const item = this.#queue.shift();
			if (!item) return;
			if (item.abortController.signal.aborted) {
				this.#settle(
					item,
					this.#finish(item, undefined, syntheticExecution(item.abortController.signal.reason, true)),
				);
				continue;
			}
			this.#active = item;
			try {
				const result = await this.#executeOne(item);
				this.#settle(item, result);
			} catch (error) {
				this.#settle(
					item,
					this.#finish(item, item.startedAt, syntheticExecution(error, item.abortController.signal.aborted)),
				);
			} finally {
				if (this.#active === item) this.#active = undefined;
			}
		}
	}

	async #executeOne(item: PendingCell): Promise<IpythonCellResult> {
		item.startedAt = Date.now();
		await this.#provisioner.ensure(
			progress => this.#emit(item, { kind: "startup", cellId: item.cellId, origin: item.request.origin, progress }),
			item.abortController.signal,
		);
		const hostContext =
			this.#hostContext.sessionId && this.#hostContext.cwd
				? {
						sessionId: this.#hostContext.sessionId,
						cwd: this.#hostContext.cwd,
						cellId: item.cellId,
						sequence: item.sequence,
						origin: item.request.origin,
						authority: "trusted-cell" as const,
						allocateArtifact: this.#hostContext.allocateArtifact
							? (request: IpythonHostArtifactRequest, signal: AbortSignal) =>
									this.#hostContext.allocateArtifact!(request, signal, item.cellId)
							: undefined,
					}
				: undefined;
		let fullArtifact: IpythonHostArtifact | undefined;
		let transcript: IpythonPresentationTranscript | undefined;
		let outputFailure: Error | undefined;
		try {
			if (hostContext?.allocateArtifact) {
				fullArtifact = await hostContext.allocateArtifact(
					{ label: "Full IPython result", mimeType: "text/plain", suffix: ".txt" },
					item.abortController.signal,
				);
				const writer = await this.#openArtifact(fullArtifact.path);
				transcript = new IpythonPresentationTranscript(
					this.#maxModelBytes,
					fullArtifact.path,
					writer,
					this.#projectOutput,
				);
				this.#emit(item, {
					kind: "artifact",
					cellId: item.cellId,
					origin: item.request.origin,
					artifact: fullArtifact,
				});
			} else {
				transcript = new IpythonPresentationTranscript(
					this.#maxModelBytes,
					undefined,
					undefined,
					this.#projectOutput,
				);
			}
		} catch {
			if (fullArtifact) await this.#removeAfterFailure(fullArtifact.path);
			throw new Error("IPython output artifact unavailable.");
		}

		let execution: IpythonExecutionResult;
		let observedEvents = 0;
		try {
			execution = await this.#provisioner.execute(
				normalizeIpythonCellCode(item.request.code),
				{
					hostContext,
					onEvent: async event => {
						observedEvents += 1;
						if (!outputFailure) {
							try {
								await transcript!.append(event);
								this.#emit(item, {
									kind: "output",
									cellId: item.cellId,
									origin: item.request.origin,
									modelText: transcript!.project(),
								});
							} catch (error) {
								outputFailure = error instanceof Error ? error : new Error(errorMessage(error));
							}
						}
						const retained = retainedEvent(event);
						const retainedCount = item.updates.filter(update => update.kind === "execution").length;
						if (retained && (retained.kind === "host_operation" || retainedCount < MAX_RETAINED_EVENTS))
							this.#emit(item, {
								kind: "execution",
								cellId: item.cellId,
								origin: item.request.origin,
								event: retained,
							});
					},
				},
				item.abortController.signal,
			);
			if (observedEvents === 0) {
				for (const event of execution.events) {
					try {
						await transcript.append(event);
					} catch (error) {
						outputFailure ??= error instanceof Error ? error : new Error(errorMessage(error));
						break;
					}
				}
			}
		} catch (error) {
			try {
				await transcript.close();
			} catch {}
			if (fullArtifact) await this.#removeAfterFailure(fullArtifact.path);
			throw error;
		}
		try {
			await transcript.close();
		} catch (error) {
			outputFailure ??= error instanceof Error ? error : new Error(errorMessage(error));
		}
		if (outputFailure) {
			if (fullArtifact) await this.#removeAfterFailure(fullArtifact.path);
			return this.#finish(
				item,
				item.startedAt,
				syntheticExecution(new Error("IPython output artifact failed."), false),
			);
		}
		let modelText: IpythonCellText;
		try {
			modelText = transcript.project();
		} catch {
			if (fullArtifact) await this.#removeAfterFailure(fullArtifact.path);
			return this.#finish(
				item,
				item.startedAt,
				syntheticExecution(new Error("IPython output projection failed."), false),
			);
		}
		let removalWarning: string | undefined;
		if (fullArtifact && !modelText.truncated) {
			try {
				await this.#removeArtifact(fullArtifact.path);
			} catch {
				removalWarning = "IPython artifact cleanup failed.";
			}
		}
		return this.#finish(
			item,
			item.startedAt,
			execution,
			modelText,
			modelText.truncated ? fullArtifact : undefined,
			removalWarning,
		);
	}

	async #removeAfterFailure(artifactPath: string): Promise<void> {
		try {
			await this.#removeArtifact(artifactPath);
		} catch {
			// The bounded failure result remains authoritative when cleanup is unavailable.
		}
	}

	#finish(
		item: PendingCell,
		startedAt: number | undefined,
		execution: IpythonExecutionResult,
		boundedText?: IpythonCellText,
		fullArtifact?: IpythonHostArtifact,
		removalWarning?: string,
	): IpythonCellResult {
		const finishedAt = Date.now();
		let modelText =
			boundedText ??
			createIpythonCellText(
				execution.events,
				execution.errors,
				execution.status,
				this.#maxModelBytes,
				fullArtifact?.path,
			);
		const updateEvents = item.updates.flatMap(update => (update.kind === "execution" ? [update.event] : []));
		const retainedEvents =
			updateEvents.length > 0
				? updateEvents
				: execution.events.flatMap(event => {
						const retained = retainedEvent(event);
						return retained ? [retained] : [];
					});
		if (removalWarning) {
			const text = `[${removalWarning}]\n`;
			modelText = {
				text,
				truncated: false,
				totalLines: 1,
				totalBytes: Buffer.byteLength(text, "utf8"),
				outputBytes: Buffer.byteLength(text, "utf8"),
			};
		}
		const unsafeOutput = modelText.truncated || removalWarning !== undefined;
		return {
			cellId: item.cellId,
			executionId: execution.id || undefined,
			sequence: item.sequence,
			origin: item.request.origin,
			authority: "trusted-cell",
			code: item.request.code,
			status: execution.status,
			requestedAt: item.requestedAt,
			startedAt,
			finishedAt,
			durationMs: Math.max(0, finishedAt - (startedAt ?? item.requestedAt)),
			stdout: unsafeOutput ? "" : execution.stdout,
			stderr: unsafeOutput ? "" : execution.stderr,
			result: unsafeOutput ? undefined : execution.result,
			events: retainedEvents,
			errors: retainedEvents.filter((event): event is IpythonErrorEvent => event.kind === "error"),
			updates: item.updates.filter(
				update =>
					(update.kind !== "artifact" || modelText.truncated) &&
					(!removalWarning ||
						update.kind === "startup" ||
						(update.kind === "execution" &&
							(update.event.kind === "host_operation" || update.event.kind === "host_progress"))),
			),
			artifacts: [...execution.hostArtifacts, ...(fullArtifact ? [fullArtifact] : [])],
			namespaceDelta: execution.namespaceDelta
				? { ...execution.namespaceDelta, origin: item.request.origin }
				: undefined,
			modelText,
		};
	}

	#settle(item: PendingCell, result: IpythonCellResult): void {
		if (item.settled) return;
		item.settled = true;
		item.unlinkSignal();
		item.resolve(result);
	}

	#emit(item: PendingCell, update: IpythonCellUpdate): void {
		if (update.kind === "output") {
			const index = item.updates.findIndex(candidate => candidate.kind === "output");
			if (index >= 0) item.updates[index] = update;
			else item.updates.push(update);
		} else item.updates.push(update);
		try {
			const observed = item.request.onUpdate?.(update);
			if (observed) void Promise.resolve(observed).catch(() => undefined);
		} catch {
			// Presentation updates cannot change cell execution.
		}
	}
}

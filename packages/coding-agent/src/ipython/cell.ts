import { Snowflake } from "@oh-my-pi/pi-utils";
import { DEFAULT_MAX_BYTES } from "../session/streaming-output";
import type {
	IpythonErrorEvent,
	IpythonExecutionEvent,
	IpythonExecutionHostContext,
	IpythonExecutionResult,
	IpythonHostArtifact,
	IpythonHostArtifactRequest,
} from "./controller";
import { createIpythonCellText, validateIpythonCellTextBudget } from "./projection";
import type { IpythonStartupProgress, IpythonStartupProgressHandler } from "./provisioner";

export type IpythonCellOrigin = "model" | "direct";

export interface IpythonCellStartupUpdate {
	readonly kind: "startup";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly progress: IpythonStartupProgress;
}

export interface IpythonCellExecutionUpdate {
	readonly kind: "execution";
	readonly cellId: string;
	readonly origin: IpythonCellOrigin;
	readonly event: IpythonExecutionEvent;
}

export type IpythonCellUpdate = IpythonCellStartupUpdate | IpythonCellExecutionUpdate;

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
	readonly totalBytes: number;
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
}

export interface IpythonCellRequest {
	readonly code: string;
	readonly origin: IpythonCellOrigin;
	readonly signal?: AbortSignal;
	readonly onUpdate?: (update: IpythonCellUpdate) => void | Promise<void>;
	/** The provider tool persists this completed cell after its paired tool result. */
	readonly deferJournal?: boolean;
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
	};
}

/** Serializes model and direct-user cells through one session provisioner. */
export class IpythonCellService {
	readonly #provisioner: IpythonCellProvisioner;
	readonly #maxModelBytes: number;
	readonly #hostContext: Pick<IpythonCellServiceOptions, "sessionId" | "cwd" | "allocateArtifact">;
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
		const execution = await this.#provisioner.execute(
			item.request.code,
			{
				hostContext,
				onEvent: event =>
					this.#emit(item, { kind: "execution", cellId: item.cellId, origin: item.request.origin, event }),
			},
			item.abortController.signal,
		);
		return this.#finish(item, item.startedAt, execution);
	}

	#finish(item: PendingCell, startedAt: number | undefined, execution: IpythonExecutionResult): IpythonCellResult {
		const finishedAt = Date.now();
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
			stdout: execution.stdout,
			stderr: execution.stderr,
			result: execution.result,
			events: execution.events,
			errors: execution.errors,
			updates: [...item.updates],
			artifacts: execution.hostArtifacts,
			modelText: createIpythonCellText(execution.events, execution.errors, execution.status, this.#maxModelBytes),
		};
	}

	#settle(item: PendingCell, result: IpythonCellResult): void {
		if (item.settled) return;
		item.settled = true;
		item.unlinkSignal();
		item.resolve(result);
	}

	#emit(item: PendingCell, update: IpythonCellUpdate): void {
		item.updates.push(update);
		try {
			const observed = item.request.onUpdate?.(update);
			if (observed) void Promise.resolve(observed).catch(() => undefined);
		} catch {
			// Presentation updates cannot change cell execution.
		}
	}
}

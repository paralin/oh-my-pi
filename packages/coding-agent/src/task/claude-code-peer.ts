import type { AsyncJob, AsyncJobManager } from "../async";
import { type IrcMessage, PermanentIrcDeliveryError } from "../irc/bus";
import type { AgentPeer, AgentRef, AgentRegistry } from "../registry/agent-registry";
import {
	ASYNC_INLINE_RESULT_MAX_CHARS,
	ASYNC_PREVIEW_MAX_CHARS,
	buildAsyncResultBatchMessage,
} from "../session/async-job-delivery";
import { loadClaudeSessionMessagesReadOnly } from "../session/claude-session-store";
import { buildIrcIncomingMessage } from "../session/irc-bridge";
import type { ClaudeCodeSessionRuntime } from "../session/session-entries";
import type { ClaudeCodeQuery } from "./claude-code-sdk";

/** Terminal abort evidence consumed by the Task result owner. */
export interface ClaudeCodePeerAbortState {
	aborted: boolean;
	reason?: string;
}

interface ClaudeCodeQueryCloseFailure {
	error: unknown;
}
const CLAUDE_CODE_INPUT_CAP = 100;

/** Ordered input owner for one retained Claude SDK query. */
export class ClaudeCodeInputMailbox implements AsyncIterable<string> {
	readonly #queue: string[] = [];
	#waiter: ((result: IteratorResult<string>) => void) | undefined;
	#closed = false;
	#iteratorCreated = false;
	#inFlightInputs = 0;

	constructor(initialPrompt?: string) {
		if (initialPrompt !== undefined) this.#queue.push(initialPrompt);
	}

	get turnIdle(): boolean {
		return this.#inFlightInputs === 0 && this.#queue.length === 0;
	}

	enqueue(text: string): "queued" | "woken" {
		if (this.#closed) throw new PermanentIrcDeliveryError("Claude Code input mailbox is closed.");
		if (this.#queue.length + this.#inFlightInputs >= CLAUDE_CODE_INPUT_CAP) {
			throw new Error(`Claude Code input mailbox reached its ${CLAUDE_CODE_INPUT_CAP}-message capacity.`);
		}
		const outcome = this.turnIdle ? "woken" : "queued";
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = undefined;
			this.#inFlightInputs++;
			waiter({ done: false, value: text });
		} else {
			this.#queue.push(text);
		}
		return outcome;
	}

	completeTurn(): boolean {
		// The SDK eagerly accepts queued messages and may combine them into one
		// model turn. One result boundary settles that whole accepted batch.
		this.#inFlightInputs = 0;
		return this.turnIdle;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue.length = 0;
		this.#inFlightInputs = 0;
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		if (this.#iteratorCreated) throw new Error("Claude Code input mailbox supports one SDK consumer.");
		this.#iteratorCreated = true;
		return { next: () => this.#next() };
	}

	#next(): Promise<IteratorResult<string>> {
		const text = this.#queue.shift();
		if (text !== undefined) {
			this.#inFlightInputs++;
			return Promise.resolve({ done: false, value: text });
		}
		if (this.#closed) return Promise.resolve({ done: true, value: undefined });
		const { promise, resolve } = Promise.withResolvers<IteratorResult<string>>();
		this.#waiter = resolve;
		return promise;
	}
}

export interface ClaudeCodePeerOptions {
	id: string;
	prompt?: string;
	abortController: AbortController;
	registry: AgentRegistry;
	asyncJobManager?: AsyncJobManager;
	nativeSession?: ClaudeCodeSessionRuntime;
}

/** One live Claude Code query registered as an OMP peer. */
export class ClaudeCodePeer implements AgentPeer {
	readonly messages: unknown[];
	readonly input: ClaudeCodeInputMailbox;
	readonly #id: string;
	readonly #abortController: AbortController;
	readonly #registry: AgentRegistry;
	#ref: AgentRef | undefined;
	#query: ClaudeCodeQuery | undefined;
	#eventPump: Promise<void> | undefined;
	#disposePromise: Promise<void> | undefined;
	#abortState: ClaudeCodePeerAbortState = { aborted: false };
	#queryCloseAttempted = false;
	#nativeSession: ClaudeCodeSessionRuntime | undefined;
	#queryCloseFailure: ClaudeCodeQueryCloseFailure | undefined;
	#unregisterAsyncDeliverySink: (() => void) | undefined;

	constructor(options: ClaudeCodePeerOptions) {
		this.#id = options.id;
		this.#abortController = options.abortController;
		this.#registry = options.registry;
		this.input = new ClaudeCodeInputMailbox(options.prompt);
		this.messages =
			options.prompt === undefined ? [] : [{ role: "user", content: options.prompt, timestamp: Date.now() }];
		this.#nativeSession = options.nativeSession;
		if (options.asyncJobManager) {
			this.#unregisterAsyncDeliverySink = options.asyncJobManager.registerDeliverySink(
				options.id,
				(jobId, text, job) => this.#deliverAsyncJobResult(jobId, text, job),
			);
		}
	}

	get abortState(): Readonly<ClaudeCodePeerAbortState> {
		return this.#abortState;
	}

	get queryClosed(): boolean {
		return this.#queryCloseAttempted && !this.#queryCloseFailure;
	}

	get queryCloseFailure(): Readonly<ClaudeCodeQueryCloseFailure> | undefined {
		return this.#queryCloseFailure;
	}

	get turnIdle(): boolean {
		return this.input.turnIdle;
	}

	async readHistorySnapshot(): Promise<{
		messages: unknown[];
		sourcePath?: string;
		sourceLabel?: string;
	}> {
		const native = this.#nativeSession;
		if (!native) return { messages: this.messages, sourceLabel: "live session" };
		return {
			messages: await loadClaudeSessionMessagesReadOnly(native.transcriptPath, native.cwd, native.sessionId),
			sourcePath: native.transcriptPath,
			sourceLabel: "native Claude transcript (read-only, live)",
		};
	}

	setNativeSession(native: ClaudeCodeSessionRuntime): void {
		this.#nativeSession = native;
	}

	/** Bind registry mutation to the exact generation registered for this peer. */
	bindRef(ref: AgentRef): void {
		if (
			ref.id !== this.#id ||
			this.#registry.get(this.#id) !== ref ||
			(ref.session !== null && ref.session !== this)
		) {
			throw new Error(`Claude Code peer "${this.#id}" cannot bind an unrelated registry generation.`);
		}
		this.#ref = ref;
	}

	/** Attach the constructed query unless teardown started while the SDK was starting. */
	attachQuery(query: ClaudeCodeQuery): boolean {
		if (this.#disposePromise) {
			this.#closeQuery(query);
			return false;
		}
		if (this.#query) {
			this.#closeQuery(query);
			return false;
		}
		this.#query = query;
		return true;
	}

	/** Register the single event consumer and contain background failures. */
	attachEventPump(pump: Promise<void>): void {
		if (this.#eventPump) throw new Error(`Claude Code peer "${this.#id}" already owns an event pump.`);
		this.#eventPump = pump;
		void pump.catch(() => {});
	}

	recordAssistantText(text: string): void {
		this.messages.push({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });
	}

	/** Settle one SDK result boundary and report whether no queued turn remains. */
	completeTurn(): boolean {
		const idle = this.input.completeTurn();
		const ref = this.#ref;
		if (idle && ref && this.#registry.get(this.#id) === ref && ref.status !== "aborted") {
			this.#registry.setStatus(this.#id, "idle", ref);
		}
		return idle;
	}

	async deliverIrcMessage(message: IrcMessage): Promise<"queued" | "woken"> {
		const record = buildIrcIncomingMessage(message, { autoReplied: false, interrupting: false });
		return this.#enqueue(record.content, message.ts);
	}

	async abort(options?: { reason?: string }): Promise<void> {
		if (!this.#disposePromise) {
			this.#abortState = {
				aborted: true,
				...(options?.reason === undefined ? {} : { reason: options.reason }),
			};
			const ref = this.#ref;
			if (ref && this.#registry.get(this.#id) === ref) {
				this.#registry.setStatus(this.#id, "aborted", ref);
				this.#registry.detachSession(this.#id, ref);
			}
			this.#disposePromise = this.#dispose(options?.reason);
		}
		await this.#disposePromise;
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= this.#dispose();
		return this.#disposePromise;
	}

	#enqueue(text: string, timestamp = Date.now()): "queued" | "woken" {
		const outcome = this.input.enqueue(text);
		this.messages.push({ role: "user", content: text, timestamp });
		const ref = this.#ref;
		if (ref && this.#registry.get(this.#id) === ref && ref.status !== "aborted") {
			this.#registry.setStatus(this.#id, "running", ref);
		}
		return outcome;
	}

	async #deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): Promise<void> {
		if (this.#disposePromise) return;
		const result =
			text.length <= ASYNC_INLINE_RESULT_MAX_CHARS
				? text
				: `${text.slice(0, ASYNC_PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${ASYNC_PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
		const message = buildAsyncResultBatchMessage([
			{
				jobId,
				result,
				job,
				durationMs: job ? Math.max(0, Date.now() - job.startTime) : undefined,
				epoch: 0,
			},
		]);
		if (message) this.#enqueue(message.content);
	}

	async #dispose(reason?: string): Promise<void> {
		this.#unregisterAsyncDeliverySink?.();
		this.#unregisterAsyncDeliverySink = undefined;
		this.input.close();
		this.#abortController.abort(reason === undefined ? undefined : new Error(reason));
		const query = this.#query;
		this.#query = undefined;
		if (query) this.#closeQuery(query);
	}

	#closeQuery(query: ClaudeCodeQuery): void {
		this.#queryCloseAttempted = true;
		try {
			query.close();
		} catch (error) {
			this.#queryCloseFailure ??= { error };
		}
	}
}

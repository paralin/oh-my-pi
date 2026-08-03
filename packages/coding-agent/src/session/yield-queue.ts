import { type AgentMessage, ASIDE_MESSAGE_COMMIT, ASIDE_MESSAGE_DISCARD } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";

export interface YieldDispatcher<P> {
	/** Drop entries already delivered through another path. Called per-entry at flush time. */
	isStale?(entry: P): boolean;
	/** Produce one batched AgentMessage from non-stale entries. Return null to skip. */
	build(survivors: P[]): AgentMessage | null;
	/** If true, entries for this kind are drained only by {@link drainLazy} and never trigger the idle flush. */
	skipIdleFlush?: boolean;
	/** If true, enqueueing while streaming steers the built message into the agent immediately. */
	interruptStreaming?: boolean;
}

export interface YieldQueueOptions {
	isStreaming: () => boolean;
	/**
	 * Gate for idle wake turns. The idle flush is the only path that starts a
	 * provider turn on its own, so a mode holding durable custody of the session
	 * can refuse the wake the same way it refuses a peer IRC wake. Refusing
	 * retains every queued entry untouched: the owed notifications still reach
	 * the model through a later flush or the next run's lazy aside drain.
	 */
	canWakeIdle?: () => boolean;
	injectStreaming?(msg: AgentMessage): void;
	injectIdle(messages: AgentMessage[]): Promise<void>;
	scheduleIdleFlush(run: () => Promise<void>): void;
}

type YieldFlushMode = "streaming" | "idle";

interface StoredDispatcher {
	isStale?: (entry: unknown) => boolean;
	build: (survivors: unknown[]) => AgentMessage | null;
	skipIdleFlush?: boolean;
	interruptStreaming?: boolean;
}

interface StoredEntry {
	value: unknown;
	resolve?: () => void;
	reject?: (error: Error) => void;
}

interface BuiltMessage {
	message: AgentMessage;
	entries: StoredEntry[];
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class YieldQueue {
	readonly #options: YieldQueueOptions;
	readonly #dispatchers = new Map<string, StoredDispatcher>();
	readonly #entries = new Map<string, StoredEntry[]>();
	#idleFlushPending = false;

	constructor(options: YieldQueueOptions) {
		this.#options = options;
	}

	register<P>(kind: string, dispatcher: YieldDispatcher<P>): () => void {
		const stored: StoredDispatcher = {
			...(dispatcher.isStale ? { isStale: entry => dispatcher.isStale?.(entry as P) ?? false } : {}),
			build: survivors => dispatcher.build(survivors as P[]),
			...(dispatcher.skipIdleFlush ? { skipIdleFlush: true } : {}),
			...(dispatcher.interruptStreaming ? { interruptStreaming: true } : {}),
		};
		this.#dispatchers.set(kind, stored);
		return () => {
			if (this.#dispatchers.get(kind) !== stored) return;
			this.#dispatchers.delete(kind);
			this.#rejectEntries(this.#entries.get(kind) ?? [], new Error(`Yield queue dispatcher removed: ${kind}`));
			this.#entries.delete(kind);
		};
	}

	enqueue<P>(kind: string, entry: P): void {
		this.enqueueMany(kind, [entry]);
	}

	enqueueMany<P>(kind: string, incoming: P[]): void {
		this.#enqueueMany(
			kind,
			incoming.map(value => ({ value })),
		);
	}

	enqueueWithReceipt<P>(kind: string, entry: P): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		if (!this.#enqueueMany(kind, [{ value: entry, resolve, reject }])) {
			reject(new Error(`Yield queue entry ignored for unregistered kind: ${kind}`));
		}
		return promise;
	}

	/** Append the whole arrival before dispatching it. Entries that come due
	 *  together — simultaneous scheduled prompts — must land in the queue before
	 *  the streaming flush drains it, or the first one steers alone and the rest
	 *  follow as separate notifications instead of one batch. */
	#enqueueMany(kind: string, incoming: StoredEntry[]): boolean {
		if (incoming.length === 0) return true;
		const dispatcher = this.#dispatchers.get(kind);
		if (!dispatcher) {
			logger.warn("Yield queue entry ignored for unregistered kind", { kind });
			return false;
		}
		let entries = this.#entries.get(kind);
		if (!entries) {
			entries = [];
			this.#entries.set(kind, entries);
		}
		entries.push(...incoming);
		if (this.#options.isStreaming()) {
			if (dispatcher.interruptStreaming) void this.flush("streaming", kind);
		} else if (!dispatcher.skipIdleFlush) {
			this.#scheduleIdleFlush();
		}
		return true;
	}

	has(kind?: string): boolean {
		if (kind !== undefined) return (this.#entries.get(kind)?.length ?? 0) > 0;
		for (const entries of this.#entries.values()) {
			if (entries.length > 0) return true;
		}
		return false;
	}

	/** Arrange an idle flush for entries queued near the end of a streaming run. */
	requestIdleFlush(): void {
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (!dispatcher.skipIdleFlush && this.has(kind)) {
				this.#scheduleIdleFlush();
				return;
			}
		}
	}

	/** Flush every registered kind, or only `onlyKind` when one is named. */
	async flush(mode: YieldFlushMode, onlyKind?: string): Promise<Set<string>> {
		const drainedKinds = new Set<string>();
		if (mode === "idle") {
			this.#idleFlushPending = false;
			// Wake boundary. Checked before the first #drain so a refusal leaves the
			// entries queued rather than settling receipts for work that never ran.
			if (this.#options.canWakeIdle?.() === false) return drainedKinds;
		}
		const idleMessages: BuiltMessage[] = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			if (onlyKind !== undefined && kind !== onlyKind) continue;
			if (mode === "idle" && dispatcher.skipIdleFlush) continue;
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			drainedKinds.add(kind);
			const built = this.#build(kind, dispatcher, entries);
			if (!built) continue;
			if (mode === "streaming") {
				try {
					if (!this.#options.injectStreaming) throw new Error("Streaming injection is unavailable");
					this.#options.injectStreaming(built.message);
					this.#resolveEntries(built.entries);
				} catch (error) {
					const dispatchError = error instanceof Error ? error : new Error(String(error));
					this.#rejectEntries(built.entries, dispatchError);
					logger.warn("Yield queue streaming dispatch failed", { kind, error: formatError(error) });
				}
			} else {
				idleMessages.push(built);
			}
		}
		if (mode === "idle" && idleMessages.length > 0) {
			for (const item of idleMessages) this.#attachEntrySettlement(item);
			try {
				await this.#options.injectIdle(idleMessages.map(item => item.message));
				for (const item of idleMessages) {
					(item.message as AgentMessage & { [ASIDE_MESSAGE_COMMIT]?: () => void })[ASIDE_MESSAGE_COMMIT]?.();
				}
			} catch (error) {
				const dispatchError = error instanceof Error ? error : new Error(String(error));
				for (const item of idleMessages) {
					(item.message as AgentMessage & { [ASIDE_MESSAGE_DISCARD]?: (error: Error) => void })[
						ASIDE_MESSAGE_DISCARD
					]?.(dispatchError);
				}
				logger.warn("Yield queue idle dispatch failed", { error: formatError(error) });
				throw error;
			}
		}
		return drainedKinds;
	}

	/**
	 * Snapshot and remove all queued entries, returning one lazy thunk per kind.
	 * Each thunk applies the dispatcher's staleness filter and builds the batched
	 * message only when called — so the consumer (the agent loop) decides, at the
	 * moment it injects, whether the message is still worth delivering (a thunk may
	 * return null to skip). Background-job completions and late diagnostics reach
	 * the model between requests without the agent having to stop.
	 */
	drainLazy(): Array<() => AgentMessage | null> {
		const thunks: Array<() => AgentMessage | null> = [];
		for (const [kind, dispatcher] of this.#dispatchers) {
			const entries = this.#drain(kind);
			if (entries.length === 0) continue;
			thunks.push(() => {
				const built = this.#build(kind, dispatcher, entries);
				if (!built) return null;
				this.#attachEntrySettlement(built);
				return built.message;
			});
		}
		return thunks;
	}

	/** Drop queued entries. With `kind`, drop only that kind's entries (leaving
	 *  any pending idle-flush for other kinds intact); otherwise drop everything. */
	clear(kind?: string): void {
		const error = new Error("Yield queue entry cleared before dispatch");
		if (kind !== undefined) {
			this.#rejectEntries(this.#entries.get(kind) ?? [], error);
			this.#entries.delete(kind);
			return;
		}
		for (const entries of this.#entries.values()) this.#rejectEntries(entries, error);
		this.#entries.clear();
		this.#idleFlushPending = false;
	}

	/** Clear a scheduled-flush latch when its host task is cancelled before running. */
	cancelIdleFlushScheduling(): void {
		this.#idleFlushPending = false;
	}

	#scheduleIdleFlush(): void {
		if (this.#idleFlushPending) return;
		this.#idleFlushPending = true;
		try {
			this.#options.scheduleIdleFlush(async () => {
				this.#idleFlushPending = false;
				if (this.#options.isStreaming()) return;
				await this.flush("idle");
			});
		} catch (error) {
			this.#idleFlushPending = false;
			logger.warn("Yield queue idle flush scheduling failed", { error: formatError(error) });
		}
	}

	#drain(kind: string): StoredEntry[] {
		const entries = this.#entries.get(kind);
		if (!entries || entries.length === 0) return [];
		this.#entries.delete(kind);
		return entries;
	}

	#build(kind: string, dispatcher: StoredDispatcher, entries: StoredEntry[]): BuiltMessage | null {
		const survivors: StoredEntry[] = [];
		for (const entry of entries) {
			if (dispatcher.isStale) {
				let stale: boolean;
				try {
					stale = dispatcher.isStale(entry.value);
				} catch (error) {
					const staleError = error instanceof Error ? error : new Error(String(error));
					entry.reject?.(staleError);
					logger.warn("Yield queue stale check failed", { kind, error: formatError(error) });
					continue;
				}
				if (stale) {
					entry.reject?.(new Error(`Yield queue entry became stale: ${kind}`));
					continue;
				}
			}
			survivors.push(entry);
		}
		if (survivors.length === 0) return null;
		try {
			const message = dispatcher.build(survivors.map(entry => entry.value));
			if (!message) {
				this.#rejectEntries(survivors, new Error(`Yield queue dispatcher skipped entry: ${kind}`));
				return null;
			}
			return { message, entries: survivors };
		} catch (error) {
			const buildError = error instanceof Error ? error : new Error(String(error));
			this.#rejectEntries(survivors, buildError);
			logger.warn("Yield queue build failed", { kind, error: formatError(error) });
			return null;
		}
	}

	#attachEntrySettlement(built: BuiltMessage): void {
		let settled = false;
		Object.defineProperties(built.message, {
			[ASIDE_MESSAGE_COMMIT]: {
				configurable: true,
				value: () => {
					if (settled) return;
					settled = true;
					this.#resolveEntries(built.entries);
				},
			},
			[ASIDE_MESSAGE_DISCARD]: {
				configurable: true,
				value: (error: Error) => {
					if (settled) return;
					settled = true;
					this.#rejectEntries(built.entries, error);
				},
			},
		});
	}

	#resolveEntries(entries: StoredEntry[]): void {
		for (const entry of entries) entry.resolve?.();
	}

	#rejectEntries(entries: StoredEntry[], error: Error): void {
		for (const entry of entries) entry.reject?.(error);
	}
}

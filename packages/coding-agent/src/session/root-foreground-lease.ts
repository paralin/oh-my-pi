import { AsyncLocalStorage } from "node:async_hooks";

export type RootForegroundActor = "root-turn" | "root-cell" | "compaction" | "reload";

interface ForegroundHolder {
	token: symbol;
	references: number;
}

interface ForegroundWaiter {
	token: symbol;
	resolve: (handle: RootForegroundHandle) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abort?: () => void;
}

export interface RootForegroundHandle {
	readonly token: symbol;
	readonly owned: boolean;
	run<T>(work: () => Promise<T>): Promise<T>;
	release(): void;
}

/** RootForegroundLease serializes mutation in one root session while allowing nested work from its current actor. */
export class RootForegroundLease {
	readonly #context = new AsyncLocalStorage<symbol>();
	readonly #waiters: ForegroundWaiter[] = [];
	#holder: ForegroundHolder | undefined;
	#disposedError: Error | undefined;

	async acquire(actor: RootForegroundActor, signal?: AbortSignal): Promise<RootForegroundHandle> {
		if (this.#disposedError) throw this.#disposedError;
		const current = this.#context.getStore();
		if (this.#holder && current === this.#holder.token) {
			this.#holder.references++;
			return this.#handle(this.#holder.token, false);
		}
		if (signal?.aborted) throw new Error("Root foreground admission aborted");
		const token = Symbol(actor);
		const { promise, resolve, reject } = Promise.withResolvers<RootForegroundHandle>();
		const waiter: ForegroundWaiter = { token, resolve, reject, signal };
		if (signal) {
			waiter.abort = () => {
				const index = this.#waiters.indexOf(waiter);
				if (index >= 0) this.#waiters.splice(index, 1);
				reject(new Error("Root foreground admission aborted"));
			};
			signal.addEventListener("abort", waiter.abort, { once: true });
		}
		this.#waiters.push(waiter);
		this.#admitNext();
		return promise;
	}

	async run<T>(actor: RootForegroundActor, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const handle = await this.acquire(actor, signal);
		try {
			return await handle.run(work);
		} finally {
			handle.release();
		}
	}

	enterAct(token: symbol): () => void {
		if (!this.#holder || this.#holder.token !== token) {
			throw new Error("Act host request is not correlated to the active root foreground execution");
		}
		return () => {};
	}

	dispose(error = new Error("Root foreground lease disposed")): void {
		if (this.#disposedError) return;
		this.#disposedError = error;
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
			waiter.reject(error);
		}
	}

	#admitNext(): void {
		if (this.#holder || this.#disposedError) return;
		const waiter = this.#waiters.shift();
		if (!waiter) return;
		if (waiter.abort) waiter.signal?.removeEventListener("abort", waiter.abort);
		this.#holder = { token: waiter.token, references: 1 };
		waiter.resolve(this.#handle(waiter.token, true));
	}

	#handle(token: symbol, owned: boolean): RootForegroundHandle {
		let released = false;
		return {
			token,
			owned,
			run: work => this.#context.run(token, work),
			release: () => {
				if (released) return;
				released = true;
				if (this.#holder?.token !== token) return;
				this.#holder.references--;
				if (this.#holder.references > 0) return;
				this.#holder = undefined;
				this.#admitNext();
			},
		};
	}
}

import * as os from "node:os";

const MAX_DIRECT_BOOT_CONCURRENCY = 64;

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

export function resolveIpythonBootConcurrency(
	environment: Readonly<Record<string, string | undefined>> = process.env,
	cpuCount = os.cpus().length,
): number {
	const fallback = Math.min(16, Math.max(4, (cpuCount || 4) * 2));
	const raw = environment.OMP_MAX_CONCURRENT_IPYTHON_BOOTS;
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return parsed < 1 ? fallback : Math.min(parsed, MAX_DIRECT_BOOT_CONCURRENCY);
}

interface BootWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	readonly signal: AbortSignal | undefined;
	readonly onAbort: (() => void) | undefined;
}

/** Bounds direct controller and kernel starts while leaving runtime setup under its process lock. */
export class IpythonBootGate {
	readonly #limit: number;
	#active = 0;
	#queue: BootWaiter[] = [];

	constructor(limit = resolveIpythonBootConcurrency()) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("IPython boot concurrency must be positive");
		this.#limit = limit;
	}

	async run<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		await this.#acquire(signal);
		try {
			return await boot();
		} finally {
			this.#release();
		}
	}

	#acquire(signal: AbortSignal | undefined): Promise<void> {
		if (signal?.aborted) return Promise.reject(abortReason(signal));
		if (this.#active < this.#limit) {
			this.#active += 1;
			return Promise.resolve();
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let waiter: BootWaiter;
		let onAbort: (() => void) | undefined;
		if (signal) {
			onAbort = () => {
				if (onAbort) signal.removeEventListener("abort", onAbort);
				const index = this.#queue.indexOf(waiter);
				if (index >= 0) this.#queue.splice(index, 1);
				reject(abortReason(signal));
			};
		}
		waiter = { resolve, reject, signal, onAbort };
		this.#queue.push(waiter);
		if (signal && onAbort) {
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		}
		return promise;
	}

	#release(): void {
		this.#active -= 1;
		const next = this.#queue.shift();
		if (!next) return;
		if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
		this.#active += 1;
		next.resolve();
	}
}

const sharedBootGate = new IpythonBootGate();

export function withIpythonBootPermit<T>(boot: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	return sharedBootGate.run(boot, signal);
}

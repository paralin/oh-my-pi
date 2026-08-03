import { isAbortError as isStarpcAbortError } from "starpc";
import { resolveWorldSocketPath, type WorldSocketSources } from "./config.js";
import type { LookupDispatchIntentResponse, SessionSummary } from "./generated/llmsession.pb.js";
import { GladosResourceServiceClient } from "./generated/llmsession_srpc.pb.js";
import { type IntentKeySource, intentKey } from "./intent-key.js";
import { abortError, callWithAbort, type DialFn, WorldTransport } from "./transport.js";

/** Largest session page one `listSessions` call will ask the daemon for. */
export const MAX_SESSION_PAGE = 500;

/**
 * Default bound on one dispatch-intent lookup.
 *
 * The daemon deliberately holds `LookupDispatchIntent` open while an admitted
 * attempt is still binding, which is what removes client-side polling. The
 * flip side is that an attempt which never binds would block an unbounded
 * caller forever, so the client brings its own deadline. `listSessions` needs
 * none: the daemon answers it from a fixed read and never waits.
 */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/** The generated GLaDOS surface this client depends on. */
export interface WorldService {
	ListSessions(req: { limit: number }, signal?: AbortSignal): Promise<{ sessions?: SessionSummary[] }>;
	LookupDispatchIntent(
		req: { intentKey: string; waitForCustody: boolean },
		signal?: AbortSignal,
	): Promise<LookupDispatchIntentResponse>;
}

/**
 * One live session with a World daemon.
 *
 * Endpoints are single-use: `usable` goes false once the session fails or
 * closes and never returns true, which is what makes the client build a fresh
 * one after a daemon restart instead of replaying a dead client handle. A
 * cancelled call does not retire the endpoint — starpc scopes that
 * cancellation to the one call.
 */
export interface WorldEndpoint {
	readonly service: WorldService;
	readonly usable: boolean;
	/** Run one call, cancelled by `signal` without disturbing the session. */
	call<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T>;
	close(): Promise<void>;
}

export interface WorldClientOptions extends WorldSocketSources {
	/** Socket dial seam. Substituted in tests; never reached when unconfigured. */
	dial?: DialFn;
	/**
	 * Endpoint seam. Replaces the whole connect-and-bind path, so a test can
	 * drive the generated service surface without a live daemon. The signal it
	 * receives is the client's own lifetime signal, which aborts on `close`.
	 */
	openEndpoint?: (socketPath: string, signal: AbortSignal) => Promise<WorldEndpoint>;
}

/** One resolved dispatch intent, or a typed absence. */
export type DispatchIntentLookup =
	| { found: false }
	| {
			found: true;
			intentState: string;
			activeAttemptKey: string;
			attemptState: string;
			session: SessionSummary | undefined;
			custody: LookupDispatchIntentResponse["custody"];
			awaitingCustody: boolean;
	  };

/**
 * The configured GLaDOS World client.
 *
 * The client is inert unless a socket path is configured: {@link create}
 * returns `undefined` and nothing is dialed. That is the normal runtime state,
 * so construction must not be what decides whether omp talks to a daemon.
 *
 * One endpoint — the ResourceClient session and its root resource handle — is
 * established lazily and reused over a single Yamux-muxed socket, with each
 * call carried on its own muxed stream. A failed or closed endpoint is
 * discarded rather than revived, so the operation after a daemon restart builds
 * a fresh one instead of replaying a handle the daemon forgot.
 */
export class WorldClient {
	readonly socketPath: string;
	readonly #openEndpoint: (socketPath: string, signal: AbortSignal) => Promise<WorldEndpoint>;
	/**
	 * Cancels work this client started on its own behalf. Connecting is shared
	 * between concurrent callers, so no single caller's signal may cancel it;
	 * `close` is what stops it, and this is the signal that carries that.
	 */
	readonly #lifetime = new AbortController();
	#endpoint: WorldEndpoint | null = null;
	#connecting: Promise<WorldEndpoint> | null = null;
	#closed = false;

	private constructor(socketPath: string, options: WorldClientOptions) {
		this.socketPath = socketPath;
		const dial = options.dial;
		this.#openEndpoint = options.openEndpoint ?? ((path, signal) => openResourceEndpoint(path, dial, signal));
	}

	/**
	 * Construct a client when a World socket is configured, else `undefined`.
	 *
	 * Nothing is dialed here. The unconfigured path must not construct a
	 * transport or touch the dial seam at all.
	 */
	static create(options: WorldClientOptions = {}): WorldClient | undefined {
		const socketPath = resolveWorldSocketPath(options);
		if (!socketPath) return undefined;
		return new WorldClient(socketPath, options);
	}

	/** Whether a connection is currently established. */
	get connected(): boolean {
		return this.#endpoint?.usable ?? false;
	}

	/**
	 * List session summaries in the daemon's object-key order.
	 *
	 * `limit` is required and must be positive: an unbounded list of a
	 * long-running daemon's sessions is a page this client has no use for and
	 * the daemon has no obligation to bound.
	 */
	async listSessions(limit: number, signal?: AbortSignal): Promise<SessionSummary[]> {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error(`session list limit must be a positive integer: ${limit}`);
		}
		if (limit > MAX_SESSION_PAGE) {
			throw new Error(`session list limit ${limit} exceeds the ${MAX_SESSION_PAGE} row page bound`);
		}
		const endpoint = await this.#connect(signal);
		const response = await this.#call(endpoint, () => endpoint.service.ListSessions({ limit }, signal), signal);
		return response.sessions ?? [];
	}

	/**
	 * Resolve one dispatch intent key directly.
	 *
	 * This is the recovery predicate for a submission whose response was lost:
	 * the key computed by {@link deriveIntentKey} before submitting resolves the
	 * work the daemon already owns. A key with no stored intent is a typed
	 * absence, not an error, and listing sessions cannot answer it.
	 *
	 * `waitForCustody` defaults to true, so an admitted attempt can hold this
	 * call open until executor custody appears or the attempt settles. Set it
	 * false to read the current `awaitingCustody` observation without waiting.
	 */
	async lookupDispatchIntent(
		key: string,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_LOOKUP_TIMEOUT_MS,
		waitForCustody: boolean = true,
	): Promise<DispatchIntentLookup> {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("dispatch intent key is required");
		// The caller's own cancellation still wins; the deadline only adds an
		// upper bound so a never-binding attempt cannot hold the caller forever.
		const bounded = boundOperation(signal, timeoutMs);
		let response: LookupDispatchIntentResponse;
		try {
			const endpoint = await this.#connect(bounded.signal);
			response = await this.#call(
				endpoint,
				() => endpoint.service.LookupDispatchIntent({ intentKey: trimmed, waitForCustody }, bounded.signal),
				bounded.signal,
			);
		} catch (error) {
			// Report which clock ran out. A caller that aborted already knows.
			if (bounded.expired() && !signal?.aborted) {
				throw new Error(`dispatch intent lookup exceeded ${timeoutMs}ms for ${trimmed}`);
			}
			throw error;
		} finally {
			bounded.dispose();
		}
		if (!response.found) return { found: false };
		return {
			found: true,
			intentState: response.intentState ?? "",
			activeAttemptKey: response.activeAttemptKey ?? "",
			attemptState: response.attemptState ?? "",
			session: response.session,
			custody: response.custody,
			awaitingCustody: response.awaitingCustody ?? false,
		};
	}

	/**
	 * Derive the deterministic dispatch intent key for one identity tuple.
	 *
	 * Callers compute this before submitting so the submission stays
	 * recoverable. It touches no transport.
	 */
	deriveIntentKey(source: IntentKeySource): { intentKey: string; source: IntentKeySource } {
		return intentKey(source);
	}

	/**
	 * Release the connection and refuse further work. Idempotent.
	 *
	 * A connect still in flight is cancelled through the client's own lifetime
	 * signal and then awaited, so `close` does not return while a socket is
	 * still being opened and cannot leak an endpoint that arrives late.
	 */
	async close(): Promise<void> {
		this.#closed = true;
		this.#lifetime.abort(abortError());
		const connecting = this.#connecting;
		await this.#discard();
		if (!connecting) return;
		const late = await connecting.catch(() => null);
		if (late) await late.close();
	}

	async #connect(signal?: AbortSignal): Promise<WorldEndpoint> {
		if (this.#closed) throw new Error("World client is closed");
		if (signal?.aborted) throw abortError();
		const current = this.#endpoint;
		if (current) {
			if (current.usable) return current;
			// The endpoint retired itself. Drop it so this call reconnects
			// instead of replaying a handle the daemon no longer holds.
			await this.#discard();
		}
		this.#connecting ??= this.#open().finally(() => {
			this.#connecting = null;
		});
		const connecting = this.#connecting;
		if (!signal) return await connecting;
		// Compose the two cancellations rather than conflating them: the shared
		// connect belongs to the client and only `close` stops it, while this
		// caller stops waiting the moment its own signal fires.
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([connecting, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			aborted.promise.catch(() => {});
		}
	}

	async #open(): Promise<WorldEndpoint> {
		const endpoint = await this.#openEndpoint(this.socketPath, this.#lifetime.signal);
		if (this.#closed) {
			await endpoint.close();
			throw new Error("World client is closed");
		}
		this.#endpoint = endpoint;
		return endpoint;
	}

	/**
	 * Run one call, discarding the endpoint whenever it does not complete
	 * cleanly. A transport that produced an error is not trusted for the next
	 * operation.
	 */
	async #call<T>(endpoint: WorldEndpoint, start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		// The abort can land while the connection is still opening, so it is
		// re-checked here rather than only before connecting. Starting the RPC
		// first would leave a request in flight that nobody is waiting for.
		if (signal?.aborted) throw abortError();
		try {
			return await endpoint.call(start(), signal);
		} catch (error) {
			// A cancelled call is scoped to that call: starpc ends it and the
			// session is untouched, so an endpoint that still reports itself
			// usable keeps serving. Discarding here would make every abort cost
			// the next caller a re-handshake.
			if (isAbortError(error) && endpoint.usable) throw error;
			await this.#discard(endpoint);
			throw error;
		}
	}

	/**
	 * Drop `endpoint` if it is still the current one.
	 *
	 * The identity check is the point. Two operations can share an endpoint; if
	 * the first fails, reconnects, and the second fails afterwards, an
	 * unconditional discard would close the healthy replacement the first
	 * operation just established and break calls already running on it.
	 */
	async #discard(endpoint: WorldEndpoint | null = this.#endpoint): Promise<void> {
		if (!endpoint || this.#endpoint !== endpoint) return;
		this.#endpoint = null;
		await endpoint.close();
	}
}

/**
 * Open one Resource SDK endpoint and bind the generated GLaDOS service to its
 * root resource.
 */
export async function openResourceEndpoint(
	socketPath: string,
	dial?: DialFn,
	signal?: AbortSignal,
): Promise<WorldEndpoint> {
	const transport = new WorldTransport({ socketPath, dial });
	try {
		const ref = await transport.accessRootResource(signal);
		const service: WorldService = new GladosResourceServiceClient(ref.rpc);
		return {
			service,
			get usable() {
				return transport.usable;
			},
			call: (pending, callSignal) => callWithAbort(pending, callSignal),
			close: async () => {
				await ref.release();
				await transport.close();
			},
		};
	} catch (error) {
		await transport.close();
		throw error;
	}
}

/** One caller signal combined with a client-owned deadline. */
interface BoundedOperation {
	signal: AbortSignal | undefined;
	expired: () => boolean;
	dispose: () => void;
}

/**
 * Compose the caller's signal with a deadline of this client's own.
 *
 * The two cancellations stay distinguishable: `expired` reports whether the
 * deadline is what fired, so a timeout is not reported back as the caller's own
 * abort. A non-positive timeout means the caller opted out and keeps its signal
 * unchanged.
 */
function boundOperation(signal: AbortSignal | undefined, timeoutMs: number): BoundedOperation {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return { signal, expired: () => false, dispose: () => {} };
	}
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(abortError());
	}, timeoutMs);
	timer.unref?.();
	const onCallerAbort = () => controller.abort(abortError());
	if (signal?.aborted) controller.abort(abortError());
	else signal?.addEventListener("abort", onCallerAbort, { once: true });
	return {
		signal: controller.signal,
		expired: () => expired,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

/**
 * Whether one rejection is a cancellation rather than a transport failure.
 *
 * starpc does not raise a DOMException-shaped AbortError when it cancels a call
 * mid-flight: it throws a plain `new Error("ERR_RPC_ABORT")`, whose `name` is
 * just "Error". Matching on `name` alone therefore misses the library's own
 * cancellation and reads it as a dead transport — which, on a shared Yamux
 * connection, would tear down the session and every concurrent call on it
 * because one caller aborted. starpc's own predicate is the authority here, so
 * it stays correct if that sentinel ever changes.
 */
function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || isStarpcAbortError(error);
}

import net from "node:net";
import type { ProtoRpc } from "starpc";
import { openRpcStream, Client as SrpcClient, StreamConn } from "starpc";
import type { ResourceClientResponse } from "./generated/resource.pb.js";
import { ResourceServiceClient } from "./generated/resource_srpc.pb.js";

/**
 * Opens one connected socket to an absolute Unix path.
 *
 * This is the single seam every test substitutes: an unconfigured runtime must
 * never reach it, and a test that wants a fake daemon replaces it rather than
 * binding a real socket.
 */
export type DialFn = (socketPath: string, signal: AbortSignal) => Promise<net.Socket>;

/** Connect one Unix socket, honouring `signal` while the connection is pending. */
export const dialUnixSocket: DialFn = async (socketPath, signal) => {
	if (signal.aborted) throw abortError();
	const socket = net.createConnection({ path: socketPath });
	return await new Promise<net.Socket>((resolve, reject) => {
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			socket.removeListener("connect", onConnect);
			socket.removeListener("error", onError);
		};
		const onAbort = () => {
			cleanup();
			socket.destroy();
			reject(abortError());
		};
		const onConnect = () => {
			cleanup();
			resolve(socket);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		socket.once("connect", onConnect);
		socket.once("error", onError);
	});
};

/**
 * How long close waits on stream cleanup it does not own before returning.
 *
 * Cleanup is best effort by nature: the drain and the response iterator both
 * end when the daemon ends them. Waiting unbounded would turn a courtesy into a
 * hang.
 */
const CLOSE_SETTLE_MS = 1000;

/** How long a courtesy resource release may take before close stops waiting. */
const RELEASE_SETTLE_MS = 1000;

/** One resource handle held on a {@link WorldTransport}. */
export interface WorldResourceRef {
	readonly resourceId: number;
	readonly rpc: ProtoRpc;
	release(): Promise<void>;
}

export interface WorldTransportOptions {
	socketPath: string;
	dial?: DialFn;
}

/**
 * The Resource SDK transport for one GLaDOS Unix endpoint.
 *
 * GLaDOS serves its resource surface as the root resource behind
 * `ResourceService`, so reaching any typed method means completing the
 * `ResourceClient` handshake first.
 *
 * The daemon Console socket is a Yamux-muxed starpc connection: it wraps every
 * accepted socket in a muxer and serves RPCs as muxed streams, and the starpc
 * length-prefix framing lives *inside* each stream rather than on the socket.
 * `StreamConn` is that client side. Writing length-prefixed packets straight to
 * the socket instead produces no error at all — the daemon's muxer simply reads
 * them as a malformed frame header and waits — so the layering is the protocol,
 * not a detail.
 *
 * One socket carries every call as a separate muxed stream, which is also what
 * the Go client does.
 *
 * A transport is single-use by design. Once it fails or closes it stays closed,
 * and the client above discards it so the next operation builds a fresh one.
 * Reviving a transport whose daemon restarted would silently reuse a client
 * handle the daemon no longer knows.
 */
export class WorldTransport {
	readonly #socketPath: string;
	readonly #dial: DialFn;
	readonly #controller = new AbortController();
	#socket: net.Socket | null = null;
	#conn: StreamConn | null = null;
	#service: ResourceServiceClient | null = null;
	#connecting: Promise<ResourceServiceClient> | null = null;
	#handshaking: Promise<number> | null = null;
	#clientHandleId = 0;
	#rootResourceId = 0;
	#clientStream: AsyncIterator<ResourceClientResponse> | null = null;
	#drain: Promise<void> | null = null;
	#failure: Error | null = null;
	#closed = false;
	#closing: Promise<void> | null = null;

	constructor(options: WorldTransportOptions) {
		if (!options.socketPath.startsWith("/")) {
			throw new Error(`World socket path must be absolute: ${options.socketPath}`);
		}
		this.#socketPath = options.socketPath;
		this.#dial = options.dial ?? dialUnixSocket;
	}

	/** Whether this transport can still serve work. */
	get usable(): boolean {
		return !this.#closed && this.#failure === null;
	}

	/** The failure that retired this transport, when one did. */
	get failure(): Error | null {
		return this.#failure;
	}

	/**
	 * Complete the ResourceClient handshake and return a handle on the root
	 * GLaDOS resource.
	 */
	async accessRootResource(signal?: AbortSignal): Promise<WorldResourceRef> {
		this.#ensureUsable();
		throwIfAborted(signal);
		const rootResourceId = await this.#withAbort(this.#handshake(), signal);
		return this.#createRef(rootResourceId);
	}

	/**
	 * Run the ResourceClient handshake at most once per transport.
	 *
	 * The handshake is the session, not a per-caller step: it mints one client
	 * handle and one root resource id, and its stream is the channel the daemon
	 * announces releases on. Two concurrent callers each opening one would leave
	 * a second handle nobody tracks and a second drain competing for the same
	 * announcements, so the promise is memoized and shared.
	 */
	#handshake(): Promise<number> {
		if (this.#handshaking) return this.#handshaking;
		const pending = this.#performHandshake();
		// A caller that aborts leaves this promise unobserved; keep a rejection
		// from surfacing as an unhandled one.
		pending.catch(() => {});
		this.#handshaking = pending;
		return pending;
	}

	async #performHandshake(): Promise<number> {
		let service: ResourceServiceClient;
		try {
			service = await this.#connect();
		} catch (error) {
			throw this.#fail(error);
		}
		// Stated rather than implied: this client does not implement the held
		// ResourceRpc receipt protocol, so it declines the adoption ack instead
		// of taking the legacy path by leaving the field unset.
		const iterator = service.ResourceClient({ supportsResourceAdoptionAck: false })[Symbol.asyncIterator]();
		this.#clientStream = iterator;
		const first = await iterator.next();
		if (first.done) throw this.#fail(new Error("ResourceClient returned no root resource"));
		const body = first.value.body;
		if (body?.case !== "init") throw this.#fail(new Error("ResourceClient returned no root resource"));
		const clientHandleId = body.value.clientHandleId ?? 0;
		const rootResourceId = body.value.rootResourceId ?? 0;
		if (clientHandleId === 0) throw this.#fail(new Error("ResourceClient returned an empty client handle"));
		if (rootResourceId === 0) throw this.#fail(new Error("ResourceClient returned an empty root resource"));
		this.#clientHandleId = clientHandleId;
		this.#rootResourceId = rootResourceId;

		// The remainder of the stream carries daemon-initiated releases and
		// errors. Draining it in the background is what turns a daemon that went
		// away into a retired transport instead of a silent hang.
		this.#drain = drainResourceClient({ [Symbol.asyncIterator]: () => iterator }).then(
			() => {
				if (!this.#closed) this.#fail(new Error("ResourceClient stream ended unexpectedly"));
			},
			(error: unknown) => {
				if (!this.#closed) this.#fail(error);
			},
		);
		return rootResourceId;
	}

	/**
	 * Retire this transport: abort in-flight work, abort the muxer, and destroy
	 * the socket.
	 *
	 * Close is idempotent, never rejects, and always returns. The teardown order
	 * is what makes that true: the muxer is aborted rather than closed so
	 * outstanding streams reject instead of waiting for a peer that is going
	 * away, and the socket is destroyed so both pumps fall out of their
	 * iteration. The final wait on the drain and the response iterator is
	 * bounded anyway — neither is owned by this side, and a caller that asked to
	 * close must not be held by a stream the daemon never ends.
	 */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		const drain = this.#drain;
		const iterator = this.#clientStream;
		const conn = this.#conn;
		const socket = this.#socket;
		this.#clientStream = null;
		this.#conn = null;
		this.#socket = null;
		this.#service = null;
		this.#handshaking = null;
		this.#closing = (async () => {
			this.#controller.abort(abortError());
			try {
				conn?.close(abortError());
			} catch {
				// The muxer is going away regardless of how it took the news.
			}
			socket?.destroy();
			await settle(
				Promise.allSettled([Promise.resolve().then(() => iterator?.return?.()), drain ?? Promise.resolve()]),
				CLOSE_SETTLE_MS,
			);
		})();
		return this.#closing;
	}

	/**
	 * Dial once and bind the generated ResourceService to the muxed connection.
	 *
	 * Concurrent callers share the one dial: a second socket would be a second
	 * ResourceClient session, and the daemon would hand back a client handle
	 * this transport could not name.
	 */
	async #connect(): Promise<ResourceServiceClient> {
		if (this.#service) return this.#service;
		this.#connecting ??= this.#open().finally(() => {
			this.#connecting = null;
		});
		return await this.#connecting;
	}

	async #open(): Promise<ResourceServiceClient> {
		const signal = this.#controller.signal;
		if (signal.aborted) throw this.#failure ?? abortError();
		const socket = await this.#dial(this.#socketPath, signal);
		const conn = new StreamConn(undefined, { direction: "outbound" });
		this.#socket = socket;
		this.#conn = conn;

		socket.once("close", () => {
			if (!this.#closed) this.#fail(new Error("World daemon closed the connection"));
		});
		socket.once("error", (error: Error) => {
			if (!this.#closed) this.#fail(error);
		});

		// Yamux frames travel raw over the socket in both directions. The
		// starpc length prefixes live inside each muxed stream, so nothing here
		// re-frames the bytes.
		void Promise.resolve(conn.sink(socketSource(socket, signal))).catch((error: unknown) => {
			if (!this.#closed) this.#fail(error);
		});
		void pumpConnToSocket(conn, socket, signal).catch((error: unknown) => {
			if (!this.#closed) this.#fail(error);
		});

		const service = new ResourceServiceClient(conn.buildClient());
		this.#service = service;
		return service;
	}

	#createRef(resourceId: number): WorldResourceRef {
		const service = this.#service;
		if (!service) throw new Error("World transport is not connected");
		let released = false;
		const rpc = openRpcStreamClient(resourceId, service);
		const ref: WorldResourceRef = {
			resourceId,
			rpc,
			release: async () => {
				if (released) return;
				released = true;
				if (this.#closed || this.#failure || this.#clientHandleId === 0) return;
				await releaseResourceHandle(service, this.#clientHandleId, resourceId);
			},
		};
		return ref;
	}

	/**
	 * Race the handshake against the caller's signal, closing the transport when
	 * it fires.
	 *
	 * Unlike an ordinary call, the ResourceClient stream *is* the transport's
	 * session: abandoning it half-established leaves a client handle the daemon
	 * still holds and this side can no longer name. Tearing the transport down is
	 * the only way to release it, so this one race stays.
	 */
	async #withAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
		if (!signal) return await pending;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => {
			void this.close();
			aborted.reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([pending, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			aborted.promise.catch(() => {});
		}
	}

	#ensureUsable(): void {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("World transport is closed");
	}

	#fail(error: unknown): Error {
		const failure = error instanceof Error ? error : new Error(String(error));
		this.#failure ??= failure;
		void this.close();
		return this.#failure;
	}
}

/** The release RPC, named structurally so a test can stand in for it. */
export interface ResourceReleaser {
	ResourceRefRelease(request: { clientHandleId: number; resourceId: number }, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Tell the daemon it may drop one resource handle, as a courtesy.
 *
 * Deliberately carries no AbortSignal. Binding this to the transport's shared
 * lifetime signal looks harmless — the call is already finished by the time
 * close aborts — but starpc only removes its abort listener in the `finally` of
 * the pipe that drives the call, and that has not run yet. Aborting therefore
 * still reaches `writeCallCancel()` on a completed call, which throws
 * ERR_RPC_ABORT from `writePacket`; starpc invokes it unawaited, so the throw
 * becomes an unhandled rejection and takes the process down on close.
 *
 * The wait is bounded and the rejection is observed instead: a daemon that
 * never answers a courtesy must not hold up close, and a release that fails
 * only means the daemon already forgot the handle.
 */
export async function releaseResourceHandle(
	service: ResourceReleaser,
	clientHandleId: number,
	resourceId: number,
	timeoutMs: number = RELEASE_SETTLE_MS,
): Promise<void> {
	await settle(service.ResourceRefRelease({ clientHandleId, resourceId }), timeoutMs);
}

/**
 * Bind one resource id to its own RPC transport over the shared connection.
 *
 * Resource-scoped calls tunnel through `ResourceRpc`, so the resource id is the
 * routing key on a muxed stream the connection opens like any other. Every
 * resource shares the one connection rather than dialing again.
 */
function openRpcStreamClient(resourceId: number, service: ResourceServiceClient): ProtoRpc {
	return new SrpcClient(() => openRpcStream(String(resourceId), service.ResourceRpc.bind(service)));
}

/**
 * Run one call, letting the pinned starpc cancel it on the caller's signal.
 *
 * starpc 0.49.18 registers its own abort listener that writes a CallCancel and
 * ends the call's stream, so the signal handed to the generated client already
 * scopes cancellation to that one call. Racing the call against
 * `transport.close()` on top of that would destroy the connection and the
 * ResourceClient handle for a cancellation the library had already contained.
 *
 * The handshake stream is different and keeps its teardown: see
 * `WorldTransport.#withAbort`.
 */
export async function callWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted) throw abortError();
	return await pending;
}

async function drainResourceClient(stream: AsyncIterable<ResourceClientResponse>): Promise<void> {
	for await (const response of stream) {
		const body = response.body;
		if (body?.case === "resourceReleased") {
			throw new Error(`World resource ${body.value.resourceId ?? 0} was released by the daemon`);
		}
	}
}

async function* socketSource(socket: net.Socket, signal: AbortSignal): AsyncGenerator<Uint8Array> {
	try {
		for await (const chunk of socket) {
			if (signal.aborted) return;
			yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
	}
}

/**
 * Write every muxer frame to the socket, respecting backpressure.
 *
 * Aborting stops the pump on the next frame, and destroying the socket ends the
 * muxer source, so close does not depend on this loop noticing anything.
 */
async function pumpConnToSocket(conn: StreamConn, socket: net.Socket, signal: AbortSignal): Promise<void> {
	try {
		for await (const chunk of conn.source) {
			if (signal.aborted) return;
			// A muxer chunk may be a Uint8ArrayList; subarray flattens either shape.
			await writeSocket(socket, chunk.subarray(), signal);
		}
	} catch (error) {
		if (!signal.aborted) throw error;
		return;
	}
	if (!signal.aborted) socket.end();
}

async function writeSocket(socket: net.Socket, data: Uint8Array, signal: AbortSignal): Promise<void> {
	if (signal.aborted) throw abortError();
	await new Promise<void>((resolve, reject) => {
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		socket.write(data, error => {
			cleanup();
			if (error) reject(error);
			else resolve();
		});
	});
}

/** Await `promise`, giving up after `timeoutMs`. Never rejects. */
async function settle(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<void>(resolve => {
		timer = setTimeout(resolve, timeoutMs);
		timer.unref?.();
	});
	try {
		await Promise.race([promise.then(noop, noop), expiry]);
	} finally {
		clearTimeout(timer);
	}
}

function noop(): void {}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** The canonical abort rejection, named so callers can detect it. */
export function abortError(): Error {
	const error = new Error("World client operation aborted");
	error.name = "AbortError";
	return error;
}

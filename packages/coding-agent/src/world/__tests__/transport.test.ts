import { describe, expect, test } from "bun:test";
import net from "node:net";
import { Duplex } from "node:stream";
import { WorldClient } from "../client.js";
import { ResourceClientRequest, ResourceClientResponse, ResourceRefAdoptRequest } from "../generated/resource.pb.js";
import { ResourceServiceDefinition } from "../generated/resource_srpc.pb.js";
import type { DialFn } from "../transport.js";
import { callWithAbort, type ResourceReleaser, releaseResourceHandle, WorldTransport } from "../transport.js";

const SOCKET = "/run/glados/console.sock";

/** A socket stand-in whose writes are observable frame by frame. */
interface FakeSocket {
	socket: net.Socket;
	/** Resolves with the first frame written to the socket. */
	firstWrite: Promise<Uint8Array>;
	/** Resolves once a frame carries a stream, i.e. a stream was opened. */
	firstStreamFrame: Promise<Uint8Array>;
	writes: Uint8Array[];
	/** Distinct non-zero Yamux stream ids seen, one per opened stream. */
	streamIds: () => number[];
}

/**
 * Build a socket whose writes are observable and whose readable side stays
 * open.
 *
 * The readable side must not end on its own: ending it would signal EOF to the
 * muxer, which would tear the connection down before it ever framed anything.
 */
function fakeSocket(): FakeSocket {
	const writes: Uint8Array[] = [];
	const first = Promise.withResolvers<Uint8Array>();
	const firstStream = Promise.withResolvers<Uint8Array>();
	const duplex = new Duplex({
		read() {
			// Stay open; the test never feeds the client any bytes.
		},
		write(chunk: Uint8Array, _encoding: unknown, callback: (error?: Error | null) => void) {
			const copy = Uint8Array.from(chunk);
			writes.push(copy);
			first.resolve(copy);
			if (yamuxStreamId(copy) !== 0) firstStream.resolve(copy);
			callback();
		},
	});
	first.promise.catch(() => {});
	firstStream.promise.catch(() => {});
	return {
		socket: duplex as unknown as net.Socket,
		firstWrite: first.promise,
		firstStreamFrame: firstStream.promise,
		writes,
		streamIds: () => [...new Set(writes.map(yamuxStreamId).filter(id => id !== 0))],
	};
}

/** Stream id from a Yamux header, or 0 for connection-level frames. */
function yamuxStreamId(frame: Uint8Array): number {
	if (frame.length < 12) return 0;
	return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(4);
}

describe("world transport", () => {
	test("requires an absolute socket path", () => {
		expect(() => new WorldTransport({ socketPath: "relative.sock" })).toThrow(/must be absolute/);
	});

	// A transport is created without dialing; the socket opens on first use.
	test("constructs without dialing", () => {
		const calls: string[] = [];
		const dial: DialFn = async socketPath => {
			calls.push(socketPath);
			throw new Error("unreachable");
		};
		const transport = new WorldTransport({ socketPath: SOCKET, dial });
		expect(transport.usable).toBe(true);
		expect(calls).toEqual([]);
	});

	test("surfaces a dial failure and retires itself", async () => {
		let dials = 0;
		const dial: DialFn = async () => {
			dials++;
			throw new Error("connect ENOENT");
		};
		const transport = new WorldTransport({ socketPath: SOCKET, dial });
		await expect(transport.accessRootResource()).rejects.toThrow(/connect ENOENT/);
		expect(transport.usable).toBe(false);
		await expect(transport.accessRootResource()).rejects.toThrow(/connect ENOENT/);
		expect(dials).toBe(1);
		await transport.close();
	});

	test("refuses work once closed", async () => {
		const transport = new WorldTransport({
			socketPath: SOCKET,
			dial: async () => {
				throw new Error("unreachable");
			},
		});
		await transport.close();
		await expect(transport.accessRootResource()).rejects.toThrow(/closed/);
		// Close is idempotent and never rejects.
		await transport.close();
	});

	test("honours an already-aborted signal before dialing", async () => {
		const calls: string[] = [];
		const dial: DialFn = async socketPath => {
			calls.push(socketPath);
			return new net.Socket();
		};
		const transport = new WorldTransport({ socketPath: SOCKET, dial });
		await expect(transport.accessRootResource(AbortSignal.abort())).rejects.toThrow(/aborted/);
		expect(calls).toEqual([]);
	});
});

describe("dial seam through the client", () => {
	// The production endpoint path is what a real runtime uses. Driving it with
	// an injected dial proves the configured client reaches exactly one socket
	// path, and that a dial failure does not leave a half-built endpoint behind.
	test("a configured client dials the configured path once per connect", async () => {
		const calls: string[] = [];
		const dial: DialFn = async socketPath => {
			calls.push(socketPath);
			throw new Error("no daemon");
		};
		const client = WorldClient.create({ env: {}, setting: SOCKET, dial })!;
		await expect(client.listSessions(1)).rejects.toThrow(/no daemon/);
		expect(calls).toEqual([SOCKET]);
		expect(client.connected).toBe(false);

		await expect(client.listSessions(1)).rejects.toThrow(/no daemon/);
		expect(calls).toEqual([SOCKET, SOCKET]);
	});
});

// The vendored codecs are the only wire format this client speaks, so they have
// to be the schema GLaDOS actually serves. The copy previously predated the
// served proto: it lacked the adoption-ack field, still carried a `clientError`
// oneof case the server marks reserved, and had no ResourceRefAdopt. None of
// that failed to compile — it would have landed as wrong bytes.
describe("vendored resource schema", () => {
	test("carries the adoption-ack field the served proto defines", () => {
		expect(ResourceClientRequest.fields.find(1)?.name).toBe("supports_resource_adoption_ack");
		const request: ResourceClientRequest = { supportsResourceAdoptionAck: true };
		const round = ResourceClientRequest.fromBinary(ResourceClientRequest.toBinary(request));
		expect(round.supportsResourceAdoptionAck).toBe(true);
	});

	test("reserves field 3 rather than decoding it as a client error", () => {
		const cases = ResourceClientResponse.fields
			.list()
			.filter(field => field.oneof?.name === "body")
			.map(field => field.no);
		expect(cases).toEqual([1, 2]);
		expect(cases).not.toContain(3);
	});

	test("declares the ResourceRefAdopt method", () => {
		expect(Object.keys(ResourceServiceDefinition.methods)).toContain("ResourceRefAdopt");
		expect(ResourceRefAdoptRequest.fields.list().map(field => field.name)).toEqual([
			"client_handle_id",
			"resource_id",
		]);
	});
});

describe("call cancellation", () => {
	// starpc cancels the call on the signal it is already handed, so this
	// wrapper must not tear anything down on its own.
	test("passes a call through and rejects only an already-aborted signal", async () => {
		await expect(callWithAbort(Promise.resolve("value"))).resolves.toBe("value");
		await expect(callWithAbort(Promise.resolve("value"), new AbortController().signal)).resolves.toBe("value");
		await expect(callWithAbort(Promise.resolve("value"), AbortSignal.abort())).rejects.toThrow(/aborted/);
	});
});

// The daemon Console socket is a Yamux-muxed starpc connection: the length
// prefixes live inside each muxed stream, not on the socket. A client that
// wrote starpc packets straight to the socket produced no error at all — the
// daemon answered a yamux Ping and the daemon log recorded "invalid protocol
// version" — which is a silent hang, not a failure. These assert the outer
// protocol directly, because the wrong one is indistinguishable from a slow
// daemon.
describe("muxed connection protocol", () => {
	test("frames the socket with Yamux rather than raw starpc packets", async () => {
		const { socket, firstWrite } = fakeSocket();
		const transport = new WorldTransport({ socketPath: SOCKET, dial: async () => socket });
		const handshake = transport.accessRootResource();
		handshake.catch(() => {});

		// Resolved by the intercepted write, so the assertion runs exactly when
		// the muxer has framed something and never on a timer.
		const frame = await firstWrite;

		// A yamux header is 12 bytes: version 0, then a type in 0..3. A raw
		// starpc packet would instead open with a uint32le length, whose first
		// byte is the low byte of that length.
		expect(frame.length).toBeGreaterThanOrEqual(12);
		expect(frame[0]).toBe(0);
		expect(frame[1]).toBeLessThanOrEqual(3);

		await transport.close();
		await handshake.catch(() => {});
	});

	// The handshake is the session: one client handle, one root resource id, and
	// one stream the daemon announces releases on. Two concurrent callers each
	// running it would leave a second handle nobody tracks and a second drain
	// competing for the same announcements.
	test("runs the ResourceClient handshake once for concurrent callers", async () => {
		const { socket, firstStreamFrame, streamIds } = fakeSocket();
		const transport = new WorldTransport({ socketPath: SOCKET, dial: async () => socket });

		// All three call the memoized handshake synchronously before yielding, so
		// by the time any frame lands the number of streams is already decided.
		const first = transport.accessRootResource();
		const second = transport.accessRootResource();
		const third = transport.accessRootResource();
		for (const pending of [first, second, third]) pending.catch(() => {});
		await firstStreamFrame;

		// One stream, one handshake. Unmemoized, each caller opens its own and
		// the muxer assigns a fresh id per stream.
		expect(streamIds()).toHaveLength(1);

		await transport.close();
		await Promise.allSettled([first, second, third]);
	});

	test("carries every call on one socket", async () => {
		let dials = 0;
		const { socket, firstWrite } = fakeSocket();
		const transport = new WorldTransport({
			socketPath: SOCKET,
			dial: async () => {
				dials++;
				return socket;
			},
		});

		const first = transport.accessRootResource();
		const second = transport.accessRootResource();
		first.catch(() => {});
		second.catch(() => {});
		await firstWrite;

		// Concurrent access shares the one dial: a second socket would be a
		// second ResourceClient session with a handle this transport cannot name.
		expect(dials).toBe(1);

		await transport.close();
		await Promise.allSettled([first, second]);
	});

	// Cleanup waits on a drain and a response iterator the daemon owns. A
	// caller that asked to close must not be held by a stream that never ends.
	test("close returns even though the peer never ends the stream", async () => {
		const { socket, firstWrite } = fakeSocket();
		const transport = new WorldTransport({ socketPath: SOCKET, dial: async () => socket });
		const handshake = transport.accessRootResource();
		handshake.catch(() => {});
		await firstWrite;

		await transport.close();
		expect(transport.usable).toBe(false);
		// Idempotent, and the second call cannot hang either.
		await transport.close();
		await handshake.catch(() => {});
	});
});

/** Collect unhandled rejections while `run` executes. */
async function withUnhandledRejectionGuard(run: () => Promise<void>): Promise<unknown[]> {
	const seen: unknown[] = [];
	const onUnhandled = (reason: unknown) => seen.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		await run();
		// Unhandled rejections are reported once a turn of the event loop
		// completes, so this drains turns rather than waiting a fixed time.
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	return seen;
}

// Releasing a resource handle is a courtesy to the daemon, and it used to carry
// the transport's shared lifetime signal. That looks harmless, because the call
// has already completed by the time close aborts. It is not: starpc removes its
// abort listener only in the finally of the pipe driving the call, and that has
// not run yet, so the abort still reaches writeCallCancel on a finished call.
// writePacket then throws ERR_RPC_ABORT from a call site starpc never awaits,
// which surfaces as an unhandled rejection and exits the process on close.
describe("courtesy resource release", () => {
	test("never hands the release an abort signal", async () => {
		const calls: Array<{ request: unknown; signal: AbortSignal | undefined }> = [];
		const service: ResourceReleaser = {
			ResourceRefRelease: async (request, signal) => {
				calls.push({ request, signal });
				return {};
			},
		};

		await releaseResourceHandle(service, 7, 9);

		expect(calls).toHaveLength(1);
		expect(calls[0].request).toEqual({ clientHandleId: 7, resourceId: 9 });
		// The regression is precisely a signal reaching this call.
		expect(calls[0].signal).toBeUndefined();
	});

	test("observes a failed release instead of leaving it unhandled", async () => {
		const service: ResourceReleaser = {
			ResourceRefRelease: async () => {
				// Exactly what an aborted starpc call rejects with.
				throw new Error("ERR_RPC_ABORT");
			},
		};

		const unhandled = await withUnhandledRejectionGuard(async () => {
			await expect(releaseResourceHandle(service, 1, 1)).resolves.toBeUndefined();
		});

		expect(unhandled).toEqual([]);
	});

	test("returns even when the daemon never answers the release", async () => {
		const service: ResourceReleaser = {
			ResourceRefRelease: () => new Promise<never>(() => {}),
		};
		// A zero bound settles on the next turn, so this asserts the bound
		// exists without waiting on one.
		await expect(releaseResourceHandle(service, 1, 1, 0)).resolves.toBeUndefined();
	});

	test("closing a transport reports no unhandled rejection", async () => {
		const unhandled = await withUnhandledRejectionGuard(async () => {
			const { socket, firstWrite } = fakeSocket();
			const transport = new WorldTransport({ socketPath: SOCKET, dial: async () => socket });
			const handshake = transport.accessRootResource();
			handshake.catch(() => {});
			await firstWrite;
			await transport.close();
			await handshake.catch(() => {});
		});

		expect(unhandled).toEqual([]);
	});
});

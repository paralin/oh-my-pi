import net from "node:net";
import type { ProtoRpc } from "starpc";
import { StreamConn } from "starpc";

/** Opens one connected socket to an absolute Unix path. */
export type DialFn = (socketPath: string, signal: AbortSignal) => Promise<net.Socket>;

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

export interface ParentTransportOptions {
	socketPath: string;
	dial?: DialFn;
}

/** One single-use StarPC connection to the configured parent endpoint. */
export class ParentTransport {
	readonly #socketPath: string;
	readonly #dial: DialFn;
	readonly #controller = new AbortController();
	#socket: net.Socket | undefined;
	#conn: StreamConn | undefined;
	#rpc: ProtoRpc | undefined;
	#connecting: Promise<ProtoRpc> | undefined;
	#failure: Error | undefined;
	#closed = false;

	constructor(options: ParentTransportOptions) {
		if (!options.socketPath.startsWith("/"))
			throw new Error(`Parent socket path must be absolute: ${options.socketPath}`);
		this.#socketPath = options.socketPath;
		this.#dial = options.dial ?? dialUnixSocket;
	}

	get usable(): boolean {
		return !this.#closed && !this.#failure;
	}
	get failure(): Error | undefined {
		return this.#failure;
	}

	async connect(signal?: AbortSignal): Promise<ProtoRpc> {
		this.#ensureUsable();
		if (this.#rpc) return this.#rpc;
		this.#connecting ??= this.#open().catch(error => {
			throw this.#fail(error);
		});
		return await callWithAbort(this.#connecting, signal);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort(abortError());
		this.#conn?.close(this.#failure);
		this.#socket?.destroy(this.#failure);
	}

	async #open(): Promise<ProtoRpc> {
		const signal = this.#controller.signal;
		const socket = await this.#dial(this.#socketPath, signal);
		const conn = new StreamConn(undefined, { direction: "outbound" });
		this.#socket = socket;
		this.#conn = conn;
		socket.once("close", () => {
			if (!this.#closed) this.#fail(new Error("Parent endpoint closed the connection"));
		});
		socket.once("error", error => {
			if (!this.#closed) this.#fail(error);
		});
		void Promise.resolve(conn.sink(socketSource(socket, signal))).catch(error => {
			if (!this.#closed) this.#fail(error);
		});
		void pumpConnToSocket(conn, socket, signal).catch(error => {
			if (!this.#closed) this.#fail(error);
		});
		this.#rpc = conn.buildClient();
		return this.#rpc;
	}

	#ensureUsable(): void {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Parent transport is closed");
	}
	#fail(value: unknown): Error {
		const error = value instanceof Error ? value : new Error(String(value));
		this.#failure ??= error;
		void this.close();
		return this.#failure;
	}
}

/** Stop waiting for shared setup without canceling work used by other calls. */
export async function callWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return await pending;
	if (signal.aborted) throw abortError();
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
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

async function pumpConnToSocket(conn: StreamConn, socket: net.Socket, signal: AbortSignal): Promise<void> {
	try {
		for await (const chunk of conn.source) {
			if (signal.aborted) return;
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
			error ? reject(error) : resolve();
		});
	});
}

export function abortError(): Error {
	const error = new Error("Parent client operation aborted");
	error.name = "AbortError";
	return error;
}

import { afterEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { ParentClient } from "@oh-my-pi/pi-coding-agent/parent/client";
import { callWithAbort } from "@oh-my-pi/pi-coding-agent/parent/transport";
import { createHandler, createMux, Server, StreamConn } from "starpc";
import { ParentEnvironmentServiceDefinition } from "../../src/parent/generated/parent-environment_srpc.pb.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

async function serveParent(implementation: object): Promise<string> {
	const dir = await Bun.$`mktemp -d`.text().then(value => value.trim());
	const socketPath = `${dir}/parent.sock`;
	const mux = createMux();
	mux.register(createHandler(ParentEnvironmentServiceDefinition, implementation));
	const connections = new Set<net.Socket>();
	const server = net.createServer(socket => {
		connections.add(socket);
		socket.once("close", () => connections.delete(socket));
		const connection = new StreamConn(new Server(mux.lookupMethod), { direction: "inbound" });
		void Promise.resolve(
			connection.sink(
				(async function* () {
					for await (const chunk of socket) yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
				})(),
			),
		).catch(() => {});
		void (async () => {
			for await (const chunk of connection.source) {
				const bytes = chunk as { subarray(): Uint8Array };
				await new Promise<void>((resolve, reject) =>
					socket.write(bytes.subarray(), error => (error ? reject(error) : resolve())),
				);
			}
		})().catch(() => {});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	cleanups.push(async () => {
		for (const socket of connections) socket.destroy();
		await new Promise<void>(resolve => server.close(() => resolve()));
		await Bun.$`rm -rf ${dir}`.quiet();
	});
	return socketPath;
}

function environment(client: ParentClient) {
	return client.listSessions(100);
}

describe("parent StarPC transport", () => {
	test("stops waiting for shared setup without canceling it", async () => {
		const shared = Promise.withResolvers<string>();
		const controller = new AbortController();
		const caller = callWithAbort(shared.promise, controller.signal);
		controller.abort();
		await expect(caller).rejects.toThrow("aborted");
		shared.resolve("connected");
		expect(await shared.promise).toBe("connected");
	});

	test("uses one Unix connection for a lease and concurrent calls", async () => {
		let opens = 0;
		let lists = 0;
		const socketPath = await serveParent({
			async *OpenEnvironment() {
				opens++;
				yield { environmentId: "environment-1" };
				await new Promise(() => {});
			},
			async ListSessions(request: { environmentId?: string }) {
				lists++;
				expect(request.environmentId).toBe("environment-1");
				return { sessions: [] };
			},
		});
		const client = ParentClient.create({ env: { OMP_PARENT_SOCKET: socketPath, OMP_PARENT_SESSION: "session-1" } })!;
		await Promise.all([environment(client), environment(client), environment(client)]);
		expect(opens).toBe(1);
		expect(lists).toBe(3);
		await client.close();
	});

	test("cancels one call without disturbing another", async () => {
		const canceled = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const socketPath = await serveParent({
			async *OpenEnvironment() {
				yield { environmentId: "environment-1" };
				await new Promise(() => {});
			},
			async ListSessions(request: { limit?: number }, signal?: AbortSignal) {
				if (request.limit !== 1) return { sessions: [{ sessionId: "live" }] };
				started.resolve();
				await new Promise<void>((_resolve, reject) =>
					signal?.addEventListener(
						"abort",
						() => {
							canceled.resolve();
							reject(signal.reason);
						},
						{ once: true },
					),
				);
				return { sessions: [] };
			},
		});
		const client = ParentClient.create({ env: { OMP_PARENT_SOCKET: socketPath, OMP_PARENT_SESSION: "session-1" } })!;
		const controller = new AbortController();
		const slow = client.listSessions(1, controller.signal);
		await started.promise;
		controller.abort();
		await expect(slow).rejects.toThrow();
		await canceled.promise;
		expect(await client.listSessions(2)).toEqual([{ sessionId: "live" }]);
		await client.close();
	});
});

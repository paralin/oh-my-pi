import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { IpythonProcessService } from "../../src/ipython/process-service.js";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "../../src/launch/client.js";
import type { DaemonOperation, DaemonRpcResult, DaemonSnapshot } from "../../src/launch/protocol.js";

function snapshot(name: string, state: DaemonSnapshot["state"] = "ready"): DaemonSnapshot {
	return {
		name,
		id: `${name}-id`,
		state,
		pid: state === "exited" ? undefined : 123,
		createdAt: 1,
		startedAt: 2,
		restartCount: 0,
		outputBytes: 7,
		persist: false,
		detached: false,
	};
}

function request(
	cwd: string,
	data: Readonly<Record<string, unknown>>,
	signal = new AbortController().signal,
): IpythonHostRequest {
	return {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd,
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("processes do not allocate artifacts");
		},
	};
}

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(25);
	}
	return condition();
}

async function shutdown(client: DaemonBrokerClient): Promise<void> {
	try {
		await client.request({ op: "shutdown" });
	} catch {
		// A just-closed broker can disconnect its last client before it replies.
	}
	client.close();
}

function fakeResult(operation: DaemonOperation): DaemonRpcResult {
	const daemon = snapshot("server", operation.op === "stop" ? "exited" : "ready");
	switch (operation.op) {
		case "start":
			return { op: "start", daemon, readyTimedOut: false };
		case "list":
			return { op: "list", daemons: [daemon] };
		case "describe":
			return {
				op: "describe",
				daemon,
				spec: {
					name: daemon.name,
					application: "node",
					args: [],
					env: {},
					cwd: "/workspace",
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			};
		case "logs":
			return { op: "logs", name: daemon.name, text: "READY\nstdin\n", cursor: 7, timedOut: false, state: "ready" };
		case "wait":
			return { op: "wait", daemon, timedOut: false };
		case "send":
			return { op: "send", daemon };
		case "stop":
			return { op: "stop", daemon };
		case "restart":
			return { op: "restart", daemon };
		case "ping":
			return { op: "ping", projectDir: "/workspace" };
		case "shutdown":
			return { op: "shutdown" };
	}
}

describe("IPython process service", () => {
	test("keeps every advertised Python request mapped to a fixed host handler", async () => {
		const source = await Bun.file(new URL("../../src/ipython/python/omp/process.py", import.meta.url)).text();
		const advertised = [...source.matchAll(/host_request\("(process\.[a-z]+)"/g)].map(match => match[1]);
		const service = new IpythonProcessService({
			client: async () => {
				throw new Error("mapping only");
			},
		});
		expect(advertised.sort()).toEqual(Object.keys(service.handlers).sort());
	});

	test("maps every advertised long-lived operation to the retained broker with session ownership", async () => {
		const operations: DaemonOperation[] = [];
		const service = new IpythonProcessService({
			client: async () => ({
				projectDir: "/workspace",
				request: async operation => {
					operations.push(operation);
					return fakeResult(operation);
				},
				onCompletion: () => () => {},
				close: () => {},
			}),
		});
		const call = (operation: string, data: Readonly<Record<string, unknown>> = {}) =>
			service.handlers[operation]!(request(process.cwd(), { type: operation, ...data }));

		const started = await call("process.start", {
			name: "server",
			application: "node",
			args: ["server.js"],
			cwd: "apps/server",
			ready: { log: "READY", timeout_ms: 1_000 },
			persist: true,
		});
		expect(started).toMatchObject({ op: "start", readyTimedOut: false });
		expect(operations[0]).toMatchObject({
			op: "start",
			owner: "session-1",
			spec: {
				cwd: path.join(process.cwd(), "apps/server"),
				ready: { log: "READY", timeoutMs: 1_000 },
				persist: true,
			},
		});
		await call("process.list");
		await call("process.describe", { name: "server" });
		const logs = await call("process.logs", { name: "server", cursor: 3, follow: true });
		expect(logs).toMatchObject({ op: "logs", cursor: 7, text: "READY\nstdin\n" });
		await call("process.wait", { name: "server", for: "ready" });
		await call("process.send", { name: "server", data: "stdin\n" });
		await call("process.restart", { name: "server" });
		const stopped = await call("process.stop", { name: "server" });
		expect(stopped).toMatchObject({ op: "stop", daemon: { state: "exited" } });
		expect(operations.map(operation => operation.op)).toEqual([
			"start",
			"list",
			"describe",
			"logs",
			"wait",
			"send",
			"restart",
			"stop",
		]);
		expect(operations[3]).toMatchObject({ op: "logs", cursor: 3, follow: true });
		expect(operations[4]).toMatchObject({ op: "wait", for: "ready" });
		expect(operations[5]).toMatchObject({ op: "send", data: "stdin\n" });
		expect(operations[6]).toMatchObject({ op: "restart", name: "server" });
		expect(operations[7]).toMatchObject({ op: "stop", name: "server" });
	});

	test("rejects paths outside the project and cancelled work before it reaches the broker", async () => {
		let calls = 0;
		const service = new IpythonProcessService({
			client: async () => ({
				projectDir: "/workspace",
				request: async operation => {
					calls++;
					return fakeResult(operation);
				},
				onCompletion: () => () => {},
				close: () => {},
			}),
		});
		await expect(
			service.handlers["process.start"]!(
				request(process.cwd(), { type: "process.start", name: "bad", application: "node", cwd: "../escape" }),
			),
		).rejects.toThrow("inside the project");
		const abort = new AbortController();
		abort.abort(new Error("cell cancelled"));
		await expect(
			service.handlers["process.list"]!(request(process.cwd(), { type: "process.list" }, abort.signal)),
		).rejects.toThrow("cell cancelled");
		expect(calls).toBe(0);
	});

	test("reconnect lists detached persisted work and reaps nonpersistent broker children", async () => {
		using temp = TempDir.createSync("@omp-ipython-process-reconnect-");
		const projectDir = path.join(temp.path(), "project");
		const runtimeDir = path.join(temp.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.js");
		await Bun.write(scriptPath, "setInterval(() => {}, 1_000);\n");
		let client: DaemonBrokerClient | undefined = await createDaemonBrokerClient(projectDir, {
			runtimeDir,
			idleGraceMs: 5_000,
		});
		const service = new IpythonProcessService({
			client: async () => {
				if (!client) throw new Error("broker client is unavailable");
				return client;
			},
		});
		const call = (operation: string, data: Readonly<Record<string, unknown>> = {}) =>
			service.handlers[operation]!(request(projectDir, { type: operation, ...data }));
		try {
			await call("process.start", {
				name: "persisted",
				application: process.execPath,
				args: [scriptPath],
				pty: false,
				persist: true,
				detached: true,
			});
			await call("process.start", {
				name: "reaped",
				application: process.execPath,
				args: [scriptPath],
				pty: false,
			});
			await shutdown(client);
			client = undefined;
			const brokerStopped = await waitUntil(
				() =>
					Bun.file(path.join(runtimeDir, "broker.pid"))
						.exists()
						.then(exists => !exists),
				5_000,
			);
			expect(brokerStopped).toBeTrue();
			client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const listed = await call("process.list");
			const daemons = listed.daemons as DaemonSnapshot[];
			expect(daemons.find(daemon => daemon.name === "persisted")).toMatchObject({
				state: "running",
				detached: true,
			});
			expect(daemons.find(daemon => daemon.name === "reaped")).toMatchObject({ state: "exited", pid: undefined });
		} finally {
			if (client) {
				await client.request({ op: "stop", name: "persisted", timeoutMs: 2_000 }).catch(() => undefined);
				await shutdown(client);
			}
		}
	}, 15_000);
});

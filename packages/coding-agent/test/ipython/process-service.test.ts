import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
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
	overrides: Partial<Pick<IpythonHostRequest, "allocateArtifact" | "publishProgress">> = {},
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
		...overrides,
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

interface OneShotHarness {
	readonly call: (
		data: Readonly<Record<string, unknown>>,
		signal?: AbortSignal,
	) => Promise<Readonly<Record<string, unknown>>>;
	readonly progress: Array<{ readonly message: string; readonly data: Readonly<Record<string, unknown>> | undefined }>;
}

async function oneShotHarness(
	temp: TempDir,
	onProgress?: (message: string, data: Readonly<Record<string, unknown>> | undefined) => void,
): Promise<OneShotHarness> {
	const cwd = path.join(temp.path(), "project");
	const artifacts = path.join(temp.path(), "artifacts");
	await fs.mkdir(cwd);
	await fs.mkdir(artifacts);
	const service = new IpythonProcessService();
	const progress: Array<{ message: string; data: Readonly<Record<string, unknown>> | undefined }> = [];
	return {
		progress,
		call: async (data, signal = new AbortController().signal) =>
			service.handlers["process.run"]!(
				request(cwd, { type: "process.run", ...data }, signal, {
					publishProgress: async (message, update) => {
						progress.push({ message, data: update });
						onProgress?.(message, update);
					},
					allocateArtifact: async artifact => {
						const artifactPath = path.join(artifacts, `${crypto.randomUUID()}${artifact.suffix}`);
						await Bun.write(artifactPath, "");
						return { ...artifact, path: artifactPath, bytes: 0 };
					},
				}),
			),
	};
}

function processRunning(pid: number): boolean {
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
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

	test("builds run and start argv without shadowing Python builtins", async () => {
		const pythonRoot = path.resolve(import.meta.dir, "../../src/ipython/python");
		const script = [
			"import asyncio, importlib.util, json, pathlib, sys, types",
			"calls = []",
			"async def host_request(name, payload): calls.append([name, payload]); return payload",
			"stub = types.ModuleType('rlm'); stub.host_request = host_request; sys.modules['rlm'] = stub",
			"path = pathlib.Path(sys.argv[1]) / 'omp' / 'process.py'",
			"spec = importlib.util.spec_from_file_location('omp_process_contract', path)",
			"process = importlib.util.module_from_spec(spec); spec.loader.exec_module(process)",
			"async def main():",
			"    await process.run('printf', ['ok\\n'])",
			"    await process.start('server', 'node', ['server.js'])",
			"    print(json.dumps(calls))",
			"asyncio.run(main())",
		].join("\n");
		const child = Bun.spawn(["python3", "-c", script, pythonRoot], {
			env: { ...Bun.env, PYTHONPATH: pythonRoot },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(exitCode, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual([
			["process.run", { application: "printf", args: ["ok\n"] }],
			[
				"process.start",
				{
					name: "server",
					application: "node",
					args: ["server.js"],
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			],
		]);
	});

	test("helper run keeps bounded process heads, tails, exact omission, and transcript path", async () => {
		const pythonRoot = path.resolve(import.meta.dir, "../../src/ipython/python");
		const helperRoot = path.join(pythonRoot, "skills/helpers/src");
		const script = [
			"import asyncio, json, pathlib, sys, types",
			"head = 'PRELOAD-HEAD' + 'h' * (16384 - len('PRELOAD-HEAD'))",
			"tail = 't' * (16384 - len('PRELOAD-TAIL')) + 'PRELOAD-TAIL'",
			"async def run(*args, **kwargs): return {'state':'exited','exit_code':0,'stdout_head':head,'stdout_tail':tail,'stderr_head':'','stderr_tail':'','stdout_bytes':60024,'stderr_bytes':0,'stdout_truncated':True,'stdout_omitted_bytes':27256,'transcript_artifact':{'path':'/tmp/process.txt'}}",
			"omp = types.ModuleType('omp'); omp.process = types.SimpleNamespace(run=run); sys.modules['omp'] = omp",
			"sys.path.insert(0, sys.argv[1])",
			"import helpers",
			"async def main(): print(json.dumps(await helpers.run(['demo'])))",
			"asyncio.run(main())",
		].join("\n");
		const child = Bun.spawn(["python3", "-c", script, helperRoot], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		const output = String(result.stdout_tail);
		const omitted = Number(result.stdout_omitted_bytes);
		const marker = `\n… ${omitted} bytes omitted; full output in transcript …\n`;
		expect(output.startsWith("PRELOAD-HEAD")).toBeTrue();
		expect(output.endsWith("PRELOAD-TAIL")).toBeTrue();
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(32 * 1024);
		expect(omitted + Buffer.byteLength(output) - Buffer.byteLength(marker)).toBe(60_024);
		expect(result.transcript_path).toBe("/tmp/process.txt");
	});

	test("helper run removes overlapping head and tail bytes without a false omission", async () => {
		const pythonRoot = path.resolve(import.meta.dir, "../../src/ipython/python");
		const helperRoot = path.join(pythonRoot, "skills/helpers/src");
		const script = [
			"import asyncio, json, sys, types",
			"full = 'PRELOAD-HEAD' + 'x' * (20000-len('PRELOAD-HEAD')-len('PRELOAD-TAIL')) + 'PRELOAD-TAIL'",
			"async def run(*args, **kwargs): return {'state':'exited','stdout_head':full[:16384],'stdout_tail':full[-16384:],'stderr_head':'','stderr_tail':'','stdout_bytes':len(full),'stderr_bytes':0,'stdout_truncated':True,'transcript_artifact':{'path':'/tmp/process.txt'}}",
			"omp = types.ModuleType('omp'); omp.process = types.SimpleNamespace(run=run); sys.modules['omp'] = omp",
			"sys.path.insert(0, sys.argv[1]); import helpers",
			"async def main(): print(json.dumps(await helpers.run(['demo'])))",
			"asyncio.run(main())",
		].join("\n");
		const child = Bun.spawn(["python3", "-c", script, helperRoot], { stdout: "pipe", stderr: "pipe" });
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code, stderr).toBe(0);
		const result = JSON.parse(stdout) as Record<string, unknown>;
		expect(result.stdout_omitted_bytes).toBe(0);
		expect(String(result.stdout_tail)).toHaveLength(20_000);
		expect(String(result.stdout_tail).startsWith("PRELOAD-HEAD")).toBeTrue();
		expect(String(result.stdout_tail).endsWith("PRELOAD-TAIL")).toBeTrue();
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

	test("runs argv commands with terminal exit and signal state", async () => {
		using temp = TempDir.createSync("@omp-process-run-state-");
		const harness = await oneShotHarness(temp);
		const normal = await harness.call({
			application: process.execPath,
			args: ["-e", "process.stdout.write(process.env.OMP_RUN_EXPLICIT ?? ''); process.stderr.write('err')"],
			env: { OMP_RUN_EXPLICIT: "present" },
		});
		expect(normal).toMatchObject({
			state: "exited",
			exit_code: 0,
			signal: null,
			stdout_tail: "present",
			stderr_tail: "err",
			cancelled: false,
			timed_out: false,
		});
		const nonzero = await harness.call({
			application: process.execPath,
			args: ["-e", "process.stderr.write('failed'); process.exit(7)"],
		});
		expect(nonzero).toMatchObject({ state: "exited", exit_code: 7, stderr_tail: "failed" });
		if (process.platform !== "win32") {
			const signaled = await harness.call({
				application: process.execPath,
				args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
			});
			expect(signaled).toMatchObject({ state: "signaled", exit_code: null, signal: "SIGTERM" });
		}
	});

	test("accepts numeric and duration timeouts and reaps descendants", async () => {
		using temp = TempDir.createSync("@omp-process-run-timeout-");
		const harness = await oneShotHarness(temp);
		for (const timeout of [0.08, "80ms"] as const) {
			const result = await harness.call({
				application: process.execPath,
				args: [
					"-e",
					"const c=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)",
				],
				timeout,
			});
			expect(result).toMatchObject({ state: "timed_out", timed_out: true, cancelled: false });
			const descendant = Number(String(result.stdout_tail).trim());
			expect(Number.isSafeInteger(descendant)).toBeTrue();
			expect(await waitUntil(() => !processRunning(descendant), 2_000)).toBeTrue();
		}
	}, 10_000);

	test("cooperatively cancels the active cell and reaps descendants", async () => {
		using temp = TempDir.createSync("@omp-process-run-cancel-");
		const abort = new AbortController();
		const harness = await oneShotHarness(temp, message => {
			if (message.startsWith("Process output received")) abort.abort(new Error("cell interrupted"));
		});
		const result = await harness.call(
			{
				application: process.execPath,
				args: [
					"-e",
					"const c=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}); process.stdout.write('x'.repeat(70000)+'\\n'+c.pid+'\\n'); setInterval(()=>{},1000)",
				],
			},
			abort.signal,
		);
		expect(result).toMatchObject({ state: "cancelled", cancelled: true, timed_out: false });
		const descendant = Number(String(result.stdout_tail).trim().split("\n").at(-1));
		expect(await waitUntil(() => !processRunning(descendant), 2_000)).toBeTrue();
	}, 10_000);

	test("bounds stream tails, preserves the complete transcript, and coalesces progress", async () => {
		using temp = TempDir.createSync("@omp-process-run-output-");
		const harness = await oneShotHarness(temp);
		const stdout = `PRELOAD-HEAD${"o".repeat(60_000)}PRELOAD-TAIL`;
		const stderr = `PRELOAD-ERR-HEAD${"e".repeat(60_000)}PRELOAD-ERR-TAIL`;
		const result = await harness.call({
			application: process.execPath,
			args: [
				"-e",
				'process.stdout.write("PRELOAD-HEAD"+"o".repeat(60000)+"PRELOAD-TAIL"); process.stderr.write("PRELOAD-ERR-HEAD"+"e".repeat(60000)+"PRELOAD-ERR-TAIL")',
			],
		});
		expect(Buffer.byteLength(String(result.stdout_head))).toBeLessThanOrEqual(16 * 1024);
		expect(Buffer.byteLength(String(result.stdout_tail))).toBeLessThanOrEqual(16 * 1024);
		expect(Buffer.byteLength(String(result.stderr_head))).toBeLessThanOrEqual(16 * 1024);
		expect(Buffer.byteLength(String(result.stderr_tail))).toBeLessThanOrEqual(16 * 1024);
		expect(result).toMatchObject({
			stdout_truncated: true,
			stderr_truncated: true,
			stdout_omitted_bytes: Buffer.byteLength(stdout) - 32 * 1024,
			stderr_omitted_bytes: Buffer.byteLength(stderr) - 32 * 1024,
		});
		expect(String(result.stdout_head).startsWith("PRELOAD-HEAD")).toBeTrue();
		expect(String(result.stderr_head).startsWith("PRELOAD-ERR-HEAD")).toBeTrue();
		expect(String(result.stdout_tail).endsWith("PRELOAD-TAIL")).toBeTrue();
		expect(String(result.stderr_tail).endsWith("PRELOAD-ERR-TAIL")).toBeTrue();
		const artifact = result.transcript_artifact as { path: string; bytes: number };
		const transcript = await Bun.file(artifact.path).text();
		expect(transcript).toContain("PRELOAD-HEAD");
		expect(transcript).toContain("PRELOAD-TAIL");
		expect(transcript).toContain("PRELOAD-ERR-HEAD");
		expect(transcript).toContain("PRELOAD-ERR-TAIL");
		expect(transcript).toContain("state: exited");
		expect(Buffer.byteLength(transcript)).toBeGreaterThan(Buffer.byteLength(stdout) + Buffer.byteLength(stderr));
		expect(artifact.bytes).toBe(Buffer.byteLength(transcript));
		const outputUpdates = harness.progress.filter(update => update.message.startsWith("Process output received"));
		expect(outputUpdates.length).toBeLessThanOrEqual(62);
		expect(harness.progress.every(update => update.message.length <= 4_000)).toBeTrue();
		expect(harness.progress.at(-1)?.data).toMatchObject({
			count: Buffer.byteLength(stdout) + Buffer.byteLength(stderr),
			unit: "bytes",
		});
	});

	test("publishes evolving virtual stdout and stderr tails with transcript progress", async () => {
		using temp = TempDir.createSync("@omp-process-run-live-tail-");
		const harness = await oneShotHarness(temp);
		const result = await harness.call({
			application: "/bin/sh",
			args: [
				"-c",
				"printf 'boot\n'; sleep 0.1; printf 'state 1\r'; sleep 0.1; printf 'state 2\r'; sleep 0.1; printf 'warning\n' >&2; sleep 0.1; printf 'ready\n'",
			],
		});
		const output = harness.progress.filter(update => update.message.startsWith("Process output received"));
		expect(output.some(update => update.message.includes("state 1"))).toBeTrue();
		expect(output.some(update => update.message.includes("state 2"))).toBeTrue();
		expect(output.some(update => update.message.includes("stderr:\nwarning"))).toBeTrue();
		const final = harness.progress.at(-1);
		expect(final?.message).toContain("Process run exited");
		expect(final?.message).toContain("stdout:\nboot\nready");
		expect(final?.message).not.toContain("state 1");
		expect(final?.message).not.toContain("state 2");
		expect(final?.message).toContain("stderr:\nwarning");
		expect(final?.data).toMatchObject({
			path: (result.transcript_artifact as { path: string }).path,
			count: Number(result.stdout_bytes) + Number(result.stderr_bytes),
			unit: "bytes",
		});
		expect(harness.progress.every(update => update.message.length <= 4_000)).toBeTrue();
	});

	test("validates cwd, environment, timeout, and runtime-managed artifact paths", async () => {
		using temp = TempDir.createSync("@omp-process-run-validation-");
		const harness = await oneShotHarness(temp);
		const base = { application: process.execPath, args: ["-e", ""] };
		const atRoot = await harness.call({
			application: process.execPath,
			args: ["-e", "process.stdout.write(process.cwd())"],
			cwd: ".",
		});
		const projectRoot = await fs.realpath(path.join(temp.path(), "project"));
		expect(atRoot).toMatchObject({ cwd: path.join(temp.path(), "project"), stdout_tail: projectRoot });
		await expect(harness.call({ ...base, cwd: "../escape" })).rejects.toThrow("inside the project");
		await expect(harness.call({ ...base, env: { "BAD-NAME": "value" } })).rejects.toThrow("valid bounded");
		await expect(harness.call({ ...base, timeout: "5fortnights" })).rejects.toThrow("duration");
		await expect(harness.call({ ...base, artifact_path: "../../escape" })).rejects.toThrow(
			"unknown field: artifact_path",
		);

		const service = new IpythonProcessService();
		await expect(
			service.handlers["process.run"]!(
				request(temp.path(), { type: "process.run", ...base }, undefined, {
					allocateArtifact: async () => ({ path: "../../escape", mimeType: "text/plain", bytes: 0, label: "bad" }),
				}),
			),
		).rejects.toThrow("runtime artifact path must be absolute");
	});
});

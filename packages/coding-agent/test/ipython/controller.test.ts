import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	IpythonController,
	type IpythonExecutionEvent,
	type IpythonExtensionHostHandlerResolver,
	type IpythonHostHandler,
	type IpythonProcessIds,
} from "../../src/ipython/controller.js";
import { IpythonExtensionRegistry } from "../../src/ipython/extension-registry.js";

function processRunning(pid: number): boolean {
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

function eventLabel(event: IpythonExecutionEvent): string {
	if (event.kind === "stream") return `${event.name}:${event.text}`;
	if (event.kind === "result") return `result:${event.data["text/plain"] ?? ""}`;
	if (event.kind === "display") return `display:${event.text}`;
	if (event.kind === "host_progress") return `progress:${event.operation}:${event.message}`;
	return `error:${event.ename}:${event.evalue}`;
}

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";
const describeIntegration = integrationEnabled ? describe : describe.skip;

async function createIntegrationController(
	prefix: string,
	hostHandlers?: Readonly<Record<string, IpythonHostHandler>>,
	onReady?: (processIds: IpythonProcessIds, status: { readonly restart: boolean }) => void,
	extensionHostHandlerResolver?: IpythonExtensionHostHandlerResolver,
): Promise<{ controller: IpythonController; tempRoot: string }> {
	const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
	if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const home = path.join(tempRoot, "home");
	const tmp = path.join(tempRoot, "tmp");
	await fs.mkdir(home);
	await fs.mkdir(tmp);
	const pythonBin = path.dirname(pythonExecutable);
	return {
		controller: new IpythonController({
			pythonExecutable,
			cwd: tempRoot,
			env: {
				HOME: home,
				TMPDIR: tmp,
				PATH: `${pythonBin}${path.delimiter}${Bun.env.PATH ?? ""}`,
				PYTHONUNBUFFERED: "1",
				PYTHONIOENCODING: "utf-8",
				ANTHROPIC_API_KEY: "must-not-reach-kernel",
				PYTHONPATH: "/must/not/reach/kernel",
				SSH_AUTH_SOCK: "/must/not/reach/kernel.sock",
				OMP_SESSION_ID: "integration-session",
			},
			hostHandlers,
			extensionHostHandlerResolver,
			onReady,
		}),
		tempRoot,
	};
}

describe("IPython controller startup diagnostics", () => {
	test.skipIf(process.platform === "win32")(
		"kills an uncooperative controller and its recorded kernel process",
		async () => {
			const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-forced-dispose-"));
			const scriptPath = path.join(tempRoot, "uncooperative-controller.js");
			await Bun.write(
				scriptPath,
				`const { spawn } = require("node:child_process");
const kernel = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ event: "ready", controller_pid: process.pid, kernel_pid: kernel.pid }) + "\\n");
process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
			);
			const controller = new IpythonController({
				pythonExecutable: process.execPath,
				controllerArgs: [],
				controllerPath: scriptPath,
				cwd: tempRoot,
				shutdownGraceMs: 25,
			});
			let processIds: IpythonProcessIds | undefined;
			try {
				await controller.start();
				processIds = controller.processIds;
				if (!processIds) throw new Error("controller did not publish process IDs");
				await controller.dispose();
				expect(processRunning(processIds.controllerPid)).toBe(false);
				expect(processRunning(processIds.kernelPid)).toBe(false);
			} finally {
				if (processIds) {
					for (const pid of [processIds.controllerPid, processIds.kernelPid]) {
						if (processExists(pid)) process.kill(pid, "SIGKILL");
					}
				}
				await controller.dispose();
				await fs.rm(tempRoot, { recursive: true, force: true });
			}
		},
		10_000,
	);

	test("reaps the kernel tree through its stable reference with Windows disposal semantics", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-windows-forced-dispose-"));
		const scriptPath = path.join(tempRoot, "uncooperative-controller.js");
		await Bun.write(
			scriptPath,
			`const { spawn } = require("node:child_process");
const kernel = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ event: "ready", controller_pid: process.pid, kernel_pid: kernel.pid }) + "\\n");
process.stdin.resume();
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`,
		);
		const controller = new IpythonController({
			pythonExecutable: process.execPath,
			controllerArgs: [],
			controllerPath: scriptPath,
			cwd: tempRoot,
			shutdownGraceMs: 25,
		});
		const platform = process.platform;
		let processIds: IpythonProcessIds | undefined;
		Object.defineProperty(process, "platform", { value: "win32", configurable: true });
		try {
			await controller.start();
			processIds = controller.processIds;
			if (!processIds) throw new Error("controller did not publish process IDs");
			await controller.dispose();
			expect(processRunning(processIds.controllerPid)).toBe(false);
			expect(processRunning(processIds.kernelPid)).toBe(false);
		} finally {
			Object.defineProperty(process, "platform", { value: platform, configurable: true });
			if (processIds) {
				for (const pid of [processIds.controllerPid, processIds.kernelPid]) {
					if (processExists(pid)) process.kill(pid, "SIGKILL");
				}
			}
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 10_000);

	test("surfaces an injected controller's stderr when startup exits", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-startup-failure-"));
		const sentinel = `OMP_IPYTHON_STARTUP_${crypto.randomUUID()}`;
		const scriptPath = path.join(tempRoot, "failing-controller.js");
		await Bun.write(scriptPath, `process.stderr.write(${JSON.stringify(`${sentinel}\n`)}); process.exit(17);\n`);
		const controller = new IpythonController({
			pythonExecutable: process.execPath,
			controllerArgs: [],
			controllerPath: scriptPath,
			cwd: tempRoot,
		});
		try {
			await expect(controller.start()).rejects.toThrow(sentinel);
			await expect(controller.execute("1 + 1")).rejects.toThrow(sentinel);
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});
});

describeIntegration("IPython controller real-kernel boundary", () => {
	test("executes, streams, interrupts, reuses its namespace, and shuts down", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-integration-");
		let processIds: IpythonProcessIds | undefined;
		let observedExit: { controller: boolean; kernel: boolean } | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			expect(processIds).toBeDefined();
			if (!processIds) throw new Error("controller did not publish process IDs");
			expect(processIds.controllerPid).not.toBe(processIds.kernelPid);

			const interpreter = await controller.execute("import sys\nprint(sys.executable)");
			expect(interpreter.status).toBe("ok");
			expect(interpreter.stdout.trim()).toBe(pythonExecutable);

			const environment = await controller.execute(
				"import os; (os.environ.get('OMP_SESSION_ID'), 'ANTHROPIC_API_KEY' in os.environ, 'PYTHONPATH' in os.environ, 'SSH_AUTH_SOCK' in os.environ)",
			);
			expect(environment.result).toBe("('integration-session', False, False, False)");

			const ordered = await controller.execute(
				'import sys\npersistent_value = 41\nprint("out-1", flush=True)\nprint("err-1", file=sys.stderr, flush=True)\nprint("out-2", flush=True)\npersistent_value + 1',
			);
			expect(ordered.status).toBe("ok");
			expect(ordered.stdout).toBe("out-1\nout-2\n");
			expect(ordered.stderr).toBe("err-1\n");
			expect(ordered.result).toBe("42");
			expect(ordered.events.map(eventLabel)).toEqual([
				"stdout:out-1\n",
				"stderr:err-1\n",
				"stdout:out-2\n",
				"result:42",
			]);

			const shell = await controller.execute('\n%%bash\nprintf "bash-out\\n"\nprintf "bash-err\\n" >&2');
			expect(shell.status).toBe("ok");
			expect(shell.stdout).toBe("bash-out\n");
			expect(shell.stderr).toBe("bash-err\n");

			const ready = Promise.withResolvers<void>();
			const blocking = controller.execute('import time\nprint("READY", flush=True)\ntime.sleep(30)', {
				onStream: event => {
					if (event.name === "stdout" && event.text.includes("READY")) ready.resolve();
				},
			});
			await ready.promise;
			await controller.interrupt();
			const aborted = await blocking;
			expect(aborted.status).toBe("aborted");
			expect(aborted.errors.some(error => error.ename === "KeyboardInterrupt")).toBe(true);

			const reused = await controller.execute("persistent_value + 1");
			expect(reused.status).toBe("ok");
			expect(reused.result).toBe("42");
		} finally {
			await controller.dispose();
			if (processIds) {
				observedExit = {
					controller: processExists(processIds.controllerPid),
					kernel: processExists(processIds.kernelPid),
				};
				if (observedExit.controller) process.kill(processIds.controllerPid, "SIGKILL");
				if (observedExit.kernel) process.kill(processIds.kernelPid, "SIGKILL");
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		expect(observedExit).toEqual({ controller: false, kernel: false });
	}, 30_000);

	test("dispatches host requests and preserves rich output and structured errors", async () => {
		const requests: Array<{ type: unknown; value: unknown }> = [];
		const contexts: Array<
			Pick<Parameters<IpythonHostHandler>[0], "sessionId" | "cwd" | "cellId" | "sequence" | "origin" | "authority">
		> = [];
		const blockingStarted = Promise.withResolvers<void>();
		const blockingAborted = Promise.withResolvers<string>();
		const lateStarted = Promise.withResolvers<void>();
		const lateAborted = Promise.withResolvers<string>();
		const failedStarted = Promise.withResolvers<void>();
		const failedAborted = Promise.withResolvers<string>();
		let artifactRoot = "";
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-protocol-", {
			echo: async request => {
				requests.push({ type: request.data.type, value: request.data.value });
				contexts.push({
					sessionId: request.sessionId,
					cwd: request.cwd,
					cellId: request.cellId,
					sequence: request.sequence,
					origin: request.origin,
					authority: request.authority,
				});
				await request.publishProgress("looking up answer", { step: 1 });
				await request.publishDisplay({
					data: { "text/html": "<script>host</script>", "application/json": { step: 1 } },
					metadata: { source: "host" },
					transient: {},
					update: false,
					text: "[displayed MIME types: application/json, text/html]",
				});
				const artifact = await request.allocateArtifact({
					label: "host answer",
					mimeType: "application/json",
					suffix: ".json",
				});
				return { answer: Number(request.data.value) + 1, artifact: artifact.path };
			},
			oversized: () => ({ value: "x".repeat(1_048_577) }),
			badprogress: async request => {
				await request.publishProgress("x".repeat(4_001));
				return {};
			},
			blocking: async request => {
				blockingStarted.resolve();
				return await new Promise<never>((_resolve, reject) => {
					const abort = () => {
						blockingAborted.resolve(
							request.signal.reason instanceof Error ? request.signal.reason.message : "aborted",
						);
						reject(request.signal.reason);
					};
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) abort();
				});
			},
			late: async request => {
				lateStarted.resolve();
				return await new Promise<never>((_resolve, reject) => {
					const abort = () => {
						lateAborted.resolve(
							request.signal.reason instanceof Error ? request.signal.reason.message : "aborted",
						);
						reject(request.signal.reason);
					};
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) abort();
				});
			},
			failed: async request => {
				failedStarted.resolve();
				return await new Promise<never>((_resolve, reject) => {
					const abort = () => {
						failedAborted.resolve(
							request.signal.reason instanceof Error ? request.signal.reason.message : "aborted",
						);
						reject(request.signal.reason);
					};
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) abort();
				});
			},
		});
		artifactRoot = path.join(tempRoot, "host-artifacts");
		let artifactCounter = 0;
		const hostContext = (cellId: string, sequence: number) => ({
			sessionId: "session-context",
			cwd: tempRoot,
			cellId,
			sequence,
			origin: "model" as const,
			authority: "trusted-cell" as const,
			allocateArtifact: async (
				request: { label: string; mimeType: string; suffix: string },
				signal: AbortSignal,
			) => {
				if (signal.aborted) throw signal.reason;
				await fs.mkdir(artifactRoot, { recursive: true });
				const artifactPath = path.join(artifactRoot, `${++artifactCounter}${request.suffix}`);
				await fs.writeFile(artifactPath, "");
				return { path: artifactPath, label: request.label, mimeType: request.mimeType, bytes: 0 };
			},
		});
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			const comm = await controller.execute(
				`
import asyncio
from ipykernel.comm import Comm
kernel = get_ipython().kernel
kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)
kernel.control_handlers.setdefault("comm_close", kernel.comm_manager.comm_close)

async def host_request(data):
    loop = asyncio.get_running_loop()
    reply = loop.create_future()
    host = Comm(target_name="host.request", primary=False)
    host.on_msg(lambda message: loop.call_soon_threadsafe(reply.set_result, message["content"]["data"]))
    host.open(data=data)
    try:
        response = await reply
    finally:
        host.close()
    if response.get("status") != "ok":
        raise RuntimeError(response.get("error", "host request failed"))
    return response

(await host_request({"type": "echo", "value": 41}))["answer"]
`,
				{ hostContext: hostContext("cell-context", 7) },
			);
			expect(comm.status).toBe("ok");
			expect(comm.result).toBe("42");
			expect(requests).toEqual([{ type: "echo", value: 41 }]);
			expect(contexts).toEqual([
				{
					sessionId: "session-context",
					cwd: tempRoot,
					cellId: "cell-context",
					sequence: 7,
					origin: "model",
					authority: "trusted-cell",
				},
			]);
			const progress = comm.events.find(event => event.kind === "host_progress");
			expect(progress).toEqual({
				kind: "host_progress",
				operation: "echo",
				message: "looking up answer",
				data: { step: 1 },
			});
			const hostDisplay = comm.events.find(event => event.kind === "display" && event.metadata.source === "host");
			expect(hostDisplay?.kind === "display" ? hostDisplay.text : undefined).toBe(
				"[displayed MIME types: application/json, text/html]",
			);
			expect(hostDisplay?.kind === "display" ? hostDisplay.data["text/html"] : undefined).toBe(
				"<script>host</script>",
			);
			expect(comm.hostArtifacts).toHaveLength(1);
			expect(comm.hostArtifacts[0]).toMatchObject({
				path: path.join(artifactRoot, "1.json"),
				label: "host answer",
				mimeType: "application/json",
			});
			const unknownRequest = await controller.execute('await host_request({"type": "missing"})', {
				hostContext: hostContext("unknown-context", 8),
			});
			expect(unknownRequest.status).toBe("error");
			expect(unknownRequest.errors[0]?.ename).toBe("RuntimeError");
			expect(unknownRequest.errors[0]?.evalue).toBe("unknown host request type: missing");
			const legacyBridge = await controller.execute('await host_request({"type": "tool.call"})', {
				hostContext: hostContext("legacy-context", 9),
			});
			expect(legacyBridge.status).toBe("error");
			expect(legacyBridge.errors[0]?.evalue).toBe("host operation is reserved: tool.call");
			const oversized = await controller.execute('await host_request({"type": "oversized"})', {
				hostContext: hostContext("oversized-context", 9),
			});
			expect(oversized.status).toBe("error");
			expect(oversized.errors[0]?.evalue).toContain("host response exceeds");
			const badProgress = await controller.execute('await host_request({"type": "badprogress"})', {
				hostContext: hostContext("progress-context", 10),
			});
			expect(badProgress.status).toBe("error");
			expect(badProgress.errors[0]?.evalue).toContain("host progress message exceeds");

			const blocked = controller.execute('await host_request({"type": "blocking"})', {
				hostContext: hostContext("blocked-context", 9),
			});
			await blockingStarted.promise;
			await controller.interrupt();
			expect(await blockingAborted.promise).toBe("IPython cell interrupted");
			expect((await blocked).status).toBe("aborted");
			expect((await controller.execute("20 + 22")).result).toBe("42");

			const lateCell = controller.execute(
				'late_task = asyncio.create_task(host_request({"type": "late"}))\nawait asyncio.sleep(0)\n"detached"',
				{ hostContext: hostContext("late-context", 10) },
			);
			await lateStarted.promise;
			expect((await lateCell).result).toBe("'detached'");
			expect(await lateAborted.promise).toBe("IPython cell completed");
			const lateState = await controller.execute(
				"await asyncio.sleep(0.05)\n(late_task.done(), late_task.cancelled(), type(late_task.exception()).__name__, str(late_task.exception()))",
			);
			expect(lateState.status).toBe("ok");
			expect(lateState.result).toBe("(True, False, 'RuntimeError', 'IPython cell completed')");

			const failedCell = controller.execute(
				'failed_task = asyncio.create_task(host_request({"type": "failed"}))\nawait asyncio.sleep(0)\nraise ValueError("cell boom")',
				{ hostContext: hostContext("failed-context", 11) },
			);
			await failedStarted.promise;
			expect((await failedCell).status).toBe("error");
			expect(await failedAborted.promise).toBe("IPython cell failed");
			const failedState = await controller.execute(
				"await asyncio.sleep(0.05)\n(failed_task.done(), failed_task.cancelled(), type(failed_task.exception()).__name__, str(failed_task.exception()))",
			);
			expect(failedState.result).toBe("(True, False, 'RuntimeError', 'IPython cell failed')");

			const rich = await controller.execute(`
from IPython.display import display
handle = display(
    {"text/plain": "safe-first", "text/html": "<script>first</script>", "application/json": {"step": 1}},
    raw=True,
    display_id=True,
    metadata={"tag": "one"},
)
handle.update(
    {"text/html": "<script>second</script>", "application/json": {"step": 2}},
    raw=True,
    metadata={"tag": "two"},
)
`);
			const displays = rich.events.filter(event => event.kind === "display");
			expect(displays).toHaveLength(2);
			const first = displays[0];
			const second = displays[1];
			if (first?.kind !== "display" || second?.kind !== "display") throw new Error("missing display events");
			expect(first.data).toEqual({
				"text/plain": "safe-first",
				"text/html": "<script>first</script>",
				"application/json": { step: 1 },
			});
			expect(first.metadata).toEqual({ tag: "one" });
			expect(first.transient.display_id).toBeString();
			expect(first.update).toBe(false);
			expect(first.text).toBe("safe-first");
			expect(second.data).toEqual({
				"text/html": "<script>second</script>",
				"application/json": { step: 2 },
			});
			expect(second.metadata).toEqual({ tag: "two" });
			expect(second.transient).toEqual(first.transient);
			expect(second.update).toBe(true);
			expect(second.text).toBe("[displayed MIME types: application/json, text/html]");
			expect(second.text).not.toContain("<script>");

			const failed = await controller.execute('raise ValueError("structured boom")');
			expect(failed.status).toBe("error");
			expect(failed.errors).toHaveLength(1);
			expect(failed.errors[0]?.ename).toBe("ValueError");
			expect(failed.errors[0]?.evalue).toBe("structured boom");
			expect(failed.errors[0]?.traceback.some(line => line.includes("ValueError"))).toBe(true);

			const serializedFirst = controller.execute("serialized = ['first']\nserialized.copy()");
			const serializedSecond = controller.execute("serialized.append('second')\nserialized.copy()");
			const [firstResult, secondResult] = await Promise.all([serializedFirst, serializedSecond]);
			expect(firstResult.result).toBe("['first']");
			expect(secondResult.result).toBe("['first', 'second']");
		} finally {
			await controller.dispose();
			if (processIds) {
				expect(processExists(processIds.controllerPid)).toBe(false);
				expect(processExists(processIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("routes a namespaced extension handler through one live kernel and aborts it cleanly", async () => {
		const registry = new IpythonExtensionRegistry();
		const blockingEntered = Promise.withResolvers<void>();
		const blockingAborted = Promise.withResolvers<string>();
		let artifactRoot = "";
		registry.replace(
			[
				{
					namespace: "demo",
					operation: "run",
					extensionPath: "extension-demo",
					handler: async request => {
						await request.publishProgress("extension started", { value: request.data.value });
						const artifact = await request.allocateArtifact({
							label: "extension result",
							mimeType: "application/json",
							suffix: ".json",
						});
						if (request.data.block === true) {
							blockingEntered.resolve();
							const waiting = Promise.withResolvers<Readonly<Record<string, unknown>>>();
							const abort = () => {
								blockingAborted.resolve(
									request.signal.reason instanceof Error ? request.signal.reason.message : "aborted",
								);
								waiting.reject(request.signal.reason);
							};
							request.signal.addEventListener("abort", abort, { once: true });
							if (request.signal.aborted) abort();
							return await waiting.promise;
						}
						return { answer: Number(request.data.value) + 1, artifact: artifact.path };
					},
				},
			],
			[],
		);
		const { controller, tempRoot } = await createIntegrationController(
			"omp-ipython-extension-handler-",
			undefined,
			undefined,
			operation => registry.getHostHandler(operation),
		);
		artifactRoot = path.join(tempRoot, "host-artifacts");
		const hostContext = {
			sessionId: "extension-session",
			cwd: tempRoot,
			cellId: "extension-cell",
			sequence: 1,
			origin: "model" as const,
			authority: "trusted-cell" as const,
			allocateArtifact: async (
				request: { label: string; mimeType: string; suffix: string },
				signal: AbortSignal,
			) => {
				if (signal.aborted) throw signal.reason;
				await fs.mkdir(artifactRoot, { recursive: true });
				const artifactPath = path.join(artifactRoot, `extension${request.suffix}`);
				await fs.writeFile(artifactPath, "");
				return { path: artifactPath, label: request.label, mimeType: request.mimeType, bytes: 0 };
			},
		};
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			const heapIdentity = (await controller.execute("extension_heap = object(); id(extension_heap)")).result;
			const invoke = `
import asyncio
from ipykernel.comm import Comm
kernel = get_ipython().kernel
kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)

async def extension_request(payload):
    loop = asyncio.get_running_loop()
    reply = loop.create_future()
    host = Comm(target_name="host.request", primary=False)
    host.on_msg(lambda message: loop.call_soon_threadsafe(reply.set_result, message["content"]["data"]))
    host.open(data={"type": "extension.demo.run", **payload})
    try:
        response = await reply
    finally:
        host.close()
    if response.get("status") != "ok":
        raise RuntimeError(response.get("error", "extension request failed"))
    return response
`;
			const completed = await controller.execute(
				`${invoke}
(await extension_request({"value": 41}))["answer"]`,
				{
					hostContext,
				},
			);
			expect(completed.status).toBe("ok");
			expect(completed.result).toBe("42");
			expect(completed.events).toContainEqual({
				kind: "host_progress",
				operation: "extension.demo.run",
				message: "extension started",
				data: { value: 41 },
			});
			expect(completed.hostArtifacts).toMatchObject([
				{
					path: path.join(artifactRoot, "extension.json"),
					label: "extension result",
					mimeType: "application/json",
				},
			]);

			const blocking = controller.execute(
				`${invoke}
await extension_request({"block": True})`,
				{ hostContext },
			);
			await blockingEntered.promise;
			await controller.interrupt();
			expect(await blockingAborted.promise).toBe("IPython cell interrupted");
			expect((await blocking).status).toBe("aborted");
			expect((await controller.execute("20 + 22")).result).toBe("42");

			registry.replace(
				[
					{
						namespace: "demo",
						operation: "run",
						extensionPath: "extension-demo-reloaded",
						handler: request => ({ answer: Number(request.data.value) + 2 }),
					},
				],
				[],
			);
			const reloaded = await controller.execute(
				`${invoke}\n((await extension_request({"value": 41}))["answer"], id(extension_heap))`,
				{ hostContext },
			);
			expect(reloaded.result).toBe(`(43, ${heapIdentity})`);
			expect(controller.processIds).toEqual(processIds);
			registry.replace([], []);
			const removed = await controller.execute(`${invoke}\nawait extension_request({"value": 41})`, { hostContext });
			expect(removed.status).toBe("error");
			expect(removed.errors[0]?.evalue).toBe("unknown host request type: extension.demo.run");
		} finally {
			await controller.dispose();
			if (processIds) {
				expect(processExists(processIds.controllerPid)).toBe(false);
				expect(processExists(processIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("keeps one host comm open for a cooperative multi-message exchange", async () => {
		const received: unknown[] = [];
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-host-channel-", {
			channel: async request => {
				if (!request.channel) throw new Error("host request channel is unavailable");
				await request.channel.send({ kind: "cell-message", value: 1 });
				const first = await request.channel.receive();
				received.push(first);
				await request.channel.send({ kind: "cell-message", value: 2 });
				const second = await request.channel.receive();
				received.push(second);
				return { replies: [first, second] };
			},
		});
		try {
			await controller.start();
			const exchange = await controller.execute(
				`
import asyncio
from ipykernel.comm import Comm
kernel = get_ipython().kernel
kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)
kernel.control_handlers.setdefault("comm_close", kernel.comm_manager.comm_close)
loop = asyncio.get_running_loop()
incoming = asyncio.Queue()
host = Comm(target_name="host.request", primary=False)
host.on_msg(lambda message: loop.call_soon_threadsafe(incoming.put_nowait, message["content"]["data"]))
host.open(data={"type": "channel"})
first = await incoming.get()
assert first["status"] == "event"
host.send(data={"kind": "cell-reply", "value": first["value"] + 10})
second = await incoming.get()
assert second["status"] == "event"
host.send(data={"kind": "cell-reply", "value": second["value"] + 10})
result = {"received": [first, second]}
result
`,
				{
					hostContext: {
						sessionId: "channel-session",
						cwd: tempRoot,
						cellId: "channel-cell",
						sequence: 1,
						origin: "direct",
						authority: "trusted-cell",
					},
				},
			);
			expect(exchange.status).toBe("ok");
			expect(exchange.result).toContain("'cell-message'");
			expect(exchange.result).toContain("'value': 1");
			expect(exchange.result).toContain("'value': 2");
			expect(received).toEqual([
				{ kind: "cell-reply", value: 11 },
				{ kind: "cell-reply", value: 12 },
			]);
			const reusable = await controller.execute("channel_namespace_value = 73\nchannel_namespace_value");
			expect(reusable.status).toBe("ok");
			expect(reusable.result).toBe("73");
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("aborts active host work when the controller is disposed", async () => {
		const admitted = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<string>();
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-host-dispose-", {
			blocking: async request => {
				admitted.resolve();
				return await new Promise<never>((_resolve, reject) => {
					const abort = () => {
						aborted.resolve(request.signal.reason instanceof Error ? request.signal.reason.message : "aborted");
						reject(request.signal.reason);
					};
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) abort();
				});
			},
		});
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			await controller.execute(`
import asyncio
from ipykernel.comm import Comm
kernel = get_ipython().kernel
kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)
kernel.control_handlers.setdefault("comm_close", kernel.comm_manager.comm_close)
async def host_request(data):
    loop = asyncio.get_running_loop()
    reply = loop.create_future()
    host = Comm(target_name="host.request", primary=False)
    host.on_msg(lambda message: loop.call_soon_threadsafe(reply.set_result, message["content"]["data"]))
    host.open(data=data)
    try:
        response = await reply
    finally:
        host.close()
    if response.get("status") != "ok":
        raise RuntimeError(response.get("error", "host request failed"))
    return response
`);
			const execution = controller.execute('await host_request({"type": "blocking"})', {
				hostContext: {
					sessionId: "dispose-session",
					cwd: tempRoot,
					cellId: "dispose-cell",
					sequence: 1,
					origin: "model",
					authority: "trusted-cell",
				},
			});
			await admitted.promise;
			const disposal = controller.dispose();
			expect(await aborted.promise).toBe("IPython controller disposed");
			await expect(execution).rejects.toThrow("IPython controller disposed");
			await disposal;
		} finally {
			await controller.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		if (processIds) {
			expect(processExists(processIds.controllerPid)).toBe(false);
			expect(processExists(processIds.kernelPid)).toBe(false);
		}
	}, 30_000);

	test("recovers after kernel and controller crashes without retaining old processes", async () => {
		const readyEvents: Array<{ processIds: IpythonProcessIds; restart: boolean }> = [];
		const hostStarted = Promise.withResolvers<void>();
		const hostAborted = Promise.withResolvers<string>();
		const { controller, tempRoot } = await createIntegrationController(
			"omp-ipython-recovery-",
			{
				crashhost: async request => {
					hostStarted.resolve();
					return await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							hostAborted.resolve(
								request.signal.reason instanceof Error ? request.signal.reason.message : "aborted",
							);
							reject(request.signal.reason);
						};
						request.signal.addEventListener("abort", abort, { once: true });
						if (request.signal.aborted) abort();
					});
				},
			},
			(processIds, status) => readyEvents.push({ processIds, restart: status.restart }),
		);
		const seen: IpythonProcessIds[] = [];
		try {
			await controller.start();
			const initial = controller.processIds;
			if (!initial) throw new Error("controller did not publish initial process IDs");
			seen.push(initial);

			await expect(controller.execute("import os\nos._exit(23)")).rejects.toThrow(
				"kernel exited unexpectedly; restarted",
			);
			const afterKernelCrash = controller.processIds;
			if (!afterKernelCrash) throw new Error("controller did not publish replacement kernel PID");
			seen.push(afterKernelCrash);
			expect(afterKernelCrash.controllerPid).toBe(initial.controllerPid);
			expect(afterKernelCrash.kernelPid).not.toBe(initial.kernelPid);
			expect(processExists(initial.kernelPid)).toBe(false);
			expect((await controller.execute("6 * 7")).result).toBe("42");

			await controller.execute(`
import asyncio
from ipykernel.comm import Comm
kernel = get_ipython().kernel
kernel.control_handlers.setdefault("comm_msg", kernel.comm_manager.comm_msg)
kernel.control_handlers.setdefault("comm_close", kernel.comm_manager.comm_close)
async def host_request(data):
    loop = asyncio.get_running_loop()
    reply = loop.create_future()
    host = Comm(target_name="host.request", primary=False)
    host.on_msg(lambda message: loop.call_soon_threadsafe(reply.set_result, message["content"]["data"]))
    host.open(data=data)
    try:
        response = await reply
    finally:
        host.close()
    if response.get("status") != "ok":
        raise RuntimeError(response.get("error", "host request failed"))
    return response
`);
			const interruptedByCrash = controller.execute('await host_request({"type": "crashhost"})', {
				hostContext: {
					sessionId: "crash-session",
					cwd: tempRoot,
					cellId: "crash-cell",
					sequence: 1,
					origin: "model",
					authority: "trusted-cell",
				},
			});
			await hostStarted.promise;
			process.kill(afterKernelCrash.controllerPid, "SIGKILL");
			await expect(interruptedByCrash).rejects.toThrow("IPython controller exited");
			expect(await hostAborted.promise).toContain("IPython controller exited");
			expect(processExists(afterKernelCrash.controllerPid)).toBe(false);
			expect(processExists(afterKernelCrash.kernelPid)).toBe(false);

			expect((await controller.execute("40 + 2")).result).toBe("42");
			const recovered = controller.processIds;
			if (!recovered) throw new Error("controller did not publish recovered process IDs");
			seen.push(recovered);
			expect(recovered.controllerPid).not.toBe(afterKernelCrash.controllerPid);
			expect(recovered.kernelPid).not.toBe(afterKernelCrash.kernelPid);
			expect(readyEvents.map(event => event.restart)).toEqual([false, true, true]);
			expect(readyEvents.map(event => event.processIds)).toEqual([initial, afterKernelCrash, recovered]);
		} finally {
			await controller.dispose();
			for (const ids of seen) {
				if (processExists(ids.controllerPid)) process.kill(ids.controllerPid, "SIGKILL");
				if (processExists(ids.kernelPid)) process.kill(ids.kernelPid, "SIGKILL");
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("fans out isolated direct-spawn controller and kernel process trees", async () => {
		const instances = await Promise.all(
			Array.from({ length: 3 }, (_, index) => createIntegrationController(`omp-ipython-fanout-${index}-`)),
		);
		const processIds: IpythonProcessIds[] = [];
		const leakedPids: number[] = [];
		try {
			await Promise.all(instances.map(instance => instance.controller.start()));
			for (const instance of instances) {
				const ids = instance.controller.processIds;
				if (!ids) throw new Error("fan-out controller did not publish process IDs");
				processIds.push(ids);
			}
			const allPids = processIds.flatMap(ids => [ids.controllerPid, ids.kernelPid]);
			expect(new Set(allPids).size).toBe(6);

			const initialized = await Promise.all(
				instances.map((instance, index) => instance.controller.execute(`fanout_value = ${index}; fanout_value`)),
			);
			expect(initialized.map(result => result.result)).toEqual(["0", "1", "2"]);
			const isolated = await Promise.all(
				instances.map(instance => instance.controller.execute("fanout_value += 10; fanout_value")),
			);
			expect(isolated.map(result => result.result)).toEqual(["10", "11", "12"]);
		} finally {
			await Promise.all(instances.map(instance => instance.controller.dispose()));
			for (const ids of processIds) {
				for (const pid of [ids.controllerPid, ids.kernelPid]) {
					if (!processExists(pid)) continue;
					leakedPids.push(pid);
					process.kill(pid, "SIGKILL");
				}
			}
			await Promise.all(instances.map(instance => fs.rm(instance.tempRoot, { recursive: true, force: true })));
		}
		expect(leakedPids).toEqual([]);
	}, 30_000);

	test("snapshots admitted names independently and writes a complete manifest", async () => {
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-snapshot-");
		const snapshotPath = path.join(tempRoot, "state", "kernel-state.dill");
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			const seeded = await controller.execute(`
scalar = 41
container = {"items": [1, 2, 3]}
class CustomValue:
    pass
custom = CustomValue()
class Unpicklable:
    def __reduce__(self):
        raise TypeError("deliberately unpickleable")
unpickleable = Unpicklable()
module_value = __import__("math")
file_handle = __import__("tempfile").TemporaryFile()
socket_handle = __import__("socket").socket()
provider_api_key = "must not persist"
oversized = "x" * 100_000
list = "shadowed list"
len = "shadowed len"
sorted = "shadowed sorted"
isinstance = "shadowed isinstance"
str = "shadowed str"
any = "shadowed any"
`);
			expect(seeded.status).toBe("ok");
			const snapshot = await controller.snapshot(snapshotPath, 65_536);
			expect(snapshot.saved).toEqual(
				expect.arrayContaining([
					"container",
					"custom",
					"scalar",
					"list",
					"len",
					"sorted",
					"isinstance",
					"str",
					"any",
				]),
			);
			for (const name of ["module_value", "file_handle", "socket_handle", "provider_api_key"]) {
				expect(snapshot.skipped.some(entry => entry.name === name)).toBe(true);
			}
			expect(snapshot.oversized.some(entry => entry.name === "oversized")).toBe(true);
			expect(snapshot.failed.some(entry => entry.name === "unpickleable")).toBe(true);
			expect(snapshot.manifestPath).toBe(path.join(tempRoot, "state", "kernel-state.json"));
			const manifest: unknown = await Bun.file(snapshot.manifestPath).json();
			expect(manifest).toMatchObject({
				version: 1,
				saved: expect.arrayContaining(["container", "custom", "scalar"]),
				skipped: expect.arrayContaining([expect.objectContaining({ name: "provider_api_key" })]),
				oversized: expect.arrayContaining([expect.objectContaining({ name: "oversized" })]),
				failed: expect.arrayContaining([expect.objectContaining({ name: "unpickleable" })]),
				bytes: snapshot.bytes,
			});
			await controller.execute("file_handle.close(); socket_handle.close()");

			await controller.dispose();
			const resumed = await createIntegrationController("omp-ipython-snapshot-resume-");
			try {
				await resumed.controller.start();
				const restore = await resumed.controller.restore(snapshotPath);
				expect(restore.missing).toBe(false);
				expect(restore.failed).toEqual([]);
				expect(restore.restored).toEqual(expect.arrayContaining(["container", "custom", "scalar", "list"]));
				const values = await resumed.controller.execute(
					"(scalar, container, custom.__class__.__name__, list, __builtins__.len([1, 2, 3]))",
				);
				expect(values.result).toBe("(41, {'items': [1, 2, 3]}, 'CustomValue', 'shadowed list', 3)");
			} finally {
				await resumed.controller.dispose();
				await fs.rm(resumed.tempRoot, { recursive: true, force: true });
			}
		} finally {
			await controller.dispose();
			if (processIds) {
				expect(processExists(processIds.controllerPid)).toBe(false);
				expect(processExists(processIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("restores good values after a corrupt value and protects runtime names", async () => {
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-restore-failure-");
		const snapshotPath = path.join(tempRoot, "kernel-state.dill");
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			await controller.execute("good_value = 42");
			await controller.snapshot(snapshotPath);
			const corrupt = await controller.execute(`
import dill
with open(${JSON.stringify(snapshotPath)}, "rb") as handle:
    payload = dill.load(handle)
payload["corrupt_value"] = b"not a dill payload"
payload["get_ipython"] = dill.dumps("stale runtime")
with open(${JSON.stringify(snapshotPath)} + ".tmp", "wb") as handle:
    dill.dump(payload, handle)
import os
os.replace(${JSON.stringify(snapshotPath)} + ".tmp", ${JSON.stringify(snapshotPath)})
`);
			expect(corrupt.status).toBe("ok");
			await controller.dispose();
			const resumed = await createIntegrationController("omp-ipython-restore-failure-resume-");
			try {
				await resumed.controller.start();
				const restore = await resumed.controller.restore(snapshotPath);
				expect(restore.missing).toBe(false);
				expect(restore.restored).toContain("good_value");
				expect(restore.failed.some(entry => entry.name === "corrupt_value")).toBe(true);
				expect(restore.failed.some(entry => entry.name === "get_ipython")).toBe(true);
				const usable = await resumed.controller.execute("(good_value, callable(get_ipython))");
				expect(usable.status).toBe("ok");
				expect(usable.result).toBe("(42, True)");
			} finally {
				await resumed.controller.dispose();
				await fs.rm(resumed.tempRoot, { recursive: true, force: true });
			}
		} finally {
			await controller.dispose();
			if (processIds) {
				expect(processExists(processIds.controllerPid)).toBe(false);
				expect(processExists(processIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("keeps the kernel usable when snapshot storage is missing or corrupt", async () => {
		const { controller, tempRoot } = await createIntegrationController("omp-ipython-snapshot-fallback-");
		const snapshotPath = path.join(tempRoot, "missing", "kernel-state.dill");
		let processIds: IpythonProcessIds | undefined;
		try {
			await controller.start();
			processIds = controller.processIds;
			const missing = await controller.restore(snapshotPath);
			expect(missing).toMatchObject({ restored: [], failed: [], missing: true, path: snapshotPath });

			await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
			await Bun.write(snapshotPath, "not a dill payload");
			const corrupt = await controller.restore(snapshotPath);
			expect(corrupt.missing).toBe(false);
			expect(corrupt.restored).toEqual([]);
			expect(corrupt.failed.some(entry => entry.name === "<snapshot>")).toBe(true);

			const blockedPath = path.join(tempRoot, "blocked-snapshot");
			await fs.mkdir(blockedPath);
			const failedSave = await controller.snapshot(blockedPath);
			expect(failedSave.saved).toEqual([]);
			expect(failedSave.failed.some(entry => entry.name === "<snapshot>")).toBe(true);

			const usable = await controller.execute("20 + 22");
			expect(usable.status).toBe("ok");
			expect(usable.result).toBe("42");
		} finally {
			await controller.dispose();
			if (processIds) {
				expect(processExists(processIds.controllerPid)).toBe(false);
				expect(processExists(processIds.kernelPid)).toBe(false);
			}
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);
});

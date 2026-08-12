import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpythonCellProvisioner, IpythonCellService, type IpythonCellUpdate } from "../../src/ipython/cell.js";
import type {
	IpythonExecutionEvent,
	IpythonExecutionHostContext,
	IpythonExecutionResult,
	IpythonProcessIds,
} from "../../src/ipython/controller.js";
import { ipythonEnvironment } from "../../src/ipython/environment.js";
import { projectIpythonLiveCellPresentation } from "../../src/ipython/projection.js";
import { IpythonKernelProvisioner } from "../../src/ipython/provisioner.js";
import type { EnsureIpythonRuntimeOptions, IpythonRuntime } from "../../src/ipython/runtime-bootstrap.js";

function result(
	id: string,
	status: IpythonExecutionResult["status"] = "ok",
	events: readonly IpythonExecutionEvent[] = [],
): IpythonExecutionResult {
	const streams = events.filter(event => event.kind === "stream");
	return {
		id,
		status,
		stdout: streams
			.filter(event => event.name === "stdout")
			.map(event => event.text)
			.join(""),
		stderr: streams
			.filter(event => event.name === "stderr")
			.map(event => event.text)
			.join(""),
		result: undefined,
		events,
		errors: events.filter(event => event.kind === "error"),
		hostArtifacts: [],
	};
}

class FakeCellProvisioner implements IpythonCellProvisioner {
	readonly calls: string[] = [];
	readonly executeCell: (
		code: string,
		onEvent: ((event: IpythonExecutionEvent) => void | Promise<void>) | undefined,
		signal: AbortSignal | undefined,
		hostContext: IpythonExecutionHostContext | undefined,
	) => Promise<IpythonExecutionResult>;
	disposeCount = 0;

	constructor(
		executeCell: (
			code: string,
			onEvent: ((event: IpythonExecutionEvent) => void | Promise<void>) | undefined,
			signal: AbortSignal | undefined,
			hostContext: IpythonExecutionHostContext | undefined,
		) => Promise<IpythonExecutionResult>,
	) {
		this.executeCell = executeCell;
	}

	async ensure(onProgress?: (progress: { stage: "runtime"; message: string }) => void): Promise<void> {
		onProgress?.({ stage: "runtime", message: "runtime" });
	}

	async execute(
		code: string,
		options?: {
			readonly onEvent?: (event: IpythonExecutionEvent) => void | Promise<void>;
			readonly hostContext?: IpythonExecutionHostContext;
		},
		signal?: AbortSignal,
	): Promise<IpythonExecutionResult> {
		this.calls.push(code);
		return await this.executeCell(code, options?.onEvent, signal, options?.hostContext);
	}

	async dispose(): Promise<void> {
		this.disposeCount += 1;
	}
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

describe("IPython cell service", () => {
	test("serializes model and direct cells with shared attribution and safe text", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		let active = 0;
		let maxActive = 0;
		const provisioner = new FakeCellProvisioner(async (code, onEvent) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			try {
				if (code === "model-cell") {
					firstEntered.resolve();
					await releaseFirst.promise;
					const events: IpythonExecutionEvent[] = [
						{ kind: "stream", name: "stdout", text: "\u001b[31mred\u001b[0m\n" },
						{
							kind: "display",
							data: { "text/html": "<script>unsafe()</script>" },
							metadata: {},
							transient: {},
							update: false,
							text: "[displayed MIME types: text/html]",
						},
						{ kind: "result", data: { "text/html": "<script>result()</script>" } },
					];
					for (const event of events) await onEvent?.(event);
					return result("execution-1", "ok", events);
				}
				return { ...result("execution-2"), result: "42" };
			} finally {
				active -= 1;
			}
		});
		const service = new IpythonCellService(provisioner);
		const updates: IpythonCellUpdate[] = [];
		try {
			const model = service.execute({
				code: "model-cell",
				origin: "model",
				onUpdate: update => {
					updates.push(update);
				},
			});
			await firstEntered.promise;
			const direct = service.execute({ code: "direct-cell", origin: "direct" });
			expect(provisioner.calls).toEqual(["model-cell"]);
			expect(service.pendingCount).toBe(2);
			releaseFirst.resolve();
			const [modelResult, directResult] = await Promise.all([model, direct]);

			expect(provisioner.calls).toEqual(["model-cell", "direct-cell"]);
			expect(maxActive).toBe(1);
			expect(modelResult).toMatchObject({
				sequence: 1,
				origin: "model",
				authority: "trusted-cell",
				code: "model-cell",
				status: "ok",
				executionId: "execution-1",
			});
			expect(directResult).toMatchObject({ sequence: 2, origin: "direct", executionId: "execution-2" });
			expect(modelResult.cellId).not.toBe(directResult.cellId);
			expect(modelResult.modelText.text).toContain("red");
			expect(modelResult.modelText.text).not.toContain("\u001b");
			expect(modelResult.modelText.text).toContain("[displayed MIME types: text/html]");
			expect(modelResult.modelText.text).toContain("[result MIME types: text/html]");
			expect(modelResult.modelText.text).not.toContain("<script>");
			expect(updates.every(update => update.cellId === modelResult.cellId && update.origin === "model")).toBe(true);
			expect(typeof modelResult.durationMs).toBe("number");
			expect(service.pendingCount).toBe(0);
		} finally {
			await service.dispose();
		}
	});

	test("binds session and authority context and preserves host progress and allocated artifacts", async () => {
		const contexts: IpythonExecutionHostContext[] = [];
		const provisioner = new FakeCellProvisioner(async (_code, onEvent, _signal, context) => {
			if (!context) throw new Error("missing host context");
			contexts.push(context);
			const progress = {
				kind: "host_progress" as const,
				operation: "workspace.search",
				message: "searched workspace",
				data: { matches: 3 },
			};
			await onEvent?.(progress);
			const artifact = await context.allocateArtifact?.(
				{ label: "search results", mimeType: "application/json", suffix: ".json" },
				new AbortController().signal,
			);
			return { ...result("host-context", "ok", [progress]), hostArtifacts: artifact ? [artifact] : [] };
		});
		const service = new IpythonCellService(provisioner, {
			sessionId: "session-1",
			cwd: "/workspace",
			allocateArtifact: async (request, signal, cellId) => {
				expect(signal.aborted).toBe(false);
				return { id: "artifact-1", path: `/sidecar/${cellId}${request.suffix}`, ...request };
			},
		});
		try {
			const cell = await service.execute({ code: "search", origin: "direct" });
			expect(contexts).toHaveLength(1);
			expect(contexts[0]).toMatchObject({
				sessionId: "session-1",
				cwd: "/workspace",
				cellId: cell.cellId,
				sequence: 1,
				origin: "direct",
				authority: "trusted-cell",
			});
			expect(cell.modelText.text).toContain("[workspace.search] searched workspace");
			expect(cell.artifacts).toMatchObject([
				{
					id: "artifact-1",
					path: `/sidecar/${cell.cellId}.json`,
					label: "search results",
					mimeType: "application/json",
				},
			]);
			expect(cell.updates.some(update => update.kind === "execution" && update.event.kind === "host_progress")).toBe(
				true,
			);
		} finally {
			await service.dispose();
		}
	});

	test("returns a queued cancellation without interrupting the active cell", async () => {
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const provisioner = new FakeCellProvisioner(async code => {
			if (code === "first") {
				firstEntered.resolve();
				await releaseFirst.promise;
			}
			return result(code);
		});
		const service = new IpythonCellService(provisioner);
		try {
			const first = service.execute({ code: "first", origin: "model" });
			await firstEntered.promise;
			const abort = new AbortController();
			const queued = service.execute({ code: "queued", origin: "direct", signal: abort.signal });
			abort.abort(new Error("cancel queued cell"));
			const cancelled = await queued;
			expect(cancelled.status).toBe("aborted");
			expect(cancelled.startedAt).toBeUndefined();
			expect(cancelled.modelText.text).toBe("IPython cell aborted.\n");
			expect(provisioner.calls).toEqual(["first"]);
			releaseFirst.resolve();
			expect((await first).status).toBe("ok");
		} finally {
			await service.dispose();
		}
	});

	test("interrupts an active cell and remains reusable", async () => {
		const activeEntered = Promise.withResolvers<void>();
		const provisioner = new FakeCellProvisioner(async (code, _onEvent, signal) => {
			if (code !== "blocking") return result(code);
			activeEntered.resolve();
			if (!signal) throw new Error("blocking cell requires a signal");
			if (!signal.aborted) {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => resolve(), { once: true });
				await promise;
			}
			return result("blocking", "aborted");
		});
		const service = new IpythonCellService(provisioner);
		try {
			const abort = new AbortController();
			const blocking = service.execute({ code: "blocking", origin: "direct", signal: abort.signal });
			await activeEntered.promise;
			abort.abort(new Error("interrupt active cell"));
			expect((await blocking).status).toBe("aborted");
			expect((await service.execute({ code: "next", origin: "model" })).status).toBe("ok");
		} finally {
			await service.dispose();
		}
	});

	test("bounds a single long model line and converts startup failures to replayable errors", async () => {
		const longLine = "界".repeat(200);
		const provisioner = new FakeCellProvisioner(async () =>
			result("long", "ok", [{ kind: "stream", name: "stdout", text: longLine }]),
		);
		const service = new IpythonCellService(provisioner, { maxModelBytes: 128 });
		try {
			const bounded = await service.execute({ code: "long", origin: "model" });
			expect(bounded.modelText.truncated).toBe(true);
			expect(bounded.modelText.totalBytes).toBe(600);
			expect(bounded.modelText.outputBytes).toBeLessThanOrEqual(128);
			expect(bounded.modelText.text).toContain("[IPython output truncated: 600 bytes total; 540 bytes omitted]");
			expect(bounded.modelText.text).toEndWith("界界界界界界界界界界");
		} finally {
			await service.dispose();
		}

		const failing: IpythonCellProvisioner = {
			async ensure() {
				throw new Error("injected startup failure");
			},
			async execute() {
				throw new Error("execute must not run");
			},
			async dispose() {},
		};
		const failedService = new IpythonCellService(failing);
		try {
			const failed = await failedService.execute({ code: "never", origin: "direct" });
			expect(failed.status).toBe("error");
			expect(failed.errors).toEqual([
				{ kind: "error", ename: "Error", evalue: "injected startup failure", traceback: [] },
			]);
			expect(failed.modelText.text).toContain("Error: injected startup failure");
		} finally {
			await failedService.dispose();
		}
	});
});

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";

function pythonAbiSourcePath(): string {
	const root = path.resolve(import.meta.dir, "../../src/ipython/python");
	const skills = [
		"agent-message",
		"agent-observe",
		"attach-image",
		"compact",
		"edit",
		"goal",
		"refine",
		"rlm-heartbeat",
		"websearch",
		"linear",
		"notion",
	];
	return [root, ...skills.map(skill => path.join(root, "skills", skill, "src"))].join(path.delimiter);
}
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("IPython cell service real-kernel boundary", () => {
	test("shares one namespace across model and direct cells, interrupts, and replays safe output", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-cell-"));
		const home = path.join(tempRoot, "home");
		const sidecarDir = path.join(tempRoot, "sidecar");
		await fs.mkdir(home);
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const provisioner = new IpythonKernelProvisioner(
			{
				cwd: tempRoot,
				sessionId: "cell-session",
				sidecarDir,
				environment: {
					HOME: home,
					PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				},
			},
			{ ensureRuntime },
		);
		const service = new IpythonCellService(provisioner, { maxModelBytes: 512 });
		let processIds: IpythonProcessIds | undefined;
		try {
			const modelUpdates: IpythonCellUpdate[] = [];
			const model = await service.execute({
				origin: "model",
				code: "shared_value = 40\nprint('model-out')\nshared_value + 1",
				onUpdate: update => {
					modelUpdates.push(update);
				},
			});
			processIds = provisioner.processIds;
			expect(model).toMatchObject({ origin: "model", status: "ok", result: "41" });
			expect(model.modelText.text).toBe("model-out\n41\n");
			const live = projectIpythonLiveCellPresentation({
				code: model.code,
				origin: model.origin,
				updates: modelUpdates,
			});
			expect(live.safeText).toEqual(model.modelText);
			expect(live.events).toEqual(model.events);

			const direct = await service.execute({ origin: "direct", code: "shared_value += 2\nshared_value" });
			expect(direct).toMatchObject({ origin: "direct", status: "ok", result: "42" });

			const rich = await service.execute({
				origin: "model",
				code: "from IPython.display import display\ndisplay({'text/html': '<script>unsafe()</script>', 'application/json': {'ok': True}}, raw=True)",
			});
			expect(rich.events.some(event => event.kind === "display" && event.data["text/html"] !== undefined)).toBe(
				true,
			);
			expect(rich.modelText.text).toContain("application/json");
			expect(rich.modelText.text).not.toContain("<script>");

			const traceback = await service.execute({ origin: "direct", code: "raise ValueError('structured')" });
			expect(traceback.status).toBe("error");
			expect(traceback.errors[0]).toMatchObject({ ename: "ValueError", evalue: "structured" });
			expect(traceback.modelText.text).toContain("ValueError");

			const ready = Promise.withResolvers<void>();
			const abort = new AbortController();
			const blocking = service.execute({
				origin: "model",
				code: "import time\nprint('READY', flush=True)\ntime.sleep(30)",
				signal: abort.signal,
				onUpdate: update => {
					if (
						update.kind === "execution" &&
						update.event.kind === "stream" &&
						update.event.text.includes("READY")
					) {
						ready.resolve();
					}
				},
			});
			await ready.promise;
			abort.abort(new Error("interrupt integration cell"));
			expect((await blocking).status).toBe("aborted");
			expect((await service.execute({ origin: "direct", code: "shared_value" })).result).toBe("42");

			const long = await service.execute({ origin: "model", code: "print('界' * 1000, end='')" });
			expect(long.modelText.truncated).toBe(true);
			expect(long.modelText.outputBytes).toBeLessThanOrEqual(512);
		} finally {
			await service.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		if (processIds) {
			expect(processExists(processIds.controllerPid)).toBe(false);
			expect(processExists(processIds.kernelPid)).toBe(false);
		}
	}, 120_000);
});

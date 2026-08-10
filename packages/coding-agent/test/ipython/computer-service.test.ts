import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpythonComputerService } from "../../src/ipython/computer-service.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import type { ComputerRunOk, ComputerSessionSnapshot } from "../../src/tools/computer/protocol.js";
import type { ComputerController } from "../../src/tools/computer/supervisor.js";

const roots: string[] = [];

const capabilities = {
	backend: "fake",
	displayServer: "memory",
	capture: true,
	input: true,
	ax: true,
	backgroundWindowInput: true,
	deliveryModes: ["background" as const, "foreground" as const],
	capturePermission: "granted" as const,
	inputPermission: "granted" as const,
	axPermission: "granted" as const,
	displayCount: 1,
};

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeComputerController implements ComputerController {
	readonly calls: Array<{ code: string; timeoutMs: number; snapshot: ComputerSessionSnapshot; signal?: AbortSignal }> =
		[];
	readonly started = Promise.withResolvers<void>();
	closeCalls = 0;
	closeGate?: Promise<void>;
	closeStarted?: () => void;
	large = false;
	gate?: Promise<void>;

	async run(
		code: string,
		timeoutMs: number,
		snapshot: ComputerSessionSnapshot,
		signal?: AbortSignal,
	): Promise<ComputerRunOk> {
		this.calls.push({ code, timeoutMs, snapshot, signal });
		this.started.resolve();
		await Promise.resolve();
		if (this.gate) {
			await Promise.race([
				this.gate,
				new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true })),
			]);
		}
		return {
			displays: this.large
				? [
						{ type: "text", text: "x".repeat(210_000) },
						{ type: "image", data: Buffer.alloc(270_000, 1).toString("base64"), mimeType: "image/png" },
					]
				: [
						{ type: "text", text: "desktop text" },
						{ type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
					],
			returnValue: { ok: true },
			screenshots: [{ path: "/tmp/screenshot.png", width: 100, height: 80, target: "display-1" }],
			capabilities: { ...capabilities, inputPermission: snapshot.readOnly ? "denied" : "granted" },
		};
	}

	async capabilities() {
		return capabilities;
	}

	async close() {
		this.closeCalls += 1;
		this.closeStarted?.();
		await this.closeGate;
	}
}

async function fixture(timeoutGate?: Promise<void>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-computer-"));
	roots.push(root);
	const controllers: FakeComputerController[] = [];
	const progress: string[] = [];
	const displays: Array<Readonly<Record<string, unknown>>> = [];
	const service = new IpythonComputerService({
		createController: async () => {
			const controller = new FakeComputerController();
			controllers.push(controller);
			return controller;
		},
		snapshot: async (readOnly, identity) => ({
			cwd: identity.cwd,
			sessionId: identity.sessionId,
			captureMaxWidth: 1280,
			captureMaxHeight: 896,
			display: "all",
			readOnly,
		}),
		timeoutMs: async requested => {
			if (timeoutGate) await timeoutGate;
			return (requested ?? 30) * 1_000;
		},
	});
	const call = async (
		operation: string,
		data: Record<string, unknown> = {},
		signal: AbortSignal = new AbortController().signal,
		identity: { sessionId?: string; cwd?: string } = {},
	) => {
		const handler = service.handlers[operation];
		if (!handler) throw new Error(`missing handler: ${operation}`);
		const request: IpythonHostRequest = {
			requestId: "request-1",
			executionId: "execution-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { type: operation, ...data },
			signal,
			sessionId: identity.sessionId ?? "session-1",
			cwd: identity.cwd ?? root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async message => {
				progress.push(message);
			},
			publishDisplay: async display => {
				displays.push(display.data);
			},
			allocateArtifact: async artifact => ({
				path: path.join(root, `artifact-${artifact.label}${artifact.suffix}`),
			}),
		};
		return await handler(request);
	};
	return { root, controllers, progress, displays, service, call };
}

describe("IPython computer service", () => {
	test("reports desktop capabilities", async () => {
		const f = await fixture();
		expect(await f.call("computer.capabilities")).toMatchObject({ capabilities: { backend: "fake" } });
	});

	test("sets busy before timeout resolution and keeps release blocked", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await fixture(gate.promise);
		const first = f.call("computer.evaluate", { code: "await wait(1)" });
		await Promise.resolve();
		await expect(f.call("computer.evaluate", { code: "2" })).rejects.toThrow("busy");
		await expect(f.call("computer.release")).rejects.toThrow("busy");
		gate.resolve();
		await first;
		await f.call("computer.release");
	});

	test("evaluates read-write code by default and supports explicit read-only runs", async () => {
		const f = await fixture();
		await f.call("computer.evaluate", { code: "await desktop.click({x: 1, y: 2})", timeout: 12 });
		await f.call("computer.evaluate", { code: "return await desktop.screenshot()", read_only: true });
		expect(f.controllers[0]?.calls.map(call => call.snapshot.readOnly)).toEqual([false, true]);
		expect(f.controllers[0]?.calls.map(call => call.code)).toEqual([
			"await desktop.click({x: 1, y: 2})",
			"return await desktop.screenshot()",
		]);
		expect(f.controllers[0]?.calls[0]?.timeoutMs).toBe(12_000);
		expect(f.progress).toEqual([
			"Computer operation started",
			"Computer operation completed",
			"Computer inspection started",
			"Computer inspection completed",
		]);
		await expect(f.call("computer.evaluate", { code: "" })).rejects.toThrow("nonempty");
		await expect(f.call("computer.evaluate", { code: "1", timeout: 0 })).rejects.toThrow("positive");
		await expect(f.call("computer.evaluate", { code: "1", unknown: true })).rejects.toThrow("unknown field");
	});

	test("keeps rich output and oversized values as cell artifacts", async () => {
		const f = await fixture();
		await f.call("computer.capabilities");
		f.controllers[0]!.large = true;
		const result = await f.call("computer.evaluate", { code: "display(await desktop.screenshot())" });
		expect((result.text as string).length).toBe(200_000);
		const textArtifact = result.text_artifact as { path: string; bytes: number };
		expect(textArtifact.bytes).toBe(210_000);
		expect((await fs.stat(textArtifact.path)).size).toBe(210_000);
		const image = (result.images as Array<{ artifact: { path: string; bytes: number }; rich: boolean }>)[0]!;
		expect(image.rich).toBe(false);
		expect(image.artifact.bytes).toBe(270_000);
		expect((await fs.stat(image.artifact.path)).size).toBe(270_000);
	});

	test("forwards active request identity, cancellation, and busy guards", async () => {
		const f = await fixture();
		await f.call("computer.capabilities");
		f.controllers[0]!.gate = new Promise(() => {});
		const activeRequest = new AbortController();
		const first = f.call("computer.evaluate", { code: "await desktop.click({x: 1, y: 2})" }, activeRequest.signal, {
			sessionId: "active-cell-session",
			cwd: "/active/cell/project",
		});
		await f.controllers[0]!.started.promise;
		f.controllers[0]!.gate = new Promise(() => {});
		expect(f.controllers[0]?.calls[0]).toMatchObject({
			snapshot: {
				sessionId: "active-cell-session",
				cwd: "/active/cell/project",
				readOnly: false,
			},
			signal: activeRequest.signal,
		});
		await expect(f.call("computer.evaluate", { code: "2" })).rejects.toThrow("busy");
		await expect(f.call("computer.release")).rejects.toThrow("busy");
		const cancelled = new AbortController();
		cancelled.abort(new Error("cell cancelled"));
		await expect(f.call("computer.evaluate", { code: "1" }, cancelled.signal)).rejects.toThrow("cell cancelled");
		activeRequest.abort(new Error("active cell cancelled"));
		await expect(first).rejects.toThrow("active cell cancelled");
	});

	test("blocks fresh controller admission while suspension closes the current controller", async () => {
		const f = await fixture();
		await f.call("computer.capabilities");
		const closeStarted = Promise.withResolvers<void>();
		const closeGate = Promise.withResolvers<void>();
		f.controllers[0]!.closeStarted = closeStarted.resolve;
		f.controllers[0]!.closeGate = closeGate.promise;

		const firstSuspend = f.service.suspend();
		const secondSuspend = f.service.suspend();
		expect(secondSuspend).toBe(firstSuspend);
		await closeStarted.promise;
		await expect(f.call("computer.capabilities")).rejects.toThrow("suspending");
		await expect(f.call("computer.evaluate", { code: "1" })).rejects.toThrow("suspending");
		expect(f.controllers).toHaveLength(1);

		closeGate.resolve();
		await firstSuspend;
		await f.call("computer.capabilities");
		expect(f.controllers).toHaveLength(2);
	});

	test("releases and restarts the controller, with idempotent disposal", async () => {
		const f = await fixture();
		await f.call("computer.capabilities");
		await f.call("computer.release");
		expect(f.controllers[0]?.closeCalls).toBe(1);
		await expect(f.call("computer.release", { unknown: true })).rejects.toThrow("unknown field");
		await f.call("computer.capabilities");
		expect(f.controllers).toHaveLength(2);
		await f.call("computer.release");
		expect(f.controllers[1]?.closeCalls).toBe(1);
		await Promise.all([f.service.dispose(), f.service.dispose()]);
		expect(f.controllers[1]?.closeCalls).toBe(1);
	});
});

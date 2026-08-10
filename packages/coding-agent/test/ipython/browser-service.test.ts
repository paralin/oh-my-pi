import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpythonBrowserOwner, IpythonBrowserService } from "../../src/ipython/browser-service.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import type { BrowserParams } from "../../src/tools/browser.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeBrowserOwner implements IpythonBrowserOwner {
	readonly opens: Array<{ name: string; params: BrowserParams; timeoutMs: number; signal: AbortSignal }> = [];
	readonly runs: Array<{ name: string; code: string; timeoutMs: number; signal: AbortSignal }> = [];
	readonly closes: Array<{ name: string; kill: boolean; timeoutMs: number }> = [];
	readonly infoByName = new Map<string, { browser: string; url: string; title?: string }>();
	readonly closeErrors = new Map<string, Error>();
	openBarrier?: Promise<void>;
	openStarted?: () => void;
	ignoreOpenAbort = false;
	large = false;

	async open(name: string, params: BrowserParams, timeoutMs: number, signal: AbortSignal) {
		this.opens.push({ name, params, timeoutMs, signal });
		this.openStarted?.();
		if (this.openBarrier) {
			await (this.ignoreOpenAbort
				? this.openBarrier
				: Promise.race([
						this.openBarrier,
						new Promise<never>((_, reject) =>
							signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
						),
					]));
		}
		const created = !this.infoByName.has(name);
		const info = { browser: "headless", url: params.url || "about:blank", title: "Page" };
		this.infoByName.set(name, info);
		return { created, ...info };
	}

	async run(name: string, code: string, timeoutMs: number, signal: AbortSignal) {
		this.runs.push({ name, code, timeoutMs, signal });
		return {
			displays: this.large
				? [
						{ type: "text" as const, text: "x".repeat(210_000) },
						{ type: "image" as const, data: Buffer.alloc(270_000, 2).toString("base64"), mimeType: "image/png" },
					]
				: [
						{ type: "text" as const, text: "browser text" },
						{ type: "image" as const, data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
					],
			returnValue: { ok: true },
			screenshots: [{ dest: "/tmp/browser.png", mimeType: "image/png", bytes: 3, width: 100, height: 80 }],
		};
	}

	async close(name: string, options: { kill: boolean; timeoutMs: number }) {
		this.closes.push({ name, ...options });
		const error = this.closeErrors.get(name);
		if (error) throw error;
		return this.infoByName.delete(name);
	}

	async info(name: string) {
		return this.infoByName.get(name);
	}
}

async function fixture(sessionId = "session-1") {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-browser-"));
	roots.push(root);
	const owner = new FakeBrowserOwner();
	const service = new IpythonBrowserService({
		owner,
		timeoutMs: async value => (value ?? 30) * 1_000,
		sessionId: () => sessionId,
	});
	const progress: string[] = [];
	const displays: Array<Readonly<Record<string, unknown>>> = [];
	const call = async (
		operation: string,
		data: Record<string, unknown> = {},
		signal: AbortSignal = new AbortController().signal,
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
			sessionId,
			cwd: root,
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
	return { root, owner, service, progress, displays, call };
}

describe("IPython browser service", () => {
	test("opens and reuses session-private opaque tab handles", async () => {
		const f = await fixture();
		const first = await f.call("browser.open", {
			name: "docs",
			url: "https://example.test/docs",
			viewport: { width: 1200, height: 800, scale: 2 },
			wait_until: "domcontentloaded",
			timeout: 12,
		});
		expect(first).toMatchObject({ name: "docs", created: true, browser: "headless" });
		const handle = first.handle as string;
		expect(handle).toStartWith("browser-");
		const second = await f.call("browser.open", { name: "docs" });
		expect(second.handle).toBe(handle);
		expect(second.created).toBe(false);
		expect(f.owner.opens[0]?.name).toStartWith("session-1:browser-");
		expect(f.owner.opens[0]?.params.viewport).toEqual({ width: 1200, height: 800, scale: 2 });
		expect(f.owner.opens[0]?.params.app).toBeUndefined();
		expect(f.owner.opens[0]?.timeoutMs).toBe(12_000);
		expect(await f.call("browser.tabs")).toMatchObject({ items: [{ handle, name: "docs" }] });
		await expect(f.call("browser.open", { name: "docs", app: { unknown: true } })).rejects.toThrow("unknown field");
	});

	test("serializes concurrent opens of one logical tab", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		const barrier = Promise.withResolvers<void>();
		f.owner.openStarted = started.resolve;
		f.owner.openBarrier = barrier.promise;

		const first = f.call("browser.open", { name: "docs", url: "https://example.test/first" });
		await started.promise;
		const second = f.call("browser.open", { name: "docs", url: "https://example.test/second" });
		await Promise.resolve();
		expect(f.owner.opens).toHaveLength(1);

		barrier.resolve();
		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(secondResult.handle).toBe(firstResult.handle);
		expect(f.owner.opens).toHaveLength(2);
		expect(f.owner.opens[1]?.name).toBe(f.owner.opens[0]?.name);
		expect(await f.call("browser.tabs")).toMatchObject({
			items: [{ handle: firstResult.handle, name: "docs" }],
		});
	});

	test("cancels a queued same-name open without stalling its chain", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		const barrier = Promise.withResolvers<void>();
		f.owner.openStarted = started.resolve;
		f.owner.openBarrier = barrier.promise;

		const first = f.call("browser.open", { name: "docs" });
		await started.promise;
		const cancelled = new AbortController();
		const second = f.call("browser.open", { name: "docs" }, cancelled.signal);
		cancelled.abort(new Error("queued open cancelled"));
		await expect(second).rejects.toThrow("queued open cancelled");
		expect(f.owner.opens).toHaveLength(1);
		const third = f.call("browser.open", { name: "docs" });

		barrier.resolve();
		const [firstResult, thirdResult] = await Promise.all([first, third]);
		expect(thirdResult.handle).toBe(firstResult.handle);
		expect(f.owner.opens).toHaveLength(2);
	});

	test("suspension aborts an in-flight owner admission and permits a fresh open", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		f.owner.openStarted = started.resolve;
		f.owner.openBarrier = new Promise(() => {});

		const opening = f.call("browser.open", { name: "docs" });
		await started.promise;
		await f.service.suspend();
		await expect(opening).rejects.toThrow("suspending");
		expect(f.owner.opens[0]?.signal.aborted).toBe(true);
		expect(await f.call("browser.tabs")).toEqual({ items: [] });

		f.owner.openBarrier = undefined;
		const reopened = await f.call("browser.open", { name: "docs" });
		expect(reopened).toMatchObject({ name: "docs", created: true });
	});

	test("disposal drains an in-flight open before closing its admitted tab", async () => {
		const f = await fixture();
		const started = Promise.withResolvers<void>();
		const barrier = Promise.withResolvers<void>();
		f.owner.openStarted = started.resolve;
		f.owner.openBarrier = barrier.promise;
		f.owner.ignoreOpenAbort = true;

		const opening = f.call("browser.open", { name: "docs" });
		await started.promise;
		const disposing = f.service.dispose();
		barrier.resolve();

		await expect(opening).rejects.toThrow("disposed");
		await disposing;
		expect(f.owner.closes).toEqual([{ name: f.owner.opens[0]!.name, kill: true, timeoutMs: 5_000 }]);
		expect(await f.call("browser.tabs")).toEqual({ items: [] });
	});

	test("runs in admitted tabs and emits bounded rich output", async () => {
		const f = await fixture();
		const opened = await f.call("browser.open", { name: "docs" });
		const result = await f.call("browser.evaluate", {
			handle: opened.handle,
			code: "return await tab.observe()",
			timeout: 5,
		});
		expect(result).toMatchObject({
			name: "docs",
			text: expect.stringContaining("browser text"),
			images: [{ mime_type: "image/png", rich: true }],
		});
		expect(f.owner.runs[0]?.name).toBe(f.owner.opens[0]?.name);
		expect(f.owner.runs[0]?.timeoutMs).toBe(5_000);
		expect(f.displays).toEqual([{ "image/png": Buffer.from("png").toString("base64") }]);
		f.owner.large = true;
		const large = await f.call("browser.evaluate", {
			handle: opened.handle,
			code: "display(await tab.screenshot())",
		});
		expect((large.text as string).length).toBe(200_000);
		const textArtifact = large.artifact as { path: string; bytes: number };
		expect(textArtifact.bytes).toBeGreaterThan(210_000);
		expect((await fs.stat(textArtifact.path)).size).toBe(textArtifact.bytes);
		const image = (large.images as Array<{ artifact: { path: string; bytes: number }; rich: boolean }>)[0]!;
		expect(image.rich).toBe(false);
		expect(image.artifact.bytes).toBe(270_000);
	});

	test("removes absent tabs during close all and preserves thrown entries", async () => {
		const f = await fixture();
		await f.call("browser.open", { name: "one" });
		await f.call("browser.open", { name: "two" });
		const absentName = f.owner.opens[0]!.name;
		f.owner.infoByName.delete(absentName);
		expect(await f.call("browser.release", { all: true })).toEqual({ closed: 1 });
		expect(await f.call("browser.tabs")).toEqual({ items: [] });

		const retry = await f.call("browser.open", { name: "retry" });
		const retryName = f.owner.opens.at(-1)!.name;
		const failure = new Error("close failed");
		f.owner.closeErrors.set(retryName, failure);
		await expect(f.call("browser.release", { all: true })).rejects.toBe(failure);
		expect(await f.call("browser.tabs")).toMatchObject({ items: [{ handle: retry.handle, name: "retry" }] });
		f.owner.closeErrors.delete(retryName);
		expect(await f.call("browser.release", { all: true })).toEqual({ closed: 1 });
		expect(await f.call("browser.tabs")).toEqual({ items: [] });
	});

	test("forwards cancellation and closes only this session's tabs", async () => {
		const f = await fixture("root");
		const one = await f.call("browser.open", { name: "one" });
		await f.call("browser.open", { name: "two" });
		const cancelled = new AbortController();
		cancelled.abort(new Error("cell cancelled"));
		await expect(f.call("browser.evaluate", { handle: one.handle, code: "1" }, cancelled.signal)).rejects.toThrow(
			"cell cancelled",
		);
		await expect(f.call("browser.evaluate", { handle: "browser-missing", code: "1" })).rejects.toThrow(
			"unknown or closed",
		);
		expect(await f.call("browser.release", { all: true, kill: true, timeout: 3 })).toEqual({ closed: 2 });
		expect(f.owner.closes).toHaveLength(2);
		expect(f.owner.closes.every(call => call.kill && call.timeoutMs === 3_000)).toBe(true);
		await f.call("browser.open", { name: "three" });
		await f.service.suspend();
		expect(f.owner.closes.at(-1)?.kill).toBe(true);
		await f.call("browser.open", { name: "four" });
		await Promise.all([f.service.dispose(), f.service.dispose()]);
		expect(f.owner.closes.at(-1)?.kill).toBe(true);
		await expect(f.call("browser.open", { name: "five" })).rejects.toThrow("disposed");
	});
});

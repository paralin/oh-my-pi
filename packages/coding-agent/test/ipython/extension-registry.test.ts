import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type {
	IpythonExtensionHostHandler,
	IpythonExtensionHostRequest,
	IpythonMimeRenderer,
	RegisteredIpythonExtensionHostHandler,
	RegisteredIpythonMimeRenderer,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { IpythonExtensionRegistry } from "@oh-my-pi/pi-coding-agent/ipython/extension-registry";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const extensionPath = "extension-a";

function host(
	namespace: string,
	operation: string,
	handler: IpythonExtensionHostHandler = () => ({}),
	extension = extensionPath,
): RegisteredIpythonExtensionHostHandler {
	return { namespace, operation, handler, extensionPath: extension };
}

function renderer(
	mimeType: string,
	render: IpythonMimeRenderer = () => undefined,
	extension = extensionPath,
): RegisteredIpythonMimeRenderer {
	return { mimeType, renderer: render, extensionPath: extension };
}

function request(): IpythonExtensionHostRequest {
	return {
		data: { query: "needle" },
		requestId: "request-1",
		executionId: "execution-1",
		commId: "comm-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cell: { id: "cell-1", sequence: 7, origin: "model", authority: "trusted-cell" },
		signal: new AbortController().signal,
		publishProgress: async () => {},
		allocateArtifact: async artifact => ({ path: `/artifacts/result${artifact.suffix}` }),
	};
}

describe("IPython extension registry", () => {
	test("captures explicit extension host and MIME registrations", async () => {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			api => {
				api.registerIpythonHostHandler("search", "run", () => ({ matches: 1 }));
				api.registerIpythonMimeRenderer("application/vnd.example+json", () => undefined);
			},
			"/workspace",
			new EventBus(),
			runtime,
			extensionPath,
		);

		expect(extension.ipythonHostHandlers).toHaveLength(1);
		expect(extension.ipythonHostHandlers?.[0]).toMatchObject({ namespace: "search", operation: "run" });
		expect(extension.ipythonMimeRenderers).toHaveLength(1);
		expect(extension.ipythonMimeRenderers?.[0]?.mimeType).toBe("application/vnd.example+json");
	});

	test("rejects invalid, reserved, and duplicate operations before replacing the active snapshot", () => {
		const registry = new IpythonExtensionRegistry();
		registry.replace([host("search", "run")], []);
		const previous = registry.getHostHandler("extension.search.run");

		expect(() =>
			registry.replace([host("search", "run"), host("search", "run", () => ({}), "extension-b")], []),
		).toThrow("duplicate IPython extension operation: extension.search.run");
		expect(registry.getHostHandler("extension.search.run")).toBe(previous);
		expect(() => registry.replace([host("tool", "call")], [])).toThrow("reserved IPython extension namespace");
		expect(() => registry.replace([host("search", "tool.call")], [])).toThrow("invalid IPython extension operation");
		expect(() => registry.replace([host("Search", "run")], [])).toThrow("invalid IPython extension namespace");
	});

	test("confines host handler input to active request, cell, progress, and artifact capabilities", async () => {
		const registry = new IpythonExtensionRegistry();
		let keys: string[] = [];
		let cellFrozen = false;
		let dataFrozen = false;
		registry.replace(
			[
				host("search", "run", received => {
					keys = Object.keys(received).sort();
					cellFrozen = Object.isFrozen(received.cell);
					dataFrozen = Object.isFrozen(received.data);
					return { cwd: received.cwd, cellId: received.cell.id };
				}),
			],
			[],
		);
		const handler = registry.getHostHandler("extension.search.run");
		if (!handler) throw new Error("registered handler was unavailable");
		const supplied = Object.assign(request(), {
			channel: { send: async () => {} },
			credentials: { token: "must-not-reach-handler" },
			publishDisplay: async () => {},
		});

		expect(await handler(supplied)).toEqual({ cwd: "/workspace", cellId: "cell-1" });
		expect(keys).toEqual([
			"allocateArtifact",
			"cell",
			"commId",
			"cwd",
			"data",
			"executionId",
			"publishProgress",
			"requestId",
			"sessionId",
			"signal",
		]);
		expect(cellFrozen).toBe(true);
		expect(dataFrozen).toBe(true);
	});

	test("atomically replaces stale handlers and MIME renderers with undefined fallback lookup", () => {
		const registry = new IpythonExtensionRegistry();
		const firstRenderer: IpythonMimeRenderer = () => undefined;
		const secondRenderer: IpythonMimeRenderer = () => undefined;
		registry.replace([host("search", "run")], [renderer("application/json", firstRenderer)]);
		expect(registry.getHostHandler("extension.search.run")).toBeDefined();
		expect(registry.getMimeRenderer("application/json")).toBe(firstRenderer);
		expect(registry.getMimeRenderer("image/png")).toBeUndefined();

		registry.replace([host("files", "read")], [renderer("image/png", secondRenderer)]);
		expect(registry.getHostHandler("extension.search.run")).toBeUndefined();
		expect(registry.getHostHandler("extension.files.read")).toBeDefined();
		expect(registry.getMimeRenderer("application/json")).toBeUndefined();
		expect(registry.getMimeRenderer("image/png")).toBe(secondRenderer);
		expect(() => registry.replace([], [renderer("text/plain")])).toThrow("invalid IPython MIME renderer type");
		expect(registry.getMimeRenderer("image/png")).toBe(secondRenderer);
	});

	test("rejects new registrations after close and clears lookup on disposal", () => {
		const registry = new IpythonExtensionRegistry();
		registry.replace([host("search", "run")], [renderer("application/json")]);
		registry.rejectNew();
		expect(() => registry.replace([], [])).toThrow("rejects new registrations");
		expect(registry.getHostHandler("extension.search.run")).toBeDefined();
		registry.dispose();
		registry.dispose();
		expect(registry.getHostHandler("extension.search.run")).toBeUndefined();
		expect(registry.getMimeRenderer("application/json")).toBeUndefined();
		expect(() => registry.replace([], [])).toThrow("disposed");
	});
});

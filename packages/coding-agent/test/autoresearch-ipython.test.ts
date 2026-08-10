import { afterEach, describe, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAutoresearchExtension } from "../src/autoresearch";
import { closeAllAutoresearchStorages } from "../src/autoresearch/storage";
import type { ExtensionAPI, ExtensionContext, IpythonExtensionHostHandler } from "../src/extensibility/extensions";

type ExtensionEventHandler = (event: unknown, context: ExtensionContext) => void | Promise<void>;

afterEach(() => closeAllAutoresearchStorages());

describe("autoresearch IPython owners", () => {
	test("registers focused handlers that call the owner without a legacy tool execution", async () => {
		using temp = TempDir.createSync("@omp-autoresearch-ipython-");
		const handlers = new Map<string, IpythonExtensionHostHandler>();
		const events = new Map<string, ExtensionEventHandler>();
		const api = {
			appendEntry(): void {},
			exec: async () => ({ code: 0, stdout: "", stderr: "" }),
			on: (name: string, handler: ExtensionEventHandler) => events.set(name, handler),
			registerCommand(): void {},
			registerIpythonHostHandler: (namespace: string, operation: string, handler: IpythonExtensionHostHandler) =>
				handlers.set(`extension.${namespace}.${operation}`, handler),
			registerShortcut(): void {},
		} as unknown as ExtensionAPI;
		createAutoresearchExtension(api);
		const context = {
			cwd: temp.path(),
			hasUI: false,
			sessionManager: {
				getBranch: () => [],
				getEntries: () => [],
				getSessionId: () => "session-1",
			},
			ui: { setWidget(): void {} },
		} as unknown as ExtensionContext;
		await events.get("session_start")?.({}, context);
		const progress: string[] = [];
		const handler = handlers.get("extension.autoresearch.init");
		if (!handler) throw new Error("missing autoresearch init handler");
		const result = await handler({
			data: { name: "bench", primary_metric: "latency" },
			requestId: "request-1",
			executionId: "execution-1",
			commId: "comm-1",
			sessionId: "session-1",
			cwd: temp.path(),
			cell: { id: "cell-1", sequence: 1, origin: "model", authority: "trusted-cell" },
			signal: new AbortController().signal,
			publishProgress: async message => {
				progress.push(message);
			},
			allocateArtifact: async () => {
				throw new Error("autoresearch init does not allocate artifacts");
			},
		});
		expect(result.text).toContain("autoresearch.sh does not exist");
		expect(result.text_truncated).toBe(false);
		expect(progress).toEqual(["Autoresearch initialization started", "Autoresearch initialization completed"]);
		const logHandler = handlers.get("extension.autoresearch.log");
		if (!logHandler) throw new Error("missing autoresearch log handler");
		await expect(
			logHandler({
				data: { metric: 1, status: "keep", description: "x", asi: { payload: "x".repeat(65 * 1024) } },
				requestId: "request-log",
				executionId: "execution-log",
				commId: "comm-log",
				sessionId: "session-1",
				cwd: temp.path(),
				cell: { id: "cell-log", sequence: 2, origin: "model", authority: "trusted-cell" },
				signal: new AbortController().signal,
				publishProgress: async () => {},
				allocateArtifact: async () => {
					throw new Error("unused");
				},
			}),
		).rejects.toThrow("asi is too large");
		await expect(
			handler({
				data: { type: "extension.autoresearch.run", name: "bench", primary_metric: "latency" },
				requestId: "request-2",
				executionId: "execution-2",
				commId: "comm-2",
				sessionId: "session-1",
				cwd: temp.path(),
				cell: { id: "cell-2", sequence: 2, origin: "model", authority: "trusted-cell" },
				signal: new AbortController().signal,
				publishProgress: async () => {},
				allocateArtifact: async () => {
					throw new Error("unused");
				},
			}),
		).rejects.toThrow("unknown field: type");
	});
});

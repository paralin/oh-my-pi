import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, test } from "bun:test";
import type {
	ExtensionAPI,
	IpythonExtensionHostHandler,
	IpythonExtensionHostRequest,
} from "@oh-my-pi/pi-coding-agent";

import robompExtension from "../src/agent_runtime/extension.ts";

const OPERATIONS = [
	"abort_task",
	"classify_issue",
	"classify_pr",
	"fetch_issue_thread",
	"fetch_pr",
	"gh_open_pr",
	"gh_post_comment",
	"gh_push_branch",
	"gh_request_review",
	"gh_search_issues",
	"mark_unable_to_reproduce",
	"pr_review_comment",
	"repro_record",
	"search_commits",
	"set_issue_labels",
	"submit_pr_review",
];

afterEach(() => {
	delete process.env.ROBOMP_HOST_SOCKET;
});

function loadHandlers(): Map<string, IpythonExtensionHostHandler> {
	const handlers = new Map<string, IpythonExtensionHostHandler>();
	const api = {
		registerIpythonHostHandler(namespace: string, operation: string, handler: IpythonExtensionHostHandler) {
			handlers.set(`${namespace}.${operation}`, handler);
		},
	} as ExtensionAPI;
	robompExtension(api);
	return handlers;
}

function request(data: Record<string, unknown>, signal = new AbortController().signal): IpythonExtensionHostRequest {
	return {
		data,
		requestId: "request-1",
		executionId: "execution-1",
		commId: "comm-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cell: { id: "cell-1", sequence: 1, origin: "model", authority: "trusted-cell" },
		signal,
		publishProgress: async () => {},
		allocateArtifact: async () => {
			throw new Error("not available");
		},
	};
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
}

async function close(server: net.Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

test("registers the exact Robomp operations and forwards one bounded request", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "robomp-ext-"));
	const socketPath = path.join(directory, "host.sock");
	let received = "";
	const server = net.createServer({ allowHalfOpen: true }, socket => {
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			received += chunk;
			if (received.endsWith("\n")) socket.write('{"ok":true,"result":{"comment_id":42}}\n');
		});
	});
	await listen(server, socketPath);
	process.env.ROBOMP_HOST_SOCKET = socketPath;
	try {
		const handlers = loadHandlers();
		expect([...handlers.keys()]).toEqual(OPERATIONS.map(operation => `robomp.${operation}`));
		const result = await handlers.get("robomp.gh_post_comment")?.(request({ body: "ready" }));
		expect(result).toEqual({ result: { comment_id: 42 } });
		expect(JSON.parse(received)).toEqual({
			version: 1,
			operation: "gh_post_comment",
			arguments: { body: "ready" },
		});
	} finally {
		await close(server);
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("rejects an already aborted request without opening the socket", async () => {
	process.env.ROBOMP_HOST_SOCKET = "/does/not/exist.sock";
	const controller = new AbortController();
	controller.abort();
	const handler = loadHandlers().get("robomp.fetch_pr");
	await expect(handler?.(request({}, controller.signal))).rejects.toThrow("fetch_pr was aborted");
});

test("closes an in-flight bridge connection when the cell aborts", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "robomp-ext-abort-"));
	const socketPath = path.join(directory, "host.sock");
	const connected = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const server = net.createServer(socket => {
		connected.resolve();
		socket.on("close", () => disconnected.resolve());
	});
	await listen(server, socketPath);
	process.env.ROBOMP_HOST_SOCKET = socketPath;
	const controller = new AbortController();
	try {
		const handler = loadHandlers().get("robomp.fetch_pr");
		const pending = handler?.(request({}, controller.signal));
		await connected.promise;
		controller.abort();
		await expect(pending).rejects.toThrow("fetch_pr was aborted");
		await disconnected.promise;
	} finally {
		await close(server);
		await fs.rm(directory, { recursive: true, force: true });
	}
});


test("rejects response fields outside the closed response schema", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "robomp-ext-invalid-"));
	const socketPath = path.join(directory, "host.sock");
	const server = net.createServer({ allowHalfOpen: true }, socket => {
		socket.on("data", () => socket.write('{"ok":true,"result":null,"extra":true}\n'));
	});
	await listen(server, socketPath);
	process.env.ROBOMP_HOST_SOCKET = socketPath;
	try {
		const handler = loadHandlers().get("robomp.fetch_pr");
		await expect(handler?.(request({}))).rejects.toThrow("invalid success response");
	} finally {
		await close(server);
		await fs.rm(directory, { recursive: true, force: true });
	}
});

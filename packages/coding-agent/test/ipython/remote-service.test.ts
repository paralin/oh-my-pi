import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SSHHost } from "../../src/capability/ssh.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { type IpythonRemoteOwner, IpythonRemoteService } from "../../src/ipython/remote-service.js";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeRemoteOwner implements IpythonRemoteOwner {
	readonly calls: Array<{ operation: string; args: unknown[] }> = [];
	largeOutput = false;

	async ensure(target: SSHConnectionTarget) {
		this.calls.push({ operation: "ensure", args: [target] });
		return {
			version: 4,
			os: "linux" as const,
			shell: "bash" as const,
			transferShell: "sh" as const,
			compatEnabled: false,
		};
	}
	async status(target: SSHConnectionTarget) {
		this.calls.push({ operation: "status", args: [target] });
		return { version: 4, os: "linux" as const, shell: "bash" as const, compatEnabled: false };
	}
	async exec(target: SSHConnectionTarget, command: string, signal: AbortSignal, timeoutMs: number) {
		this.calls.push({ operation: "exec", args: [target, command, signal, timeoutMs] });
		return {
			stdout: new TextEncoder().encode(this.largeOutput ? "x".repeat(210_000) : "remote output\n"),
			stderr: "",
		};
	}
	async readFile(target: SSHConnectionTarget, remotePath: string, options: unknown) {
		this.calls.push({ operation: "readFile", args: [target, remotePath, options] });
		return { bytes: new TextEncoder().encode("remote file\n"), truncated: false };
	}
	async writeFile(target: SSHConnectionTarget, remotePath: string, content: Uint8Array, options: unknown) {
		this.calls.push({ operation: "writeFile", args: [target, remotePath, content, options] });
	}
	async listDir(target: SSHConnectionTarget, remotePath: string, options: unknown) {
		this.calls.push({ operation: "listDir", args: [target, remotePath, options] });
		return [
			{ name: "dir", isDirectory: true },
			{ name: "file.txt", isDirectory: false },
		];
	}
	async stat(target: SSHConnectionTarget, remotePath: string, options: unknown) {
		this.calls.push({ operation: "stat", args: [target, remotePath, options] });
		return "file" as const;
	}
	async close(name: string) {
		this.calls.push({ operation: "close", args: [name] });
	}
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-remote-"));
	roots.push(root);
	const owner = new FakeRemoteOwner();
	const hosts: SSHHost[] = [
		{
			name: "build",
			host: "build.internal",
			username: "builder",
			port: 2222,
			keyPath: "/host/private/key",
			description: "Build host",
			_source: { provider: "test", providerName: "Test", path: "/ssh.json", level: "project" },
		},
	];
	const progress: string[] = [];
	const service = new IpythonRemoteService({ cwd: () => root, loadHosts: async () => hosts, owner });
	const call = async (
		operation: string,
		data: Record<string, unknown>,
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
			sessionId: "session-1",
			cwd: root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async message => {
				progress.push(message);
			},
			publishDisplay: async () => {},
			allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { root, owner, progress, call };
}

describe("IPython remote service", () => {
	test("resolves configured hosts without returning SSH key material", async () => {
		const f = await fixture();
		expect(await f.call("remote.hosts", {})).toEqual({
			items: [
				{
					name: "build",
					host: "build.internal",
					username: "builder",
					port: 2222,
					description: "Build host",
					compat: false,
				},
			],
		});
		expect(await f.call("remote.ensure", { host: "build" })).toMatchObject({ host: "build", os: "linux" });
		expect(await f.call("remote.status", { host: "build" })).toMatchObject({ host: "build", connected: true });
		const target = f.owner.calls.find(call => call.operation === "ensure")?.args[0] as SSHConnectionTarget;
		expect(target).toMatchObject({ host: "build.internal", username: "builder", port: 2222 });
		expect(target.keyPath).toBe("/host/private/key");
		expect(f.progress).toEqual(["SSH connection started", "SSH connection ready"]);
	});

	test("executes bounded commands and transfers files through explicit owners", async () => {
		const f = await fixture();
		expect(await f.call("remote.exec", { host: "build", command: "uname -a", timeout: 12 })).toMatchObject({
			stdout: "remote output\n",
			exit_code: 0,
		});
		expect(await f.call("remote.read_file", { host: "build", path: "/tmp/a", max_bytes: 100 })).toMatchObject({
			content: "remote file\n",
			bytes: 12,
		});
		await f.call("remote.write_file", {
			host: "build",
			path: "/tmp/a",
			content: Buffer.from([0, 1, 2]).toString("base64"),
			encoding: "base64",
		});
		const write = f.owner.calls.find(call => call.operation === "writeFile");
		expect(Array.from(write?.args[2] as Uint8Array)).toEqual([0, 1, 2]);
		expect(await f.call("remote.list_dir", { host: "build", path: "/tmp", limit: 1 })).toMatchObject({
			items: [{ name: "dir", is_directory: true }],
			total: 2,
			truncated: true,
		});
		expect(await f.call("remote.stat", { host: "build", path: "/tmp/a" })).toMatchObject({ kind: "file" });
		expect(await f.call("remote.close", { host: "build" })).toEqual({ host: "build", closed: true });
	});

	test("forwards cancellation, rejects unsafe inputs, and spills large command output", async () => {
		const f = await fixture();
		const cancelled = new AbortController();
		cancelled.abort(new Error("cell cancelled"));
		await expect(f.call("remote.exec", { host: "build", command: "true" }, cancelled.signal)).rejects.toThrow(
			"cell cancelled",
		);
		await expect(f.call("remote.exec", { host: "bad\nhost", command: "true" })).rejects.toThrow("invalid character");
		await expect(f.call("remote.read_file", { host: "build", path: "relative" })).rejects.toThrow("absolute");
		await expect(f.call("remote.stat", { host: "build", path: "/tmp", raw: true })).rejects.toThrow("unknown field");
		f.owner.largeOutput = true;
		const spilled = await f.call("remote.exec", { host: "build", command: "large" });
		expect(spilled.truncated).toBe(true);
		const artifact = spilled.artifact as { path: string; bytes: number; mime_type: string };
		expect(artifact.mime_type).toBe("text/plain");
		expect(artifact.bytes).toBe(210_000);
		expect((await fs.stat(artifact.path)).size).toBe(210_000);
	});
});

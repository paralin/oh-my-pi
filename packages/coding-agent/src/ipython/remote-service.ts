import * as fs from "node:fs/promises";
import { ptree } from "@oh-my-pi/pi-utils";
import * as capability from "../capability";
import { type SSHHost, sshCapability } from "../capability/ssh";
import {
	buildRemoteCommand,
	closeConnection,
	ensureConnection,
	ensureHostInfo,
	getHostInfoForHost,
	type SSHConnectionTarget,
	type SSHHostInfo,
} from "../ssh/connection-manager";
import { listRemoteDir, readRemoteFile, statRemotePath, writeRemoteFile } from "../ssh/file-transfer";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_HOST_CHARS = 512;
const MAX_COMMAND_CHARS = 64_000;
const MAX_REMOTE_PATH_CHARS = 8_192;
const MAX_TRANSFER_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;
const MAX_INLINE_OUTPUT_CHARS = 200_000;
const MAX_LIST_ENTRIES = 10_000;

export interface IpythonRemoteOwner {
	ensure(target: SSHConnectionTarget): Promise<SSHHostInfo>;
	status(target: SSHConnectionTarget): Promise<SSHHostInfo | undefined>;
	exec(
		target: SSHConnectionTarget,
		command: string,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<{ stdout: Uint8Array; stderr: string }>;
	readFile(
		target: SSHConnectionTarget,
		path: string,
		options: { maxBytes: number; signal: AbortSignal; timeoutMs: number },
	): ReturnType<typeof readRemoteFile>;
	writeFile(
		target: SSHConnectionTarget,
		path: string,
		content: Uint8Array,
		options: { signal: AbortSignal; timeoutMs: number },
	): Promise<void>;
	listDir(
		target: SSHConnectionTarget,
		path: string,
		options: { signal: AbortSignal; timeoutMs: number },
	): ReturnType<typeof listRemoteDir>;
	stat(
		target: SSHConnectionTarget,
		path: string,
		options: { signal: AbortSignal; timeoutMs: number },
	): ReturnType<typeof statRemotePath>;
	close(name: string): Promise<void>;
}

export interface IpythonRemoteServiceOptions {
	readonly cwd: () => string;
	readonly loadHosts?: (cwd: string) => Promise<readonly SSHHost[]>;
	readonly owner?: IpythonRemoteOwner;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string {
	const value = data[name];
	if (value === undefined && options.optional) return "";
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? 16_384)) throw new RangeError(`${name} is too large`);
	return value;
}

function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	fallback: number,
	min: number,
	max: number,
) {
	const value = data[name] ?? fallback;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function safeHostName(data: Readonly<Record<string, unknown>>): string {
	const host = stringValue(data, "host", { max: MAX_HOST_CHARS });
	if (/[\0\r\n]/.test(host)) throw new TypeError("host contains an invalid character");
	return host;
}

function safeRemotePath(data: Readonly<Record<string, unknown>>): string {
	const remotePath = stringValue(data, "path", { max: MAX_REMOTE_PATH_CHARS });
	if (remotePath.includes("\0")) throw new TypeError("path contains an invalid character");
	if (!remotePath.startsWith("/")) throw new TypeError("path must be absolute");
	return remotePath;
}

function publicHost(host: SSHHost): Readonly<Record<string, unknown>> {
	return {
		name: host.name,
		host: host.host,
		username: host.username ?? null,
		port: host.port ?? null,
		description: host.description ?? null,
		compat: host.compat ?? false,
	};
}

async function readBoundedStdout(
	child: ReturnType<typeof ptree.spawn>,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = child.stdout.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const previous = total;
			total += value.byteLength;
			if (total > maxBytes) {
				const remaining = Math.max(0, maxBytes - previous);
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				child.kill();
				await child.exited.catch(() => undefined);
				return { bytes: concatBytes(chunks, maxBytes), truncated: true };
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return { bytes: concatBytes(chunks, total), truncated: false };
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
	const output = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		const visible = chunk.subarray(0, Math.max(0, length - offset));
		output.set(visible, offset);
		offset += visible.length;
		if (offset >= length) break;
	}
	return output;
}

async function executeRemoteCommand(
	target: SSHConnectionTarget,
	command: string,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<{ stdout: Uint8Array; stderr: string }> {
	await ensureConnection(target);
	const args = await buildRemoteCommand(target, command);
	using child = ptree.spawn(["ssh", ...args], { signal: ptree.combineSignals(signal, timeoutMs) });
	const output = await readBoundedStdout(child, MAX_EXEC_OUTPUT_BYTES);
	if (output.truncated) throw new RangeError(`remote command output exceeds ${MAX_EXEC_OUTPUT_BYTES} bytes`);
	await child.exitedCleanly;
	return { stdout: output.bytes, stderr: child.peekStderr() };
}

function defaultRemoteOwner(): IpythonRemoteOwner {
	return {
		ensure: async target => {
			await ensureConnection(target);
			return await ensureHostInfo(target);
		},
		status: getHostInfoForHost,
		exec: executeRemoteCommand,
		readFile: readRemoteFile,
		writeFile: writeRemoteFile,
		listDir: listRemoteDir,
		stat: statRemotePath,
		close: closeConnection,
	};
}

/** Exposes configured SSH owners without sending credentials or transport state into Python. */
export class IpythonRemoteService {
	readonly handlers: IpythonHostHandlers;
	readonly #loadHosts: (cwd: string) => Promise<readonly SSHHost[]>;
	readonly #owner: IpythonRemoteOwner;

	constructor(private readonly options: IpythonRemoteServiceOptions) {
		this.#owner = options.owner ?? defaultRemoteOwner();
		this.#loadHosts =
			options.loadHosts ??
			(async cwd => {
				const { items } = await capability.loadCapability<SSHHost>(sshCapability.id, { cwd });
				return items;
			});
		this.handlers = {
			"remote.hosts": request => this.#hosts(request),
			"remote.ensure": request => this.#ensure(request),
			"remote.status": request => this.#status(request),
			"remote.exec": request => this.#exec(request),
			"remote.read_file": request => this.#readFile(request),
			"remote.write_file": request => this.#writeFile(request),
			"remote.list_dir": request => this.#listDir(request),
			"remote.stat": request => this.#stat(request),
			"remote.close": request => this.#close(request),
		};
	}

	async #target(data: Readonly<Record<string, unknown>>): Promise<SSHConnectionTarget> {
		const name = safeHostName(data);
		const hosts = await this.#loadHosts(this.options.cwd());
		const configured = hosts.find(host => host.name === name);
		if (configured) {
			return {
				name: configured.name,
				host: configured.host,
				username: configured.username,
				port: configured.port,
				keyPath: configured.keyPath,
				compat: configured.compat,
			};
		}
		return { name, host: name };
	}

	async #hosts(request: IpythonHostRequest) {
		strict(request.data, []);
		request.signal.throwIfAborted();
		const hosts = await this.#loadHosts(this.options.cwd());
		request.signal.throwIfAborted();
		return { items: hosts.map(publicHost) };
	}

	async #ensure(request: IpythonHostRequest) {
		strict(request.data, ["host"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		await request.publishProgress("SSH connection started", { host: target.name });
		const info = await this.#owner.ensure(target);
		request.signal.throwIfAborted();
		await request.publishProgress("SSH connection ready", { host: target.name });
		return { host: target.name, ...info };
	}

	async #status(request: IpythonHostRequest) {
		strict(request.data, ["host"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const info = await this.#owner.status(target);
		return { host: target.name, connected: info !== undefined, info: info ?? null };
	}

	async #exec(request: IpythonHostRequest) {
		strict(request.data, ["host", "command", "timeout"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const command = stringValue(request.data, "command", { max: MAX_COMMAND_CHARS });
		const timeoutMs = integerValue(request.data, "timeout", 30, 1, 300) * 1_000;
		await request.publishProgress("Remote command started", { host: target.name });
		const output = await this.#owner.exec(target, command, request.signal, timeoutMs);
		request.signal.throwIfAborted();
		const stdout = new TextDecoder().decode(output.stdout);
		const stderr = output.stderr;
		await request.publishProgress("Remote command completed", { host: target.name });
		if (stdout.length <= MAX_INLINE_OUTPUT_CHARS && stderr.length <= MAX_INLINE_OUTPUT_CHARS) {
			return { host: target.name, stdout, stderr, exit_code: 0 };
		}
		const artifact = await request.allocateArtifact({ label: "remote-exec", mimeType: "text/plain", suffix: ".txt" });
		const complete = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
		await fs.writeFile(artifact.path, complete, "utf8");
		return {
			host: target.name,
			stdout: stdout.slice(0, MAX_INLINE_OUTPUT_CHARS),
			stderr: stderr.slice(-MAX_INLINE_OUTPUT_CHARS),
			exit_code: 0,
			truncated: true,
			artifact: { ...artifact, bytes: Buffer.byteLength(complete), mime_type: "text/plain" },
		};
	}

	async #readFile(request: IpythonHostRequest) {
		strict(request.data, ["host", "path", "max_bytes", "timeout"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const remotePath = safeRemotePath(request.data);
		const maxBytes = integerValue(request.data, "max_bytes", MAX_TRANSFER_BYTES, 1, MAX_TRANSFER_BYTES);
		const timeoutMs = integerValue(request.data, "timeout", 30, 1, 300) * 1_000;
		const result = await this.#owner.readFile(target, remotePath, { maxBytes, signal: request.signal, timeoutMs });
		const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
		return {
			host: target.name,
			path: remotePath,
			content: text,
			bytes: result.bytes.length,
			truncated: result.truncated,
		};
	}

	async #writeFile(request: IpythonHostRequest) {
		strict(request.data, ["host", "path", "content", "encoding", "timeout"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const remotePath = safeRemotePath(request.data);
		const encoding = stringValue(request.data, "encoding", { optional: true, max: 16 }) || "utf-8";
		const content = stringValue(request.data, "content", { optional: true, max: 2 * MAX_TRANSFER_BYTES });
		let bytes: Uint8Array;
		if (encoding === "utf-8") bytes = new TextEncoder().encode(content);
		else if (encoding === "base64") bytes = Uint8Array.from(Buffer.from(content, "base64"));
		else throw new RangeError("encoding must be utf-8 or base64");
		if (bytes.length > MAX_TRANSFER_BYTES) throw new RangeError(`content exceeds ${MAX_TRANSFER_BYTES} bytes`);
		const timeoutMs = integerValue(request.data, "timeout", 30, 1, 300) * 1_000;
		await this.#owner.writeFile(target, remotePath, bytes, { signal: request.signal, timeoutMs });
		request.signal.throwIfAborted();
		return { host: target.name, path: remotePath, bytes: bytes.length, written: true };
	}

	async #listDir(request: IpythonHostRequest) {
		strict(request.data, ["host", "path", "offset", "limit", "timeout"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const remotePath = safeRemotePath(request.data);
		const offset = integerValue(request.data, "offset", 0, 0, MAX_LIST_ENTRIES);
		const limit = integerValue(request.data, "limit", 200, 1, 1_000);
		const timeoutMs = integerValue(request.data, "timeout", 30, 1, 300) * 1_000;
		const entries = await this.#owner.listDir(target, remotePath, { signal: request.signal, timeoutMs });
		if (entries.length > MAX_LIST_ENTRIES)
			throw new RangeError(`remote directory exceeds ${MAX_LIST_ENTRIES} entries`);
		return {
			host: target.name,
			path: remotePath,
			items: entries
				.slice(offset, offset + limit)
				.map(entry => ({ name: entry.name, is_directory: entry.isDirectory })),
			offset,
			total: entries.length,
			truncated: offset + limit < entries.length,
		};
	}

	async #stat(request: IpythonHostRequest) {
		strict(request.data, ["host", "path", "timeout"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		const remotePath = safeRemotePath(request.data);
		const timeoutMs = integerValue(request.data, "timeout", 30, 1, 300) * 1_000;
		const kind = await this.#owner.stat(target, remotePath, { signal: request.signal, timeoutMs });
		return { host: target.name, path: remotePath, kind };
	}

	async #close(request: IpythonHostRequest) {
		strict(request.data, ["host"]);
		request.signal.throwIfAborted();
		const target = await this.#target(request.data);
		await this.#owner.close(target.name);
		return { host: target.name, closed: true };
	}
}

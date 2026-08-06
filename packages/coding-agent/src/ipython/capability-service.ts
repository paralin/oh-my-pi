import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	Filesystem,
	type InMemorySnapshotStore,
	NotFoundError,
	Patch,
	Patcher,
	type WriteResult,
} from "@oh-my-pi/hashline";
import { GrepOutputMode, grep } from "@oh-my-pi/pi-natives";
import { withFileLock } from "@oh-my-pi/pi-utils";
import { generateDiffString } from "../edit/diff";
import { canonicalSnapshotKey, getFileSnapshotStore, recordFileSnapshot } from "../edit/file-snapshot-store";
import { callTool, listTools } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import type { MCPServerConfig } from "../mcp/types";
import type { IpythonDisplayEvent, IpythonHostHandlers, IpythonHostRequest } from "./controller";
import type { HarnessKind, HarnessScope, HarnessService } from "./harness-service";
import { composeIpythonHostHandlers } from "./host-bridge";

const MAX_SEARCH_PATHS = 20;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_LINE_CHARS = 2_000;
const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_VALUE_CHARS = 1024 * 1024;
const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_MCP_JSON_BYTES = 1024 * 1024;
const DIFF_DISPLAY_MIME = "application/vnd.omp.diff+json";
const ATTACHMENT_DISPLAY_MIME = "application/vnd.omp.attachment+json";

export interface IpythonMcpOwner {
	getAllServerNames(): string[];
	getConnectedServers(): string[];
	getServerConfig(name: string): MCPServerConfig | undefined;
	listTools(name: string, signal: AbortSignal, refresh?: boolean): Promise<unknown>;
	callTool(name: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	getServerResources(name: string): unknown;
	readServerResource(name: string, uri: string, options?: { signal?: AbortSignal }): Promise<unknown>;
	getServerPrompts(name: string): unknown;
	executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: { signal?: AbortSignal },
	): Promise<unknown>;
	refreshCredentials(name: string): Promise<boolean>;
	refreshServerResources(name: string): Promise<void>;
	refreshServerPrompts(name: string): Promise<void>;
}

/** Adapts OMP's MCP manager without exposing its AgentTool wrappers. */
export function createIpythonMcpOwner(manager: MCPManager): IpythonMcpOwner {
	return {
		getAllServerNames: () => manager.getAllServerNames(),
		getConnectedServers: () => manager.getConnectedServers(),
		getServerConfig: name => manager.getServerConfig(name),
		listTools: async (name, signal, refresh) => {
			const connection = manager.getConnection(name);
			if (!connection) throw new Error(`MCP server is not connected: ${name}`);
			if (refresh) connection.tools = undefined;
			return await listTools(connection, { signal });
		},
		callTool: async (name, tool, args, signal) => {
			const connection = manager.getConnection(name);
			if (!connection) throw new Error(`MCP server is not connected: ${name}`);
			return await callTool(connection, tool, args, { signal });
		},
		getServerResources: name => manager.getServerResources(name),
		readServerResource: (name, uri, options) => manager.readServerResource(name, uri, options),
		getServerPrompts: name => manager.getServerPrompts(name),
		executePrompt: (name, promptName, args, options) => manager.executePrompt(name, promptName, args, options),
		refreshCredentials: async name => {
			const config = manager.getServerConfig(name);
			if (!config) return false;
			await manager.prepareConfig(config);
			return true;
		},
		refreshServerResources: name => manager.refreshServerResources(name),
		refreshServerPrompts: name => manager.refreshServerPrompts(name),
	};
}

export interface IpythonCapabilityServiceOptions {
	readonly cwd: string;
	readonly snapshotOwner: { fileSnapshotStore?: InMemorySnapshotStore };
	readonly harness: HarnessService;
	readonly modelInfo: () => Readonly<Record<string, unknown>>;
	readonly mcp?: IpythonMcpOwner;
	readonly refreshSystemPrompt?: () => Promise<void>;
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
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
): number {
	const value = data[name] ?? fallback;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

async function canonicalWorkspacePath(cwd: string, input: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const resolved = await fs.realpath(path.resolve(cwd, input));
	const relative = path.relative(root, resolved);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
	throw new RangeError(`path is outside the active workspace: ${input}`);
}

function safeRelative(cwd: string, absolute: string): string {
	const relative = path.relative(cwd, absolute).replaceAll("\\", "/");
	return relative || ".";
}

function richDisplay(mime: string, payload: Readonly<Record<string, unknown>>, text: string): IpythonDisplayEvent {
	return {
		kind: "display",
		data: { [mime]: payload, "text/plain": text },
		metadata: {},
		transient: {},
		update: false,
		text,
	};
}

async function searchWorkspace(
	cwd: string,
	snapshotOwner: { fileSnapshotStore?: InMemorySnapshotStore },
	request: IpythonHostRequest,
): Promise<Record<string, unknown>> {
	const root = await fs.realpath(cwd);
	const data = request.data;
	strict(data, ["query", "paths", "limit", "case_sensitive", "gitignore"]);
	const query = stringValue(data, "query", { max: 4_096 });
	const limit = integerValue(data, "limit", 100, 1, MAX_SEARCH_MATCHES);
	const caseSensitive = booleanValue(data, "case_sensitive", true);
	const useGitignore = booleanValue(data, "gitignore", true);
	const rawPaths = data.paths ?? ["."];
	if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_SEARCH_PATHS) {
		throw new RangeError(`paths must contain 1 through ${MAX_SEARCH_PATHS} strings`);
	}
	const paths: string[] = [];
	for (const value of rawPaths) {
		if (typeof value !== "string" || !value || value.length > 4_096)
			throw new TypeError("paths must contain strings");
		paths.push(await canonicalWorkspacePath(cwd, value));
	}
	const matches: Array<Record<string, unknown>> = [];
	let filesSearched = 0;
	let totalMatches = 0;
	let limitReached = false;
	const seen = new Map<string, Set<number>>();
	for (const searchPath of paths) {
		if (matches.length >= limit) break;
		const result = await grep(
			{
				pattern: query,
				path: searchPath,
				ignoreCase: !caseSensitive,
				hidden: true,
				gitignore: useGitignore,
				maxCount: limit - matches.length,
				maxColumns: MAX_SEARCH_LINE_CHARS,
				mode: GrepOutputMode.Content,
				signal: request.signal,
				timeoutMs: 30_000,
			},
			undefined,
		);
		filesSearched += result.filesSearched;
		totalMatches += result.totalMatches;
		limitReached ||= Boolean(result.limitReached);
		for (const match of result.matches.slice(0, limit - matches.length)) {
			const absolute = path.isAbsolute(match.path) ? match.path : path.resolve(searchPath, match.path);
			const lines = seen.get(absolute) ?? new Set<number>();
			lines.add(match.lineNumber);
			seen.set(absolute, lines);
			matches.push({
				path: safeRelative(root, absolute),
				line: match.lineNumber,
				text: match.line.slice(0, MAX_SEARCH_LINE_CHARS),
				truncated: Boolean(match.truncated),
			});
		}
	}
	const snapshots: Array<Record<string, unknown>> = [];
	for (const [absolute, lines] of seen) {
		const tag = await recordFileSnapshot(snapshotOwner, absolute, lines);
		if (!tag) continue;
		const relative = safeRelative(root, absolute);
		snapshots.push({ path: relative, tag, header: `[${relative}#${tag}]` });
	}
	return {
		matches,
		snapshots,
		total_matches: totalMatches,
		files_searched: filesSearched,
		truncated: limitReached || totalMatches > matches.length,
	};
}

class WorkspaceHashlineFilesystem extends Filesystem {
	readonly #cwd: string;
	readonly #signal: AbortSignal;

	constructor(cwd: string, signal: AbortSignal) {
		super();
		this.#cwd = cwd;
		this.#signal = signal;
	}

	#resolve(input: string): string {
		const absolute = path.resolve(this.#cwd, input);
		const relative = path.relative(this.#cwd, absolute);
		if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absolute;
		throw new RangeError(`path is outside the active workspace: ${input}`);
	}

	override canonicalPath(input: string): string {
		return canonicalSnapshotKey(this.#resolve(input));
	}

	override allowTagPathRecovery(): boolean {
		return false;
	}

	async readText(input: string): Promise<string> {
		if (this.#signal.aborted) throw this.#signal.reason;
		const absolute = this.#resolve(input);
		try {
			const stat = await fs.lstat(absolute);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("hashline target must be a regular file");
			if (stat.size > MAX_EDIT_FILE_BYTES) throw new RangeError("file is too large for workspace.hashline_edit");
			return await fs.readFile(absolute, "utf8");
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") throw new NotFoundError(input, error);
			throw error;
		}
	}

	async writeText(input: string, content: string): Promise<WriteResult> {
		if (this.#signal.aborted) throw this.#signal.reason;
		const absolute = this.#resolve(input);
		const stat = await fs.lstat(absolute);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("hashline target must be a regular file");
		const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
		try {
			await fs.writeFile(temporary, content, { mode: stat.mode });
			await fs.rename(temporary, absolute);
		} finally {
			await fs.rm(temporary, { force: true });
		}
		return { text: content };
	}
}

async function hashlineEditWorkspace(
	cwd: string,
	snapshotOwner: { fileSnapshotStore?: InMemorySnapshotStore },
	request: IpythonHostRequest,
): Promise<Record<string, unknown>> {
	const data = request.data;
	strict(data, ["input"]);
	const input = stringValue(data, "input", { max: MAX_EDIT_VALUE_CHARS });
	const patch = Patch.parse(input, { cwd });
	if (patch.sections.length !== 1) throw new RangeError("workspace.hashline_edit accepts exactly one file section");
	const section = patch.sections[0];
	if (!section.fileHash) throw new TypeError("hashline edit requires a snapshot tag from workspace.search");
	if (section.parse().fileOp)
		throw new TypeError("hashline create, delete, and move operations are not supported here");
	const authoredPath = path.resolve(cwd, section.path);
	const authoredStat = await fs.lstat(authoredPath);
	if (!authoredStat.isFile() || authoredStat.isSymbolicLink())
		throw new TypeError("hashline target must be a regular file");
	const absolute = await canonicalWorkspacePath(cwd, section.path);
	return await withFileLock(
		absolute,
		async () => {
			const patcher = new Patcher({
				fs: new WorkspaceHashlineFilesystem(cwd, request.signal),
				snapshots: getFileSnapshotStore(snapshotOwner),
				enforceSeenLines: true,
			});
			const applied = await patcher.apply(patch);
			const result = applied.sections[0];
			if (!result) throw new Error("hashline edit produced no result");
			const diff = generateDiffString(result.before, result.after, undefined, { path: section.path });
			const displayPath = path.resolve(cwd, section.path);
			await request.publishDisplay(
				richDisplay(
					DIFF_DISPLAY_MIME,
					{ path: displayPath, diff: diff.diff, start_line: result.firstChangedLine },
					`Edited ${displayPath}`,
				),
			);
			return {
				path: displayPath,
				op: result.op,
				header: result.header,
				tag: result.fileHash,
				diff: diff.diff,
				start_line: result.firstChangedLine ?? null,
				warnings: result.warnings,
			};
		},
		{ signal: request.signal },
	);
}

async function editWorkspace(cwd: string, request: IpythonHostRequest): Promise<Record<string, unknown>> {
	const data = request.data;
	strict(data, ["path", "old_str", "new_str"]);
	const inputPath = stringValue(data, "path", { max: 4_096 });
	const authoredPath = path.resolve(cwd, inputPath);
	const authoredStat = await fs.lstat(authoredPath);
	if (authoredStat.isSymbolicLink()) throw new TypeError("path must not be a symbolic link");
	const oldValue = stringValue(data, "old_str", { max: MAX_EDIT_VALUE_CHARS });
	const newValue = stringValue(data, "new_str", { optional: true, max: MAX_EDIT_VALUE_CHARS });
	const absolute = await canonicalWorkspacePath(cwd, inputPath);
	const displayPath = authoredPath;
	return await withFileLock(
		absolute,
		async () => {
			const stat = await fs.lstat(absolute);
			if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("path must be a regular file");
			if (stat.size > MAX_EDIT_FILE_BYTES) throw new RangeError("file is too large for workspace.edit");
			const before = await fs.readFile(absolute, "utf8");
			let count = 0;
			let cursor = before.indexOf(oldValue);
			while (cursor >= 0) {
				count += 1;
				if (count > 1) break;
				cursor = before.indexOf(oldValue, cursor + oldValue.length);
			}
			if (count !== 1)
				throw new RangeError(count === 0 ? "old_str was not found" : "old_str must match exactly once");
			const offset = before.indexOf(oldValue);
			const after = `${before.slice(0, offset)}${newValue}${before.slice(offset + oldValue.length)}`;
			const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${randomUUID()}.tmp`);
			try {
				await fs.writeFile(temporary, after, { mode: stat.mode });
				await fs.rename(temporary, absolute);
			} finally {
				await fs.rm(temporary, { force: true });
			}
			const diff = generateDiffString(before, after, undefined, { path: inputPath });
			const startLine = before.slice(0, offset).split("\n").length;
			await request.publishDisplay(
				richDisplay(
					DIFF_DISPLAY_MIME,
					{ path: displayPath, diff: diff.diff, start_line: startLine },
					`Edited ${displayPath}`,
				),
			);
			return { path: displayPath, diff: diff.diff, start_line: startLine };
		},
		{ signal: request.signal },
	);
}

function canonicalBase64(value: string): Buffer {
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
		throw new TypeError("data must be canonical base64");
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw new TypeError("data must be canonical base64");
	return decoded;
}

function detectedImageMime(data: Buffer): string | undefined {
	if (data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
	if (data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
	if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")
		return "image/gif";
	if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
		return "image/webp";
	return undefined;
}

async function admitAttachment(request: IpythonHostRequest): Promise<Record<string, unknown>> {
	const data = request.data;
	strict(data, ["path", "mime_type", "data"]);
	const imagePath = stringValue(data, "path", { max: 4_096 });
	const mimeType = stringValue(data, "mime_type", { max: 64 });
	const encoded = stringValue(data, "data", { max: MAX_ATTACHMENT_DATA_CHARS });
	const bytes = canonicalBase64(encoded);
	if (detectedImageMime(bytes) !== mimeType) throw new TypeError("mime_type does not match image content");
	let dimensions: { width: number; height: number };
	try {
		const metadata = await new Bun.Image(bytes).metadata();
		dimensions = { width: metadata.width, height: metadata.height };
	} catch {
		throw new TypeError("data is not a decodable image");
	}
	if (dimensions.width * dimensions.height > 36_000_000) throw new RangeError("image exceeds the pixel limit");
	await request.publishDisplay(
		richDisplay(
			ATTACHMENT_DISPLAY_MIME,
			{ path: imagePath, mime_type: mimeType, data: encoded },
			`Loaded image into context: ${imagePath}`,
		),
	);
	return { path: imagePath, mime_type: mimeType, bytes: bytes.byteLength, ...dimensions };
}

function scopeValue(data: Readonly<Record<string, unknown>>): HarnessScope {
	const value = data.scope ?? "local";
	if (value !== "local" && value !== "global") throw new TypeError("scope must be local or global");
	return value;
}

function capabilityKind(operation: string): HarnessKind {
	if (operation.startsWith("memory.")) return "memory";
	if (operation.startsWith("rules.")) return "rule";
	return "skill";
}

function capabilityHandlers(harness: HarnessService, refresh?: () => Promise<void>): IpythonHostHandlers {
	const handlers: Record<string, (request: IpythonHostRequest) => Promise<Record<string, unknown>>> = {};
	for (const domain of ["memory", "rules", "skills"] as const) {
		for (const action of ["list", "get", "create", "update", "delete"] as const) {
			const operation = `${domain}.${action}`;
			handlers[operation] = async request => {
				const kind = capabilityKind(operation);
				const data = request.data;
				const allowed =
					action === "list"
						? ["scope"]
						: action === "delete" || action === "get"
							? ["scope", "id"]
							: ["scope", "id", "description", "content"];
				strict(data, allowed);
				const scope = scopeValue(data);
				const global = scope === "global";
				if (action === "list") return { entries: await harness.list(kind, global, request.signal) };
				const id = stringValue(data, "id", { max: 128 });
				if (action === "get") return { entry: await harness.get(kind, id, global, request.signal) };
				if (action === "delete") {
					const deleted = await harness.delete(kind, id, global, request.signal);
					await refresh?.();
					return { deleted };
				}
				const description = stringValue(data, "description", { optional: true, max: 1_024 });
				const content = stringValue(data, "content", { max: 64_000 });
				const input = { kind, id, title: description || id, content, global };
				const entry =
					action === "create"
						? await harness.create(input, request.signal)
						: await harness.update(input, request.signal);
				await refresh?.();
				return { entry };
			};
		}
	}
	return handlers;
}

function mcpServer(
	owner: IpythonMcpOwner | undefined,
	data: Readonly<Record<string, unknown>>,
): { owner: IpythonMcpOwner; server: string } {
	if (!owner) throw new Error("MCP is not enabled for this session");
	const server = stringValue(data, "server", { max: 256 });
	if (!owner.getAllServerNames().includes(server) && !owner.getConnectedServers().includes(server)) {
		throw new RangeError(`unknown MCP server: ${server}`);
	}
	return { owner, server };
}

function boundedJson<T>(value: T, label: string): T {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError(`${label} is not JSON-compatible`);
	if (Buffer.byteLength(encoded) > MAX_MCP_JSON_BYTES) throw new RangeError(`${label} is too large`);
	return JSON.parse(encoded) as T;
}

function publicConfig(config: MCPServerConfig | undefined): Record<string, unknown> {
	if (!config) return {};
	let url: string | undefined;
	if ("url" in config) {
		const parsed = new URL(config.url);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		url = parsed.toString();
	}
	return { type: config.type ?? "stdio", url, enabled: config.enabled, timeout: config.timeout };
}

function createMcpHandlers(owner: IpythonMcpOwner | undefined): IpythonHostHandlers {
	return {
		"mcp.list_servers": request => {
			strict(request.data, []);
			if (!owner) return { servers: [] };
			const connected = new Set(owner.getConnectedServers());
			return {
				servers: owner
					.getAllServerNames()
					.sort()
					.map(name => ({ name, connected: connected.has(name) })),
			};
		},
		"mcp.list_tools": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			const tools = await target.owner.listTools(
				target.server,
				request.signal,
				booleanValue(request.data, "refresh", false),
			);
			return { tools: boundedJson(tools, "MCP tool list") };
		},
		"mcp.call_tool": async request => {
			strict(request.data, ["server", "tool", "arguments"]);
			const target = mcpServer(owner, request.data);
			const tool = stringValue(request.data, "tool", { max: 256 });
			const args = record(request.data.arguments ?? {}, "arguments") as Record<string, unknown>;
			const response = record(
				boundedJson(await target.owner.callTool(target.server, tool, args, request.signal), "MCP tool result"),
				"MCP tool result",
			);
			return { result: response.content ?? null, is_error: Boolean(response.isError) };
		},
		"mcp.list_resources": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			if (booleanValue(request.data, "refresh", false)) await target.owner.refreshServerResources(target.server);
			const resources = record(
				boundedJson(target.owner.getServerResources(target.server) ?? {}, "MCP resources"),
				"MCP resources",
			);
			return {
				resources: Array.isArray(resources.resources) ? resources.resources : [],
				templates: Array.isArray(resources.templates) ? resources.templates : [],
			};
		},
		"mcp.read_resource": async request => {
			strict(request.data, ["server", "uri"]);
			const target = mcpServer(owner, request.data);
			const result = await target.owner.readServerResource(
				target.server,
				stringValue(request.data, "uri", { max: 8_192 }),
				{ signal: request.signal },
			);
			return { result: boundedJson(result ?? null, "MCP resource") };
		},
		"mcp.list_prompts": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			if (booleanValue(request.data, "refresh", false)) await target.owner.refreshServerPrompts(target.server);
			return { prompts: boundedJson(target.owner.getServerPrompts(target.server) ?? [], "MCP prompts") };
		},
		"mcp.get_prompt": async request => {
			strict(request.data, ["server", "name", "arguments"]);
			const target = mcpServer(owner, request.data);
			const rawArgs = record(request.data.arguments ?? {}, "arguments");
			const args = Object.fromEntries(
				Object.entries(rawArgs).map(([key, value]) => {
					if (typeof value !== "string") throw new TypeError("prompt arguments must be strings");
					return [key, value];
				}),
			);
			const result = await target.owner.executePrompt(
				target.server,
				stringValue(request.data, "name", { max: 256 }),
				args,
				{ signal: request.signal },
			);
			return { result: boundedJson(result ?? null, "MCP prompt") };
		},
		"mcp.config": request => {
			strict(request.data, ["server"]);
			const target = mcpServer(owner, request.data);
			return {
				server: target.server,
				connected: target.owner.getConnectedServers().includes(target.server),
				...publicConfig(target.owner.getServerConfig(target.server)),
			};
		},
		"mcp.refresh": async request => {
			strict(request.data, ["server"]);
			const target = mcpServer(owner, request.data);
			return { refreshed: await target.owner.refreshCredentials(target.server) };
		},
	};
}

/** Builds typed session services used by the Python capability surface without invoking an AgentTool. */
export function createIpythonCapabilityHostHandlers(options: IpythonCapabilityServiceOptions): IpythonHostHandlers {
	const cwd = path.resolve(options.cwd);
	return composeIpythonHostHandlers(
		{
			"model.info": request => {
				strict(request.data, []);
				return { ...options.modelInfo() };
			},
			"workspace.search": request => searchWorkspace(cwd, options.snapshotOwner, request),
			"workspace.edit": request => editWorkspace(cwd, request),
			"workspace.hashline_edit": request => hashlineEditWorkspace(cwd, options.snapshotOwner, request),
			"attachment.admit": admitAttachment,
		},
		capabilityHandlers(options.harness, options.refreshSystemPrompt),
		createMcpHandlers(options.mcp),
	);
}

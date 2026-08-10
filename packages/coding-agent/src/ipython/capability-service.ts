import * as fs from "node:fs/promises";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { callTool, listTools } from "../mcp/client";
import type { MCPManager } from "../mcp/manager";
import { isRetriableConnectionError } from "../mcp/reconnect";
import type { MCPAuthChallenge, MCPServerConfig, MCPServerConnection } from "../mcp/types";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import type { IpythonDisplayEvent, IpythonHostHandlers, IpythonHostRequest } from "./controller";
import type { HarnessKind, HarnessScope, HarnessService } from "./harness-service";
import { composeIpythonHostHandlers } from "./host-bridge";

const MAX_ATTACHMENT_DATA_CHARS = 350_000;
const MAX_MCP_JSON_BYTES = 1024 * 1024;
const ATTACHMENT_DISPLAY_MIME = "application/vnd.omp.attachment+json";

export type IpythonMcpManagerOwner = Pick<
	MCPManager,
	| "getAllServerNames"
	| "getConnectedServers"
	| "getServerConfig"
	| "getConnection"
	| "reconnectServer"
	| "getNotificationState"
	| "addNotificationListener"
	| "getServerResources"
	| "readServerResource"
	| "getServerPrompts"
	| "executePrompt"
	| "refreshServerResources"
	| "refreshServerPrompts"
>;

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
	reconnect(name: string, signal: AbortSignal): Promise<boolean>;
	getNotificationState?(): unknown;
	waitNotification?(options: {
		server?: string;
		method?: string;
		timeoutMs: number;
		signal: AbortSignal;
	}): Promise<unknown>;
	refreshServerResources(name: string): Promise<void>;
	refreshServerPrompts(name: string): Promise<void>;
}

async function reconnectMcpServer(
	manager: IpythonMcpManagerOwner,
	name: string,
	signal: AbortSignal,
	options?: { manual?: boolean; authChallenge?: MCPAuthChallenge },
): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, () => manager.reconnectServer(name, options));
	} catch (error) {
		if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new ToolAbortError();
		throw error;
	}
}

/** Adapts the MCP manager to the typed IPython capability boundary. */
export function createIpythonMcpOwner(manager: IpythonMcpManagerOwner): IpythonMcpOwner {
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
			let connection = manager.getConnection(name);
			if (!connection) throw new Error(`MCP server is not connected: ${name}`);
			let retried = false;
			const reconnect = async (options?: { authChallenge?: MCPAuthChallenge }) =>
				await reconnectMcpServer(manager, name, signal, options);
			try {
				const result = await callTool(connection, tool, args, { signal });
				const values = result._meta?.["mcp/www_authenticate"];
				const challenge =
					result.isError && Array.isArray(values)
						? {
								wwwAuthenticate: values.filter(
									(value): value is string => typeof value === "string" && value.trim() !== "",
								),
							}
						: undefined;
				if (!challenge?.wwwAuthenticate.length || retried) return result;
				retried = true;
				const refreshed = await reconnect({ authChallenge: challenge });
				if (!refreshed) return result;
				connection = refreshed;
				return await callTool(connection, tool, args, { signal });
			} catch (error) {
				throwIfAborted(signal);
				if (retried || !isRetriableConnectionError(error)) throw error;
				retried = true;
				const refreshed = await reconnect();
				if (!refreshed) throw error;
				connection = refreshed;
				return await callTool(connection, tool, args, { signal });
			}
		},
		getServerResources: name => manager.getServerResources(name),
		readServerResource: (name, uri, options) => manager.readServerResource(name, uri, options),
		getServerPrompts: name => manager.getServerPrompts(name),
		executePrompt: (name, promptName, args, options) => manager.executePrompt(name, promptName, args, options),
		reconnect: async (name, signal) => Boolean(await reconnectMcpServer(manager, name, signal, { manual: true })),
		getNotificationState: () => {
			const state = manager.getNotificationState();
			return {
				enabled: state.enabled,
				subscriptions: [...state.subscriptions].map(([server, methods]) => ({ server, methods: [...methods] })),
			};
		},
		waitNotification: ({ server, method, timeoutMs, signal }) =>
			waitForMcpNotification(manager, { server, method, timeoutMs, signal }),
		refreshServerResources: name => manager.refreshServerResources(name),
		refreshServerPrompts: name => manager.refreshServerPrompts(name),
	};
}

export interface IpythonCapabilityServiceOptions {
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

async function waitForMcpNotification(
	manager: IpythonMcpManagerOwner,
	options: { server?: string; method?: string; timeoutMs: number; signal: AbortSignal },
): Promise<Readonly<Record<string, unknown>>> {
	throwIfAborted(options.signal);
	const pending = Promise.withResolvers<Readonly<Record<string, unknown>>>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;
	let settled = false;
	const finish = (callback: () => void) => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) clearTimeout(timer);
		unsubscribe?.();
		callback();
	};
	const onAbort = () => finish(() => pending.reject(new ToolAbortError()));
	options.signal.addEventListener("abort", onAbort, { once: true });
	try {
		unsubscribe = manager.addNotificationListener((server, method, params) => {
			if (options.server && options.server !== server) return;
			if (options.method && options.method !== method) return;
			finish(() => pending.resolve({ server, method, params: sanitizeMcpValue(params) }));
		});
		if (settled) unsubscribe();
		if (!settled && options.timeoutMs > 0) {
			timer = setTimeout(() => finish(() => pending.resolve({ timeout: true })), options.timeoutMs);
			timer.unref?.();
		}
		return await pending.promise;
	} finally {
		options.signal.removeEventListener("abort", onAbort);
		if (!settled) finish(() => {});
	}
}

const PRIVATE_MCP_KEYS = new Set([
	"_meta",
	"api_key",
	"apikey",
	"authorization",
	"cookie",
	"credential",
	"password",
	"refresh_token",
	"secret",
	"set-cookie",
	"token",
	"access_token",
]);

function sanitizeMcpValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeMcpValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !PRIVATE_MCP_KEYS.has(key.toLowerCase()))
			.map(([key, item]) => [key, sanitizeMcpValue(item)]),
	);
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

async function boundedJson<T>(
	request: IpythonHostRequest,
	value: T,
	label: string,
): Promise<T | Readonly<Record<string, unknown>>> {
	const encoded = JSON.stringify(value);
	if (encoded === undefined) throw new TypeError(`${label} is not JSON-compatible`);
	if (Buffer.byteLength(encoded) <= MAX_MCP_JSON_BYTES) return JSON.parse(encoded) as T;
	throwIfAborted(request.signal);
	const artifact = await request.allocateArtifact({
		label: `mcp-${label.toLowerCase().replaceAll(" ", "-")}`,
		mimeType: "application/json",
		suffix: ".json",
	});
	throwIfAborted(request.signal);
	await fs.writeFile(artifact.path, encoded, "utf8");
	throwIfAborted(request.signal);
	return {
		truncated: true,
		artifact: { ...artifact, bytes: Buffer.byteLength(encoded), mime_type: "application/json" },
	};
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
			return { tools: await boundedJson(request, sanitizeMcpValue(tools), "MCP tool list") };
		},
		"mcp.call_tool": async request => {
			strict(request.data, ["server", "tool", "arguments"]);
			const target = mcpServer(owner, request.data);
			const tool = stringValue(request.data, "tool", { max: 256 });
			const args = record(request.data.arguments ?? {}, "arguments") as Record<string, unknown>;
			const response = record(
				await target.owner.callTool(target.server, tool, args, request.signal),
				"MCP tool result",
			);
			return {
				result: await boundedJson(request, sanitizeMcpValue(response.content ?? null), "MCP tool result"),
				is_error: Boolean(response.isError),
			};
		},
		"mcp.list_resources": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			if (booleanValue(request.data, "refresh", false)) {
				throwIfAborted(request.signal);
				await untilAborted(request.signal, () => target.owner.refreshServerResources(target.server));
				throwIfAborted(request.signal);
			}
			const value = record(target.owner.getServerResources(target.server) ?? {}, "MCP resources");
			return {
				resources: await boundedJson(
					request,
					sanitizeMcpValue(Array.isArray(value.resources) ? value.resources : []),
					"MCP resources",
				),
				templates: await boundedJson(
					request,
					sanitizeMcpValue(Array.isArray(value.templates) ? value.templates : []),
					"MCP resource templates",
				),
			};
		},
		"mcp.resource_templates": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			if (booleanValue(request.data, "refresh", false)) {
				throwIfAborted(request.signal);
				await untilAborted(request.signal, () => target.owner.refreshServerResources(target.server));
				throwIfAborted(request.signal);
			}
			const resources = record(target.owner.getServerResources(target.server) ?? {}, "MCP resources");
			return {
				templates: await boundedJson(
					request,
					sanitizeMcpValue(Array.isArray(resources.templates) ? resources.templates : []),
					"MCP resource templates",
				),
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
			return { result: await boundedJson(request, sanitizeMcpValue(result ?? null), "MCP resource") };
		},
		"mcp.list_prompts": async request => {
			strict(request.data, ["server", "refresh"]);
			const target = mcpServer(owner, request.data);
			if (booleanValue(request.data, "refresh", false)) {
				throwIfAborted(request.signal);
				await untilAborted(request.signal, () => target.owner.refreshServerPrompts(target.server));
				throwIfAborted(request.signal);
			}
			return {
				prompts: await boundedJson(
					request,
					sanitizeMcpValue(target.owner.getServerPrompts(target.server) ?? []),
					"MCP prompts",
				),
			};
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
			return { result: await boundedJson(request, sanitizeMcpValue(result ?? null), "MCP prompt") };
		},
		"mcp.notification_state": request => {
			strict(request.data, []);
			return sanitizeMcpValue(owner?.getNotificationState?.() ?? { enabled: false, subscriptions: [] }) as Readonly<
				Record<string, unknown>
			>;
		},
		"mcp.wait_notification": async request => {
			strict(request.data, ["server", "method", "timeout"]);
			if (!owner?.waitNotification) throw new Error("MCP notifications are not available");
			const server = stringValue(request.data, "server", { optional: true, max: 256 }) || undefined;
			const method = stringValue(request.data, "method", { optional: true, max: 256 }) || undefined;
			const timeout = integerValue(request.data, "timeout", 30, 0, 120);
			const notification = await owner.waitNotification({
				server,
				method,
				timeoutMs: timeout * 1_000,
				signal: request.signal,
			});
			return (await boundedJson(request, sanitizeMcpValue(notification), "MCP notification")) as Readonly<
				Record<string, unknown>
			>;
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
			const refreshed = await target.owner.reconnect(target.server, request.signal);
			return {
				refreshed,
				connected: target.owner.getConnectedServers().includes(target.server),
				connection: refreshed ? "connected" : "disconnected",
			};
		},
	};
}

/** Builds typed session services used by the Python capability surface without invoking an AgentTool. */
export function createIpythonCapabilityHostHandlers(options: IpythonCapabilityServiceOptions): IpythonHostHandlers {
	return composeIpythonHostHandlers(
		{
			"model.info": request => {
				strict(request.data, []);
				return { ...options.modelInfo() };
			},
			"attachment.admit": admitAttachment,
		},
		capabilityHandlers(options.harness, options.refreshSystemPrompt),
		createMcpHandlers(options.mcp),
	);
}

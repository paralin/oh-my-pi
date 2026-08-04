import { type } from "@oh-my-pi/omptype";
import { type Tool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { readWorldAddress, renderWorldRead, worldAddressFromInput } from "../internal-urls/spacewave-protocol";
import claudeCodeHubPrompt from "../prompts/tools/claude-code-hub.md" with { type: "text" };
import claudeCodeYieldPrompt from "../prompts/tools/claude-code-yield.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { HubTool } from "../tools/hub";
import { WORLD_TOOL_NAME, WorldTool } from "../tools/world";
import { YieldTool } from "../tools/yield";
import { MAX_WORLD_READ_PAGE, WorldClient } from "../world/index.js";
import { TaskTool } from ".";
import type { ClaudeCodeMcpTool, ClaudeCodeToolResult } from "./claude-code-sdk";
import { isClaudeCodeMcpObjectSchema } from "./claude-code-sdk";
import type { ExecutorOptions } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { YieldItem } from "./types";

/** MCP tools required in every Claude Code task runtime. */
export const CLAUDE_CODE_MCP_TOOL_NAMES = ["task", "hub", "yield"] as const;

/**
 * Read-only World tool, advertised only when a World socket is configured.
 *
 * It is not in {@link CLAUDE_CODE_MCP_TOOL_NAMES} on purpose: those are
 * required in every run, and this one is absent whenever no daemon is
 * configured. A required-but-conditional tool would make an unconfigured root
 * look like a broken one.
 */
export const CLAUDE_CODE_WORLD_READ_TOOL_NAME = "world_read";

/**
 * Authority-checked World operations, advertised only when this root also names
 * a caller session.
 *
 * Conditional for the same reason `world_read` is, one step further in: a socket
 * alone leaves the peer with reads and no way to be charged for a change.
 */
export const CLAUDE_CODE_WORLD_TOOL_NAME = WORLD_TOOL_NAME;

const CLAUDE_CODE_HUB_OPS = ["list", "send", "inbox", "wait", "jobs", "cancel"] as const;
const CLAUDE_CODE_HUB_OP_BY_NAME: Readonly<Record<string, true | undefined>> = {
	list: true,
	send: true,
	inbox: true,
	wait: true,
	jobs: true,
	cancel: true,
};
const HUB_PROCESS_FIELDS = [
	"name",
	"application",
	"args",
	"env",
	"cwd",
	"pty",
	"ready",
	"restart",
	"persist",
	"detached",
	"lines",
	"head",
	"grep",
	"follow",
	"cursor",
	"for",
	"pattern",
	"text",
	"enter",
	"keys",
	"signal",
	"timeout",
] as const;

export interface ClaudeCodeToolBridgeOptions {
	executor: ExecutorOptions;
	registry: AgentRegistry;
	signal: AbortSignal;
	yieldItems: YieldItem[];
	onTerminalYield(): void;
}

/** Text tool content carried over the MCP boundary. */
function toolResultContent(content: { type: string; text?: string }[]): { type: "text"; text: string }[] {
	return content
		.filter(part => part.type === "text" && part.text !== undefined)
		.map(part => ({ type: "text" as const, text: part.text ?? "" }));
}

function toolFailure(error: unknown): ClaudeCodeToolResult {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		isError: true,
	};
}

/** Session policy inherited by Task and Hub without constructing a Pi session. */
export function createClaudeCodeToolSession(options: ExecutorOptions, registry: AgentRegistry): ToolSession {
	const settings = options.settings ?? Settings.isolated();
	const cwd = options.worktree ?? options.cwd;
	const taskDepth = (options.taskDepth ?? 0) + 1;
	const maxDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const atMaxDepth = maxDepth >= 0 && taskDepth >= maxDepth;
	const spawns = atMaxDepth
		? ""
		: options.agent.spawns === undefined
			? ""
			: options.agent.spawns === "*"
				? "*"
				: options.agent.spawns.join(",");
	const getArtifactsDir = (): string | null => options.artifactsDir ?? null;
	return {
		cwd,
		additionalDirectories: options.worktree === undefined ? options.additionalDirectories : undefined,
		hasUI: false,
		getApiKey: options.getApiKey,
		contextFiles: options.contextFiles,
		workspaceTree: options.workspaceTree,
		skills: options.skills,
		promptTemplates: options.promptTemplates,
		rules: options.rules,
		extensionPaths: options.preloadedExtensionPaths,
		customToolPaths: options.preloadedCustomToolPaths,
		enableLsp: options.enableLsp,
		enableIrc: options.enableIrc,
		enableMCP: options.enableMCP,
		eventBus: options.eventBus,
		restrictToolNames: options.restrictToolNames,
		taskDepth,
		getEvalSessionId: () => options.parentEvalSessionId ?? null,
		// Only live, non-isolated owners can retain addressable children.
		keepAliveSubagents: options.keepAlive !== false && options.worktree === undefined,
		getSessionFile: () => null,
		getAgentId: () => options.id,
		agentRegistry: registry,
		getArtifactsDir,
		getArtifactManager: () => options.parentArtifactManager ?? null,
		getSessionSpawns: () => spawns,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		agentOutputManager: new AgentOutputManager(getArtifactsDir, { parentPrefix: options.id }),
		asyncJobManager: options.asyncJobManager,
		mcpManager: options.mcpManager,
		localProtocolOptions: options.localProtocolOptions,
		settings,
		...(options.parentServiceTier ? { getServiceTierByFamily: () => options.parentServiceTier ?? undefined } : {}),
	};
}

function objectToolSchema(tool: Tool): ClaudeCodeMcpTool["inputSchema"] {
	const schema = toolWireSchema(tool);
	if (!isClaudeCodeMcpObjectSchema(schema)) {
		throw new TypeError(`OMP ${tool.name} parameters must be an object JSON Schema.`);
	}
	return schema;
}

function buildYieldMcpTool(
	yieldTool: YieldTool,
	yieldItems: YieldItem[],
	onTerminalYield: () => void,
): ClaudeCodeMcpTool {
	const handler = subprocessToolRegistry.getHandler("yield");
	return {
		name: yieldTool.name,
		description: prompt.render(claudeCodeYieldPrompt, { description: yieldTool.description }),
		inputSchema: objectToolSchema(yieldTool),
		handler: async args => {
			const toolCallId = `yield-${yieldItems.length}`;
			try {
				const result = await yieldTool.execute(toolCallId, args);
				const event = {
					toolName: yieldTool.name,
					toolCallId,
					args,
					result: { content: toolResultContent(result.content), details: result.details },
				};
				const item = handler?.extractData?.(event);
				if (item) yieldItems.push(item);
				if (handler?.shouldTerminate?.(event) ?? true) onTerminalYield();
				return { content: toolResultContent(result.content) };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

function buildTaskMcpTool(taskTool: TaskTool, signal: AbortSignal): ClaudeCodeMcpTool {
	let calls = 0;
	return {
		name: taskTool.name,
		description: taskTool.description,
		inputSchema: objectToolSchema(taskTool),
		handler: async args => {
			try {
				const result = await taskTool.execute(`claude-task-${++calls}`, args, signal);
				return { content: toolResultContent(result.content) };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

function projectHubSchema(hubTool: HubTool): ClaudeCodeMcpTool["inputSchema"] {
	const schema = structuredClone(objectToolSchema(hubTool));
	const properties = schema.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
		throw new TypeError("OMP Hub parameters must declare object properties.");
	}
	for (const field of HUB_PROCESS_FIELDS) delete properties[field];
	const op = properties.op;
	if (!op || typeof op !== "object" || Array.isArray(op)) {
		throw new TypeError("OMP Hub parameters must declare an op schema.");
	}
	op.enum = [...CLAUDE_CODE_HUB_OPS];
	return schema;
}

function assertAdmittedHubCall(args: Record<string, unknown>): void {
	const op = args.op;
	if (typeof op !== "string" || !CLAUDE_CODE_HUB_OP_BY_NAME[op]) {
		throw new Error(`Claude Code Hub operation is unavailable: ${String(op)}.`);
	}
	for (const field of HUB_PROCESS_FIELDS) {
		if (Object.hasOwn(args, field)) {
			throw new Error(`Claude Code Hub process field is unavailable: ${field}.`);
		}
	}
}

function buildHubMcpTool(hubTool: HubTool, signal: AbortSignal): ClaudeCodeMcpTool {
	let calls = 0;
	return {
		name: hubTool.name,
		description: prompt.render(claudeCodeHubPrompt),
		inputSchema: projectHubSchema(hubTool),
		handler: async args => {
			try {
				assertAdmittedHubCall(args);
				const toolCallId = `claude-hub-${++calls}`;
				const params = hubTool.parameters(args);
				if (params instanceof type.errors) {
					throw new Error(`Invalid OMP Hub arguments: ${params.summary}`);
				}
				const result = await hubTool.execute(toolCallId, params, signal);
				return { content: toolResultContent(result.content) };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

/**
 * Forward the peer abort only while this unary read is pending.
 *
 * starpc retains its abort listener until the stream pipe closes, which can
 * outlive the unary response. Passing the peer lifetime signal directly would
 * let a later peer shutdown cancel an already-completed call.
 */
async function withPeerSignal<T>(peerSignal: AbortSignal, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const operation = new AbortController();
	const abort = () => operation.abort(peerSignal.reason);
	if (peerSignal.aborted) abort();
	else peerSignal.addEventListener("abort", abort, { once: true });
	try {
		return await run(operation.signal);
	} finally {
		peerSignal.removeEventListener("abort", abort);
	}
}

async function readWorldForPeer(uri: string, client: WorldClient, limit: number | undefined, peerSignal: AbortSignal) {
	return await withPeerSignal(peerSignal, signal => readWorldAddress(uri, client, { limit, signal }));
}

/**
 * Build the read-only World tool for one Claude task peer.
 *
 * It calls the same `readWorldAddress` and `renderWorldRead` the native
 * `spacewave://` handler calls, so the two paths cannot drift: there is one
 * World operation and one renderer, reached two ways.
 */
function buildWorldReadMcpTool(client: WorldClient, signal: AbortSignal): ClaudeCodeMcpTool {
	return {
		name: CLAUDE_CODE_WORLD_READ_TOOL_NAME,
		description: [
			"Read one canonical GLaDOS World URL.",
			"",
			"URL form: spacewave:///u/{session_idx}/so/{space_id}/-/{objectKey}",
			"A trailing /- reads the bounded key listing under that key instead.",
			"The URL path is sent exactly as written and is never percent-decoded.",
			"Read-only: there is no World write through this tool.",
		].join("\n"),
		inputSchema: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Canonical World URL, e.g. spacewave:///u/1/so/{space_id}/-/glados/projections/agent-tree",
				},
				limit: {
					type: "integer",
					minimum: 1,
					maximum: MAX_WORLD_READ_PAGE,
					description: `Maximum keys in a listing. Defaults to ${MAX_WORLD_READ_PAGE}.`,
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		handler: async args => {
			try {
				const url = args.url;
				if (typeof url !== "string") throw new Error("world_read requires a string url.");
				const uri = worldAddressFromInput(url);
				const rawLimit = args.limit;
				const limit = rawLimit === undefined ? undefined : Number(rawLimit);
				const read = await readWorldForPeer(uri, client, limit, signal);
				return { content: [{ type: "text" as const, text: renderWorldRead(uri, read).content }] };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

/**
 * Build the authority-checked World tool for one Claude task peer.
 *
 * It is the native {@link WorldTool}: the same schema, the same argument
 * validation, the same client methods, and the same renderer. Advertising a
 * hand-written copy of the schema here is exactly the drift the shared tool
 * exists to prevent, so the wire schema is derived from the tool itself.
 *
 * A structured refusal comes back as rendered text with `isError`, which is the
 * bridge's only result shape. The typed error is what produced that text, so
 * both runtimes report the same fields.
 */
function buildWorldMcpTool(client: WorldClient, signal: AbortSignal): ClaudeCodeMcpTool {
	const worldTool = new WorldTool(client);
	let calls = 0;
	return {
		name: worldTool.name,
		description: worldTool.description,
		inputSchema: objectToolSchema(worldTool),
		handler: async args => {
			try {
				const params = worldTool.parameters(args);
				if (params instanceof type.errors) {
					throw new Error(`Invalid OMP world arguments: ${params.summary}`);
				}
				const toolCallId = `claude-world-${++calls}`;
				const result = await withPeerSignal(signal, operation => worldTool.execute(toolCallId, params, operation));
				return { content: toolResultContent(result.content), isError: result.isError === true };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

/** Build the OMP coordination tools admitted to one Claude task peer. */
export async function createClaudeCodeMcpTools(options: ClaudeCodeToolBridgeOptions): Promise<ClaudeCodeMcpTool[]> {
	const session = createClaudeCodeToolSession(options.executor, options.registry);
	const taskTool = await TaskTool.create(session);
	const hubTool = new HubTool(session);
	const yieldTool = new YieldTool({
		...session,
		outputSchema: options.executor.outputSchema,
		outputSchemaMode: options.executor.outputSchemaMode,
	});
	const tools = [
		buildTaskMcpTool(taskTool, options.signal),
		buildHubMcpTool(hubTool, options.signal),
		buildYieldMcpTool(yieldTool, options.yieldItems, options.onTerminalYield),
	];
	// One client for this peer's whole run, selected once from the
	// configuration the task started under. `create` dials nothing and returns
	// undefined when nothing is configured, so an unconfigured root simply does
	// not get the tool rather than getting one that can only fail.
	const worldClient = WorldClient.create();
	if (worldClient) {
		// The peer's signal ends the run, so it is what releases the client.
		// The rejection is observed here because an abort handler has no caller
		// to return it to: an unobserved one would surface as an unhandled
		// rejection and fail the process over a best-effort cleanup.
		options.signal.addEventListener("abort", () => void worldClient.close().catch(() => {}), { once: true });
		tools.push(buildWorldReadMcpTool(worldClient, options.signal));
		// The write-capable tool needs the second half of the configuration. A
		// socket-only root keeps exactly its W2 surface rather than gaining a tool
		// whose every call would be refused for want of a caller identity.
		const agentTools = options.executor.agent.tools;
		if (worldClient.canMutate && (!agentTools?.length || agentTools.includes(WORLD_TOOL_NAME))) {
			tools.push(buildWorldMcpTool(worldClient, options.signal));
		}
	}
	return tools;
}

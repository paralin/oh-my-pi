import { type } from "@oh-my-pi/omptype";
import { type Tool, toolWireSchema } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import claudeCodeHubPrompt from "../prompts/tools/claude-code-hub.md" with { type: "text" };
import claudeCodeYieldPrompt from "../prompts/tools/claude-code-yield.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../tools";
import { HubTool } from "../tools/hub";
import { YieldTool } from "../tools/yield";
import { TaskTool } from ".";
import type { ClaudeCodeMcpTool, ClaudeCodeToolResult } from "./claude-code-sdk";
import { isClaudeCodeMcpObjectSchema } from "./claude-code-sdk";
import type { ExecutorOptions } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { YieldItem } from "./types";

/** MCP tools required in every Claude Code task runtime. */
export const CLAUDE_CODE_MCP_TOOL_NAMES = ["task", "hub", "yield"] as const;

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
	return [
		buildTaskMcpTool(taskTool, options.signal),
		buildHubMcpTool(hubTool, options.signal),
		buildYieldMcpTool(yieldTool, options.yieldItems, options.onTerminalYield),
	];
}

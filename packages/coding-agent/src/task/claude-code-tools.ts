import { type } from "@oh-my-pi/omptype";
import { arkToWireSchema } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import claudeCodeHubPrompt from "../prompts/tools/claude-code-hub.md" with { type: "text" };
import claudeCodeYieldPrompt from "../prompts/tools/claude-code-yield.md" with { type: "text" };
import type { AgentRegistry } from "../registry/agent-registry";
import type { ToolSession } from "../session/tool-session";
import { executeHubOperation, HUB_TOOL_NAME, HUB_TOOL_SCHEMA } from "../tools/hub";
import { YIELD_TOOL_DESCRIPTION, YIELD_TOOL_NAME, YieldService } from "../tools/yield";
import { TaskService } from ".";
import type { ClaudeCodeMcpTool, ClaudeCodeToolResult } from "./claude-code-sdk";
import { isClaudeCodeMcpObjectSchema } from "./claude-code-sdk";
import type { ExecutorOptions } from "./executor";
import { AgentOutputManager } from "./output-manager";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { YieldItem } from "./types";

/** MCP tools required in every Claude Code task runtime. */
export const CLAUDE_CODE_MCP_TOOL_NAMES = ["task", "hub", YIELD_TOOL_NAME] as const;

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
		content: [
			{
				type: "text",
				text: error instanceof Error ? error.message : String(error),
			},
		],
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
		enableLsp: options.enableLsp,
		enableIrc: options.enableIrc,
		enableMCP: options.enableMCP,
		eventBus: options.eventBus,
		restrictToolNames: options.restrictToolNames,
		taskDepth,
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
		agentOutputManager: new AgentOutputManager(getArtifactsDir, {
			parentPrefix: options.id,
		}),
		coordinationBackend: options.coordinationBackend,
		asyncJobManager: options.asyncJobManager,
		mcpManager: options.mcpManager,
		localProtocolOptions: options.localProtocolOptions,
		settings,
		...(options.parentServiceTier ? { getServiceTierByFamily: () => options.parentServiceTier ?? undefined } : {}),
	};
}

function objectSchema(schema: unknown, name: string): ClaudeCodeMcpTool["inputSchema"] {
	if (!isClaudeCodeMcpObjectSchema(schema)) {
		throw new TypeError(`OMP ${name} parameters must be an object JSON Schema.`);
	}
	return schema;
}

function buildYieldMcpTool(
	yieldService: YieldService,
	yieldItems: YieldItem[],
	onTerminalYield: () => void,
): ClaudeCodeMcpTool {
	const handler = subprocessToolRegistry.getHandler("yield");
	return {
		name: YIELD_TOOL_NAME,
		description: prompt.render(claudeCodeYieldPrompt, {
			description: YIELD_TOOL_DESCRIPTION,
		}),
		inputSchema: objectSchema(yieldService.schema, YIELD_TOOL_NAME),
		handler: async args => {
			const toolCallId = `yield-${yieldItems.length}`;
			try {
				const result = await yieldService.submit(args);
				const event = {
					toolName: YIELD_TOOL_NAME,
					toolCallId,
					args,
					result: {
						content: toolResultContent(result.content),
						details: result.details,
					},
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

const CLAUDE_CODE_TASK_DESCRIPTION = [
	"Delegate a self-contained assignment to an OMP subagent.",
	"The returned child id can be inspected, waited on, cancelled, or messaged through hub.",
	"Use one task unless the advertised schema enables a shared-context batch.",
].join("\n");

/** Bridge the neutral Task service into Claude Code's explicit MCP boundary. */
function buildTaskMcpTool(taskService: TaskService, signal: AbortSignal): ClaudeCodeMcpTool {
	let calls = 0;
	return {
		name: "task",
		description: CLAUDE_CODE_TASK_DESCRIPTION,
		inputSchema: objectSchema(arkToWireSchema(taskService.schema), "task"),
		handler: async args => {
			try {
				const result = await taskService.spawn(`claude-task-${++calls}`, args, signal);
				return { content: toolResultContent(result.content) };
			} catch (error) {
				return toolFailure(error);
			}
		},
	};
}

function projectHubSchema(): ClaudeCodeMcpTool["inputSchema"] {
	const schema = structuredClone(arkToWireSchema(HUB_TOOL_SCHEMA));
	if (!isClaudeCodeMcpObjectSchema(schema)) {
		throw new TypeError("OMP Hub parameters must be an object JSON Schema.");
	}
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

function buildHubMcpTool(session: ToolSession, signal: AbortSignal): ClaudeCodeMcpTool {
	return {
		name: HUB_TOOL_NAME,
		description: prompt.render(claudeCodeHubPrompt),
		inputSchema: projectHubSchema(),
		handler: async args => {
			try {
				assertAdmittedHubCall(args);
				const params = HUB_TOOL_SCHEMA(args);
				if (params instanceof type.errors) {
					throw new Error(`Invalid OMP Hub arguments: ${params.summary}`);
				}
				const result = await executeHubOperation(session, params, signal);
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
	const taskService = TaskService.create(session);
	const yieldService = new YieldService({ outputSchema: options.executor.outputSchema });
	const tools = [
		buildTaskMcpTool(taskService, options.signal),
		buildHubMcpTool(session, options.signal),
		buildYieldMcpTool(yieldService, options.yieldItems, options.onTerminalYield),
	];
	return tools;
}

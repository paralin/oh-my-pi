/**
 * The only module that imports `@anthropic-ai/claude-agent-sdk`.
 *
 * {@link startClaudeCodeQuery} is the production adapter behind the
 * {@link StartClaudeCodeQuery} port: the request carries exactly the options a
 * task run fixes (model, working directory, configured executable, appended
 * system prompt, denied native tools, the in-process OMP MCP server, and the
 * abort controller), and the event stream is the slice a task result is built
 * from. The SDK import remains confined to this adapter.
 *
 * Tool schemas cross this boundary in OMP's native JSON Schema language;
 * advertising them without duplicating their validation is this adapter's job.
 */
import {
	createSdkMcpServer,
	type EffortLevel,
	type McpSdkServerConfigWithInstance,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as z from "zod";

/** Text-only MCP tool result returned by an OMP tool handler. */
export interface ClaudeCodeToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

/** One in-process MCP tool admitted to the Claude runtime. */
export interface ClaudeCodeMcpTool {
	name: string;
	description: string;
	/** Object JSON Schema advertised to the model as this tool's parameters. */
	inputSchema: z.core.JSONSchema.ObjectSchema;
	handler: (args: Record<string, unknown>) => Promise<ClaudeCodeToolResult>;
}

/** Narrow an OMP tool schema to the object boundary required by MCP. */
export function isClaudeCodeMcpObjectSchema(schema: unknown): schema is ClaudeCodeMcpTool["inputSchema"] {
	return (
		typeof schema === "object" &&
		schema !== null &&
		!Array.isArray(schema) &&
		"type" in schema &&
		schema.type === "object"
	);
}

const listToolsRequestSchema = z.object({
	method: z.literal("tools/list"),
});

const callToolRequestSchema = z.object({
	method: z.literal("tools/call"),
	params: z.object({
		name: z.string(),
		arguments: z.record(z.string(), z.unknown()),
	}),
});

/** The in-process MCP server admitted to the Claude runtime. */
export interface ClaudeCodeMcpServer {
	name: string;
	instructions?: string;
	tools: ClaudeCodeMcpTool[];
}

/** One ordered input stream for a retained Claude query. */
export type ClaudeCodeInput = string | AsyncIterable<string>;

/** Everything one synchronous Claude Agent SDK task run needs. */
export interface ClaudeCodeQueryRequest {
	prompt: ClaudeCodeInput;
	/** Resolved `claude-code/{model-name}` suffix. */
	model: string;
	cwd: string;
	/** Native Claude conversation restored for a parked peer. */
	resume?: string;
	/** SDK-supported reasoning effort selected by common Task policy. */
	effort?: EffortLevel;
	/** `task.claudeCode.executable`, passed through as the Claude Code executable. */
	executable: string;
	/** Appended to Claude Code's own system prompt, which stays in force. */
	appendSystemPrompt?: string;
	/** Explicit base set of native Claude tools; absent retains Claude Code defaults. */
	tools?: string[];
	/** Native tools removed from the model's context. */
	disallowedTools: string[];
	/**
	 * Permission mode for the run. Typed to the single policy a delegated task
	 * peer may hold, so a change to it is a compile error rather than a silent
	 * downgrade: the SDK's default non-interactive mode denies MCP tools, which
	 * denies `mcp__omp__yield` and leaves the task unable to report a result.
	 */
	permissionMode: "bypassPermissions";
	/** Required by the SDK whenever `permissionMode` is `bypassPermissions`. */
	allowDangerouslySkipPermissions: true;
	mcpServer: ClaudeCodeMcpServer;
	abortController: AbortController;
}

/** The slice of the SDK message stream a task result and live evidence are built from. */
export type ClaudeCodeEvent =
	| { kind: "init"; model: string; tools: string[]; version: string; sessionId: string }
	| { kind: "assistant"; text?: string; tokens: number; requests: number }
	| { kind: "tool-progress"; toolUseId: string; toolName: string; elapsedSeconds: number }
	| { kind: "result"; isError: boolean; text: string; tokens: number; requests: number };

/** A started query: its event stream plus the teardown that stops the CLI. */
export interface ClaudeCodeQuery {
	events: AsyncIterable<ClaudeCodeEvent>;
	close(): void;
}

/** Port between the task runtime and the Claude Agent SDK. */
export type StartClaudeCodeQuery = (request: ClaudeCodeQueryRequest) => Promise<ClaudeCodeQuery>;

/** Narrow the SDK message union down to {@link ClaudeCodeEvent}. */
async function* mapSdkMessages(messages: AsyncIterable<SDKMessage>): AsyncGenerator<ClaudeCodeEvent> {
	for await (const message of messages) {
		if (message.type === "system" && message.subtype === "init") {
			yield {
				kind: "init",
				model: message.model,
				tools: [...message.tools],
				version: message.claude_code_version,
				sessionId: message.session_id,
			};
			continue;
		}
		if (message.type === "tool_progress") {
			yield {
				kind: "tool-progress",
				toolUseId: message.tool_use_id,
				toolName: message.tool_name,
				elapsedSeconds: message.elapsed_time_seconds,
			};
			continue;
		}
		if (message.type === "assistant") {
			const text = message.message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join("");
			const tokens = message.message.usage.input_tokens + message.message.usage.output_tokens;
			yield { kind: "assistant", ...(text ? { text } : {}), tokens, requests: 1 };
			continue;
		}
		if (message.type !== "result") continue;
		const tokens = message.usage.input_tokens + message.usage.output_tokens;
		yield message.subtype === "success"
			? { kind: "result", isError: message.is_error, text: message.result, tokens, requests: message.num_turns }
			: { kind: "result", isError: true, text: message.errors.join("\n"), tokens, requests: message.num_turns };
	}
}

/**
 * Build an in-process MCP server that advertises each native JSON Schema
 * unchanged. The transport validates the call envelope and object arguments;
 * the OMP handler owns all semantic validation and retry accounting.
 */
export function createClaudeCodeMcpServer(definition: ClaudeCodeMcpServer): McpSdkServerConfigWithInstance {
	const server = createSdkMcpServer({
		name: definition.name,
		instructions: definition.instructions,
	});
	server.instance.server.registerCapabilities({ tools: {} });
	server.instance.server.setRequestHandler(listToolsRequestSchema, () => ({
		tools: definition.tools.map(toolDefinition => ({
			name: toolDefinition.name,
			description: toolDefinition.description,
			inputSchema: toolDefinition.inputSchema,
		})),
	}));
	server.instance.server.setRequestHandler(callToolRequestSchema, async request => {
		const toolDefinition = definition.tools.find(candidate => candidate.name === request.params.name);
		if (!toolDefinition) {
			return {
				content: [{ type: "text" as const, text: `Unknown Claude MCP tool "${request.params.name}".` }],
				isError: true,
			};
		}
		const { content, isError } = await toolDefinition.handler(request.params.arguments);
		return { content, isError };
	});
	return server;
}

async function* mapSdkInput(input: AsyncIterable<string>): AsyncGenerator<SDKUserMessage> {
	for await (const text of input) {
		yield {
			type: "user",
			message: { role: "user", content: [{ type: "text", text }] },
			parent_tool_use_id: null,
			origin: { kind: "coordinator" },
			priority: "next",
			shouldQuery: true,
		};
	}
}

export const startClaudeCodeQuery: StartClaudeCodeQuery = async request => {
	const server = createClaudeCodeMcpServer(request.mcpServer);
	const started = query({
		prompt: typeof request.prompt === "string" ? request.prompt : mapSdkInput(request.prompt),
		options: {
			model: request.model,
			effort: request.effort,
			cwd: request.cwd,
			pathToClaudeCodeExecutable: request.executable,
			resume: request.resume,
			...(request.tools !== undefined ? { tools: request.tools } : {}),
			disallowedTools: request.disallowedTools,
			permissionMode: request.permissionMode,
			allowDangerouslySkipPermissions: request.allowDangerouslySkipPermissions,
			settingSources: [],
			mcpServers: { [request.mcpServer.name]: server },
			abortController: request.abortController,
			...(request.appendSystemPrompt
				? {
						systemPrompt: {
							type: "preset" as const,
							preset: "claude_code" as const,
							append: request.appendSystemPrompt,
						},
					}
				: {}),
		},
	});
	return { events: mapSdkMessages(started), close: () => started.close() };
};

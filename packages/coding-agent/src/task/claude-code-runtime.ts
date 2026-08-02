/**
 * Claude Agent SDK task runtime.
 *
 * Runs one synchronous `claude-code/{model-name}` task, exposes OMP Yield
 * through an in-process MCP tool, and returns the established Task result.
 * Claude Code keeps its coding tools while OMP supplies coordination.
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import claudeCodeSubagentPrompt from "../prompts/system/claude-code-subagent.md" with { type: "text" };
import claudeCodeYieldPrompt from "../prompts/tools/claude-code-yield.md" with { type: "text" };
import { type AgentRef, AgentRegistry } from "../registry/agent-registry";
import { truncateTail } from "../session/streaming-output";
import { resolveTaskEffortForSupportedLevels } from "../thinking";
import type { ToolSession } from "../tools";
import { YieldTool } from "../tools/yield";
import { ClaudeCodePeer } from "./claude-code-peer";
import {
	type ClaudeCodeEvent,
	type ClaudeCodeMcpTool,
	type ClaudeCodeQuery,
	type ClaudeCodeQueryRequest,
	type ClaudeCodeToolResult,
	isClaudeCodeMcpObjectSchema,
	type StartClaudeCodeQuery,
	startClaudeCodeQuery,
} from "./claude-code-sdk";
import {
	type ExecutorOptions,
	finalizeSubprocessResult,
	SUBAGENT_WARNING_MISSING_YIELD_WITHOUT_REMINDERS,
} from "./executor";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import {
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type YieldItem,
} from "./types";

/** In-process MCP server name; Claude sees the yield tool as `mcp__omp__yield`. */
export const OMP_MCP_SERVER_NAME = "omp";

/**
 * Native Claude coordination tools always denied to an OMP subagent. OMP owns
 * task spawning and peer messaging.
 */
export const CLAUDE_CODE_DENIED_TOOLS = ["Agent", "Task", "SendMessage"];

/** Explicit semantic mapping from OMP tools to Claude built-ins. */
const CLAUDE_CODE_NATIVE_TOOL_BY_OMP_NAME: Readonly<Partial<Record<string, string>>> = {
	read: "Read",
	grep: "Grep",
	glob: "Glob",
	web_search: "WebSearch",
	bash: "Bash",
	edit: "Edit",
	write: "Write",
};

/** OMP-owned coordination tools are denied rather than mapped to Claude peers. */
const OMP_COORDINATION_TOOL_NAMES: Readonly<Partial<Record<string, true>>> = {
	task: true,
	hub: true,
	irc: true,
	yield: true,
};

/** Resolve a nonempty OMP allowlist to Claude built-ins without widening it. */
function claudeCodeNativeTools(agentTools: readonly string[] | undefined): string[] | undefined {
	if (!agentTools?.length) return undefined;
	const tools: string[] = [];
	const unsupported = new Set<string>();
	for (const ompTool of agentTools) {
		const nativeTool = CLAUDE_CODE_NATIVE_TOOL_BY_OMP_NAME[ompTool];
		if (nativeTool) {
			if (!tools.includes(nativeTool)) tools.push(nativeTool);
		} else if (!OMP_COORDINATION_TOOL_NAMES[ompTool]) {
			unsupported.add(ompTool);
		}
	}
	if (unsupported.size > 0) {
		throw new Error(
			`Unsupported restricted OMP tools for Claude Code runtime: ${[...unsupported].sort().join(", ")}.`,
		);
	}
	return tools;
}

/**
 * Permission mode for a delegated Claude task peer.
 *
 * Task subagents run autonomously, so permission checks are bypassed. The
 * default non-interactive SDK mode denies `mcp__omp__yield`, which prevents the
 * peer from reporting its Task result.
 */
export const CLAUDE_CODE_PERMISSION_MODE = "bypassPermissions" as const;

/** The SDK requires this alongside {@link CLAUDE_CODE_PERMISSION_MODE}. */
export const CLAUDE_CODE_SKIP_PERMISSIONS = true as const;

const CLAUDE_CODE_EFFORTS = [
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
] as const satisfies readonly NonNullable<ClaudeCodeQueryRequest["effort"]>[];
/** Evidence emitted after a production-adapter run has released its one-shot peer. */
export interface ClaudeCodeRuntimeEvidence {
	agentId: string;
	init?: Extract<ClaudeCodeEvent, { kind: "init" }>;
	queryClosed: boolean;
	registryRefRemoved: boolean;
}

/** One Claude runtime task run. */
export interface ClaudeCodeSubprocessRequest {
	options: ExecutorOptions;
	/** Resolved `claude-code/{model-name}` suffix, handed to the SDK verbatim. */
	model: string;
	/** Injection seam: deterministic tests substitute a fake SDK query. */
	startQuery?: StartClaudeCodeQuery;
	/** Optional observation sink used by the live production-adapter probe. */
	onEvidence?: (evidence: ClaudeCodeRuntimeEvidence) => void;
}

/** The session fields {@link YieldTool} reads, supplied without a Pi session. */
function yieldToolSession(options: ExecutorOptions): ToolSession {
	return {
		cwd: options.cwd,
		hasUI: false,
		settings: options.settings ?? Settings.isolated(),
		outputSchema: options.outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

/** Text of an agent tool result, flattened for the MCP wire. */
function toolResultContent(content: { type: string; text?: string }[]): { type: "text"; text: string }[] {
	return content
		.filter(part => part.type === "text" && part.text !== undefined)
		.map(part => ({ type: "text" as const, text: part.text ?? "" }));
}

/**
 * Build the OMP yield MCP tool. The handler delegates to `yieldTool`, routes
 * its thrown retry guidance back to the model as a tool error, and reuses the
 * registered subprocess yield handler to extract the item and decide whether
 * the yield terminates the run.
 */
function buildYieldMcpTool(
	yieldTool: YieldTool,
	yieldItems: YieldItem[],
	onTerminalYield: () => void,
): ClaudeCodeMcpTool {
	const inputSchema = yieldTool.parameters;
	if (!isClaudeCodeMcpObjectSchema(inputSchema)) {
		throw new TypeError("OMP Yield parameters must be an object JSON Schema.");
	}
	const handler = subprocessToolRegistry.getHandler("yield");
	return {
		name: yieldTool.name,
		description: prompt.render(claudeCodeYieldPrompt, {
			description: yieldTool.description,
		}),
		inputSchema,
		handler: async (args): Promise<ClaudeCodeToolResult> => {
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
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					isError: true,
				};
			}
		},
	};
}

/** Resolve a stable task failure message. */
function failureMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Resolve the reason carried by a parent cancellation. */
function cancellationMessage(signal: AbortSignal | undefined): string {
	if (!signal) return "Subagent cancelled";
	return signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "Subagent cancelled");
}

/** Remove only the registration generation created by this one-shot run. */
function unregisterOwnRef(registry: AgentRegistry, ref: AgentRef): void {
	if (registry.get(ref.id) !== ref || ref.status === "aborted") return;
	registry.unregister(ref.id, ref);
}

/**
 * Run one task on the Claude Agent SDK runtime.
 *
 * SDK and stream failures are returned through the normal task result. The
 * exact pre-registered peer generation and its query are released on every
 * settled path.
 */
export async function runClaudeCodeSubprocess(request: ClaudeCodeSubprocessRequest): Promise<SingleResult> {
	const { options, model } = request;
	const nativeTools = claudeCodeNativeTools(options.agent.tools);
	const startQuery = request.startQuery ?? startClaudeCodeQuery;
	const startTime = Date.now();
	const settings = options.settings ?? Settings.isolated();
	const maxRuntimeMs = options.maxRuntimeMs ?? settings.get("task.maxRuntimeMs");
	const runtimeLimitReason = `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
	const registry = AgentRegistry.global();
	const abortController = new AbortController();
	const peer = new ClaudeCodePeer(options.task, abortController);
	const ref = registry.registerIfAvailable(
		{
			id: options.id,
			displayName: options.agent.name,
			kind: "sub",
			parentId: options.parentAgentId,
			session: peer,
			sessionFile: null,
			status: "running",
		},
		null,
	);
	if (!ref) {
		throw new Error(`Agent "${options.id}" is already owned by another session generation.`);
	}
	const yieldItems: YieldItem[] = [];
	const yieldTool = new YieldTool(yieldToolSession(options));
	const progress: AgentProgress = {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		status: "running",
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: options.modelOverride,
		resolvedModel: model,
	};
	let terminalYield = false;
	let runtimeLimitExceeded = false;
	let runtimeTimeout: NodeJS.Timeout | undefined;
	let parentAbortReason: string | undefined;
	let lastAssistantText: string | undefined;
	let rawOutput = "";
	let stderr = "";
	let exitCode = 0;
	let tokens = 0;
	let requests = 0;
	let init: Extract<ClaudeCodeEvent, { kind: "init" }> | undefined;
	let queryConstructed = false;
	let queryClosed = false;
	let queryCloseFailure: string | undefined;

	const observedToolUses = new Set<string>();
	const emitProgress = (): void => {
		progress.durationMs = Date.now() - startTime;
		const snapshot = {
			...progress,
			recentTools: progress.recentTools.slice(),
			recentOutput: progress.recentOutput.slice(),
		};
		options.onProgress?.(snapshot);
		options.eventBus?.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: options.index,
			agent: options.agent.name,
			agentSource: options.agent.source,
			task: options.task,
			parentToolCallId: options.parentToolCallId,
			detached: options.detached,
			assignment: options.assignment,
			progress: { ...snapshot },
			sessionFile: options.sessionFile,
		});
	};
	const emitLifecycle = (status: "started" | "completed" | "failed" | "aborted"): void => {
		options.eventBus?.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: options.id,
			agent: options.agent.name,
			parentToolCallId: options.parentToolCallId,
			detached: options.detached,
			agentSource: options.agent.source,
			description: options.description,
			status,
			sessionFile: options.sessionFile,
			index: options.index,
		});
	};
	const stopAfterTerminalYield = (): void => {
		terminalYield = true;
		clearTimeout(runtimeTimeout);
		void peer.abort().catch(() => {});
	};
	const cancel = (): void => {
		parentAbortReason = cancellationMessage(options.signal);
		void peer.abort({ reason: parentAbortReason }).catch(() => {});
	};

	if (maxRuntimeMs > 0) {
		runtimeTimeout = setTimeout(() => {
			if (terminalYield) return;
			runtimeLimitExceeded = true;
			void peer.abort({ reason: runtimeLimitReason }).catch(() => {});
		}, maxRuntimeMs);
		runtimeTimeout.unref?.();
	}
	options.signal?.addEventListener("abort", cancel, { once: true });
	if (options.signal?.aborted) cancel();

	const systemPromptAppend =
		prompt
			.render(claudeCodeSubagentPrompt, {
				system_prompt: options.agent.systemPrompt,
				context: options.context?.trim() || undefined,
			})
			.trim() || undefined;

	emitLifecycle("started");

	try {
		let query: ClaudeCodeQuery | undefined;
		if (abortController.signal.aborted) {
			exitCode = 1;
			stderr = runtimeLimitExceeded ? runtimeLimitReason : (parentAbortReason ?? "Subagent cancelled");
		} else {
			try {
				query = await startQuery({
					prompt: options.task,
					model,
					effort:
						options.effort === undefined
							? undefined
							: resolveTaskEffortForSupportedLevels(
									CLAUDE_CODE_EFFORTS,
									options.effort,
									settings.get("task.maxEffort"),
									"Claude Agent SDK",
								),
					cwd: options.cwd,
					executable: settings.get("task.claudeCode.executable") ?? "claude",
					appendSystemPrompt: systemPromptAppend,
					...(nativeTools !== undefined ? { tools: nativeTools } : {}),
					disallowedTools: [...CLAUDE_CODE_DENIED_TOOLS],
					permissionMode: CLAUDE_CODE_PERMISSION_MODE,
					allowDangerouslySkipPermissions: CLAUDE_CODE_SKIP_PERMISSIONS,
					mcpServer: {
						name: OMP_MCP_SERVER_NAME,
						tools: [buildYieldMcpTool(yieldTool, yieldItems, stopAfterTerminalYield)],
					},
					abortController,
				});
				queryConstructed = true;
			} catch (error) {
				exitCode = 1;
				stderr = runtimeLimitExceeded
					? runtimeLimitReason
					: options.signal?.aborted
						? (parentAbortReason ?? cancellationMessage(options.signal))
						: peer.abortState.aborted
							? (peer.abortState.reason ?? "Subagent cancelled")
							: failureMessage(error);
			}
		}

		if (query && !peer.attachQuery(query)) {
			exitCode = 1;
			stderr = runtimeLimitExceeded
				? runtimeLimitReason
				: options.signal?.aborted
					? (parentAbortReason ?? cancellationMessage(options.signal))
					: peer.abortState.aborted
						? (peer.abortState.reason ?? "Subagent cancelled")
						: `Agent "${options.id}" stopped while its Claude Code query was starting.`;
		} else if (query && !registry.attachSession(options.id, peer, null, ref)) {
			exitCode = 1;
			stderr = `Agent "${options.id}" was replaced or became terminal during Claude Code startup.`;
		} else if (query) {
			try {
				for await (const event of query.events) {
					if (event.kind === "init") {
						init = event;
						continue;
					}
					if (event.kind === "tool-progress") {
						if (!observedToolUses.has(event.toolUseId)) {
							observedToolUses.add(event.toolUseId);
							progress.toolCount++;
						}
						progress.currentTool = event.toolName;
						progress.currentToolArgs = "";
						progress.currentToolStartMs = Date.now() - event.elapsedSeconds * 1_000;
						registry.setActivity(options.id, `running ${event.toolName}`, ref);
						emitProgress();
						continue;
					}
					if (event.kind === "assistant") {
						tokens += event.tokens;
						requests += event.requests;
						progress.tokens = tokens;
						progress.requests = requests;
						if (!event.text) {
							if (terminalYield) break;
							continue;
						}
						progress.currentTool = undefined;
						progress.currentToolArgs = undefined;
						progress.currentToolStartMs = undefined;
						lastAssistantText = event.text;
						peer.recordAssistantText(event.text);
						registry.setActivity(options.id, event.text, ref);
						progress.recentOutput = event.text
							.split("\n")
							.filter(line => line.trim())
							.slice(-8)
							.reverse();
						emitProgress();
						if (terminalYield) break;
						continue;
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					progress.currentToolStartMs = undefined;
					rawOutput = event.text;
					tokens = event.tokens;
					requests = event.requests;
					if (event.isError && !terminalYield) {
						exitCode = 1;
						stderr = event.text;
					}
					break;
				}
			} catch (error) {
				if (!terminalYield) {
					exitCode = 1;
					stderr = runtimeLimitExceeded
						? runtimeLimitReason
						: options.signal?.aborted
							? (parentAbortReason ?? cancellationMessage(options.signal))
							: peer.abortState.aborted
								? (peer.abortState.reason ?? "Subagent cancelled")
								: failureMessage(error);
				}
			}
		}
	} finally {
		clearTimeout(runtimeTimeout);
		options.signal?.removeEventListener("abort", cancel);
		try {
			await peer.dispose();
		} catch (error) {
			exitCode = 1;
			stderr ||= failureMessage(error);
		}
		queryClosed = queryConstructed && peer.queryClosed;
		if (peer.queryCloseFailure) {
			queryCloseFailure = `Claude Code query close failed: ${failureMessage(peer.queryCloseFailure.error)}`;
			exitCode = 1;
			stderr = stderr ? `${stderr}\n${queryCloseFailure}` : queryCloseFailure;
		}
		unregisterOwnRef(registry, ref);
		request.onEvidence?.({
			agentId: options.id,
			init,
			queryClosed,
			registryRefRemoved: registry.get(options.id) !== ref,
		});
	}

	const signalAborted = options.signal?.aborted === true;
	const peerAbort = peer.abortState;
	const externalAbortReason = parentAbortReason ?? peerAbort.reason;
	const finalized = finalizeSubprocessResult({
		rawOutput: rawOutput || lastAssistantText || "",
		exitCode,
		stderr,
		doneAborted: signalAborted || peerAbort.aborted,
		signalAborted,
		yieldItems,
		outputSchema: options.outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		lastAssistantText,
		requireYield: true,
		missingYieldWarning: SUBAGENT_WARNING_MISSING_YIELD_WITHOUT_REMINDERS,
		doneAbortReason: externalAbortReason,
		signalAbortReason: externalAbortReason,
		runtimeLimitExceeded,
		runtimeLimitAbortReason: runtimeLimitReason,
		defaultAbortReason: externalAbortReason ?? "Subagent cancelled",
	});
	if (queryCloseFailure && !finalized.stderr.includes(queryCloseFailure)) {
		finalized.exitCode = 1;
		finalized.stderr = finalized.stderr ? `${finalized.stderr}\n${queryCloseFailure}` : queryCloseFailure;
	}
	const { content: output, truncated } = truncateTail(finalized.rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});
	progress.status = finalized.aborted ? "aborted" : finalized.exitCode === 0 ? "completed" : "failed";
	progress.tokens = tokens;
	progress.requests = requests;
	progress.extractedToolData = yieldItems.length > 0 ? { yield: yieldItems } : undefined;
	emitProgress();
	emitLifecycle(progress.status);

	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		description: options.description,
		exitCode: finalized.exitCode,
		output,
		stderr: finalized.stderr,
		truncated: Boolean(truncated),
		...(finalized.structuredOutput ? { structuredOutput: finalized.structuredOutput } : {}),
		durationMs: Date.now() - startTime,
		tokens,
		requests,
		modelOverride: options.modelOverride,
		resolvedModel: model,
		error: finalized.exitCode !== 0 && finalized.stderr ? finalized.stderr : undefined,
		aborted: finalized.aborted,
		abortReason: finalized.abortReason,
		extractedToolData: progress.extractedToolData,
	};
}

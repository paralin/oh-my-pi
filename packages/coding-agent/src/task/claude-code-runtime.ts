import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Claude Agent SDK task runtime.
 *
 * Starts a `claude-code/{model-name}` task, exposes OMP coordination through
 * an in-process MCP server, and retains the native query for later peer turns.
 * Claude Code keeps its coding tools while OMP owns coordination.
 */

import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import claudeCodeSubagentPrompt from "../prompts/system/claude-code-subagent.md" with { type: "text" };
import type { AgentReviver } from "../registry/agent-lifecycle";
import { AgentRegistry } from "../registry/agent-registry";
import { claudeTranscriptPath } from "../session/claude-session-store";
import type { ClaudeCodeSessionRuntime } from "../session/session-entries";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import { resolveTaskEffortForSupportedLevels } from "../thinking";
import { ClaudeCodePeer } from "./claude-code-peer";
import {
	type ClaudeCodeEvent,
	type ClaudeCodeQuery,
	type StartClaudeCodeQuery,
	startClaudeCodeQuery,
} from "./claude-code-sdk";
import { CLAUDE_CODE_EFFORTS, type ClaudeCodeSelection } from "./claude-code-selector";
import { CLAUDE_CODE_MCP_TOOL_NAMES, createClaudeCodeMcpTools } from "./claude-code-tools";
import {
	type ExecutorOptions,
	finalizeSubagentLifecycle,
	finalizeSubprocessResult,
	reapSubagentJobs,
	SUBAGENT_WARNING_MISSING_YIELD_WITHOUT_REMINDERS,
} from "./executor";
import {
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type YieldItem,
} from "./types";

/** In-process MCP server name; Claude sees its tools under `mcp__omp__*`. */
export const OMP_MCP_SERVER_NAME = "omp";

/**
 * Native Claude coordination tools always denied to an OMP subagent. OMP owns
 * task spawning and peer messaging.
 */
export const CLAUDE_CODE_DENIED_TOOLS = ["Agent", "Task", "SendMessage"];

/** Metadata policy understood by this runtime and its persisted reviver. */
export const CLAUDE_CODE_TOOL_POLICY_VERSION = 1;

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
	// Served over the same MCP bridge, so a restricted child that lists it is
	// asking for a tool it will actually be given rather than an unsupported
	// one. Whether it is advertised is still decided by configuration.
};

/** Resolve a nonempty OMP allowlist to Claude built-ins without widening it. */
export function claudeCodeNativeTools(agentTools: readonly string[] | undefined): string[] | undefined {
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
	/** Explicit provider effort parsed from the runtime selector. */
	effort?: ClaudeCodeSelection["effort"];
	/** Injection seam: deterministic tests substitute a fake SDK query. */
	startQuery?: StartClaudeCodeQuery;
	/** Optional observation sink used by the live production-adapter probe. */
	onEvidence?: (evidence: ClaudeCodeRuntimeEvidence) => void;
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

function validateClaudeCodeInit(
	event: Extract<ClaudeCodeEvent, { kind: "init" }>,
	expectedSessionId?: string,
): string | undefined {
	if (expectedSessionId && event.sessionId !== expectedSessionId) {
		return `Claude Code resumed session "${event.sessionId}" instead of "${expectedSessionId}".`;
	}
	const denied = CLAUDE_CODE_DENIED_TOOLS.filter(name => event.tools.includes(name));
	const missing = CLAUDE_CODE_MCP_TOOL_NAMES.filter(
		name => !event.tools.includes(`mcp__${OMP_MCP_SERVER_NAME}__${name}`),
	);
	return (
		[
			denied.length > 0 ? `Claude Code exposed denied tools: ${denied.join(", ")}.` : "",
			missing.length > 0 ? `Claude Code omitted required OMP tools: ${missing.join(", ")}.` : "",
		]
			.filter(Boolean)
			.join("\n") || undefined
	);
}

function persistedSpawns(options: ExecutorOptions): string {
	const spawns = options.agent.spawns;
	return spawns === "*" ? "*" : (spawns?.join(",") ?? "");
}

async function writeClaudeCodeSessionMetadata(
	file: string,
	options: ExecutorOptions,
	systemPrompt: string,
	runtime: ClaudeCodeSessionRuntime,
): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const manager = await SessionManager.open(file, undefined, undefined, {
		initialCwd: runtime.cwd,
		suppressBreadcrumb: true,
	});
	try {
		manager.appendSessionInit({
			systemPrompt,
			task: options.task,
			tools: options.agent.tools ?? [],
			spawns: persistedSpawns(options),
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			restrictToolNames: options.restrictToolNames || undefined,
			runtime,
		});
		await manager.flush();
	} finally {
		await manager.close();
	}
}

export interface ClaudeCodePeerReviverRequest {
	options: ExecutorOptions;
	nativeSession: ClaudeCodeSessionRuntime;
	appendSystemPrompt: string;
	effort?: ClaudeCodeSelection["effort"];
	startQuery?: StartClaudeCodeQuery;
}

/** Build a reviver that resumes the exact native Claude conversation. */
export function createClaudeCodePeerReviver(request: ClaudeCodePeerReviverRequest): AgentReviver {
	return async expectedRef => {
		const { nativeSession, options } = request;
		if (nativeSession.toolPolicyVersion !== CLAUDE_CODE_TOOL_POLICY_VERSION) {
			throw new Error(
				`Claude Code session "${nativeSession.sessionId}" uses unsupported tool policy version ${nativeSession.toolPolicyVersion}.`,
			);
		}
		try {
			await fs.stat(nativeSession.cwd);
		} catch {
			throw new Error(
				`Claude Code session "${nativeSession.sessionId}" cannot be revived because cwd "${nativeSession.cwd}" is unavailable.`,
			);
		}
		try {
			await fs.stat(nativeSession.transcriptPath);
		} catch {
			throw new Error(
				`Claude Code session "${nativeSession.sessionId}" cannot be revived because transcript "${nativeSession.transcriptPath}" is unavailable.`,
			);
		}

		const registry = AgentRegistry.global();
		const abortController = new AbortController();
		const peer = new ClaudeCodePeer({
			id: options.id,
			abortController,
			registry,
			asyncJobManager: options.asyncJobManager,
			nativeSession,
		});
		peer.bindRef(expectedRef);
		try {
			const yieldItems: YieldItem[] = [];
			const mcpTools = await createClaudeCodeMcpTools({
				executor: options,
				registry,
				signal: abortController.signal,
				yieldItems,
				onTerminalYield: () => {},
			});
			const nativeTools = claudeCodeNativeTools(options.agent.tools);
			const query = await (request.startQuery ?? startClaudeCodeQuery)({
				prompt: peer.input,
				resume: nativeSession.sessionId,
				model: nativeSession.model,
				cwd: nativeSession.cwd,
				effort: request.effort,
				executable: (options.settings ?? Settings.isolated()).get("task.claudeCode.executable") ?? "claude",
				appendSystemPrompt: request.appendSystemPrompt,
				...(nativeTools !== undefined ? { tools: nativeTools } : {}),
				disallowedTools: [...CLAUDE_CODE_DENIED_TOOLS],
				permissionMode: CLAUDE_CODE_PERMISSION_MODE,
				allowDangerouslySkipPermissions: CLAUDE_CODE_SKIP_PERMISSIONS,
				mcpServer: {
					name: OMP_MCP_SERVER_NAME,
					tools: mcpTools,
				},
				abortController,
			});
			if (!peer.attachQuery(query)) {
				throw new Error(`Agent "${options.id}" stopped while its Claude Code query was resuming.`);
			}
			const eventPump = (async (): Promise<void> => {
				try {
					for await (const event of query.events) {
						if (event.kind === "init") {
							const invalid = validateClaudeCodeInit(event, nativeSession.sessionId);
							if (invalid) throw new Error(invalid);
						} else if (event.kind === "tool-progress") {
							registry.setActivity(options.id, `running ${event.toolName}`, expectedRef);
						} else if (event.kind === "assistant") {
							if (event.text) {
								peer.recordAssistantText(event.text);
								registry.setActivity(options.id, event.text, expectedRef);
							}
						} else {
							peer.completeTurn();
						}
					}
					await peer.abort({ reason: "Claude Code query ended unexpectedly." });
				} catch (error) {
					if (!peer.abortState.aborted) await peer.abort({ reason: failureMessage(error) });
				}
			})();
			peer.attachEventPump(eventPump);
			return peer;
		} catch (error) {
			await peer.dispose();
			throw error;
		}
	};
}

/**
 * Run one task on the Claude Agent SDK runtime.
 *
 * SDK and stream failures are returned through the normal task result. One-shot
 * and isolated peers close on settlement; retained peers remain under
 * AgentLifecycleManager custody.
 */
export async function runClaudeCodeSubprocess(request: ClaudeCodeSubprocessRequest): Promise<SingleResult> {
	const { options, model } = request;
	const cwd = options.worktree ?? options.cwd;
	const nativeTools = claudeCodeNativeTools(options.agent.tools);
	const startQuery = request.startQuery ?? startClaudeCodeQuery;
	const startTime = Date.now();
	const settings = options.settings ?? Settings.isolated();
	const maxRuntimeMs = options.maxRuntimeMs ?? settings.get("task.maxRuntimeMs");
	const keepAlive = options.keepAlive !== false;
	const isolated = options.worktree !== undefined;
	const retainLive = keepAlive && !isolated;
	const metadataSessionFile =
		retainLive && options.persistArtifacts && options.artifactsDir
			? path.join(options.artifactsDir, `${options.id}.jsonl`)
			: undefined;
	const runtimeLimitReason = `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
	const registry = AgentRegistry.global();
	const abortController = new AbortController();
	const peer = new ClaudeCodePeer({
		id: options.id,
		prompt: options.task,
		abortController,
		registry,
		asyncJobManager: options.asyncJobManager,
	});
	const ref = registry.registerIfAvailable(
		{
			id: options.id,
			displayName: options.description ?? options.agent.name,
			kind: "sub",
			parentId: options.parentAgentId,
			session: peer,
			sessionFile: metadataSessionFile ?? null,
			status: "running",
		},
		null,
	);
	if (!ref) {
		await peer.dispose();
		throw new Error(`Agent "${options.id}" is already owned by another session generation.`);
	}
	peer.bindRef(ref);
	options.onAdmission?.({
		id: options.id,
		name: options.id,
		sessionDir: metadataSessionFile ? path.dirname(metadataSessionFile) : (options.artifactsDir ?? cwd),
		...(metadataSessionFile ? { sessionFile: metadataSessionFile } : {}),
		model: `claude-code/${model}`,
		cwd,
	});
	const yieldItems: YieldItem[] = [];
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
	const agentIdleTtlMs = Math.trunc(Number(settings.get("task.agentIdleTtlMs") ?? 420_000) || 0);
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
	let nativeSession: ClaudeCodeSessionRuntime | undefined;
	let queryConstructed = false;
	let queryClosed = false;
	let queryCloseFailure: string | undefined;
	let eventStreamEnded = false;
	let startupRejected = false;
	let initialTurnSettled = false;
	const initialTurn = Promise.withResolvers<void>();
	const settleInitialTurn = (): void => {
		if (initialTurnSettled) return;
		initialTurnSettled = true;
		initialTurn.resolve();
	};

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
			status,
			sessionFile: options.sessionFile,
			index: options.index,
		});
	};
	const stopAfterTerminalYield = (): void => {
		terminalYield = true;
		clearTimeout(runtimeTimeout);
		if (!retainLive) void peer.dispose().catch(() => {});
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
				const mcpTools = await createClaudeCodeMcpTools({
					executor: options,
					registry,
					signal: abortController.signal,
					yieldItems,
					onTerminalYield: stopAfterTerminalYield,
				});
				query = await startQuery({
					prompt: peer.input,
					model,
					effort:
						options.effort === undefined
							? request.effort
							: resolveTaskEffortForSupportedLevels(
									CLAUDE_CODE_EFFORTS,
									options.effort,
									settings.get("task.maxEffort"),
									"Claude Agent SDK",
								),
					cwd,
					executable: settings.get("task.claudeCode.executable") ?? "claude",
					appendSystemPrompt: systemPromptAppend,
					...(nativeTools !== undefined ? { tools: nativeTools } : {}),
					disallowedTools: [...CLAUDE_CODE_DENIED_TOOLS],
					permissionMode: CLAUDE_CODE_PERMISSION_MODE,
					allowDangerouslySkipPermissions: CLAUDE_CODE_SKIP_PERMISSIONS,
					mcpServer: {
						name: OMP_MCP_SERVER_NAME,
						tools: mcpTools,
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
			startupRejected = true;
			exitCode = 1;
			stderr = runtimeLimitExceeded
				? runtimeLimitReason
				: options.signal?.aborted
					? (parentAbortReason ?? cancellationMessage(options.signal))
					: peer.abortState.aborted
						? (peer.abortState.reason ?? "Subagent cancelled")
						: `Agent "${options.id}" stopped while its Claude Code query was starting.`;
		} else if (query && !registry.attachSession(options.id, peer, metadataSessionFile ?? null, ref)) {
			startupRejected = true;
			exitCode = 1;
			stderr = `Agent "${options.id}" was replaced or became terminal during Claude Code startup.`;
		} else if (query) {
			const eventPump = (async (): Promise<void> => {
				try {
					for await (const event of query.events) {
						if (event.kind === "init") {
							init = event;
							const invalid = validateClaudeCodeInit(event);
							if (invalid) {
								startupRejected = true;
								exitCode = 1;
								stderr = invalid;
								abortController.abort(new Error(stderr));
								settleInitialTurn();
								return;
							}
							nativeSession = {
								kind: "claude-code",
								sessionId: event.sessionId,
								cwd,
								transcriptPath: claudeTranscriptPath(cwd, event.sessionId),
								model,
								...(request.effort ? { effort: request.effort } : {}),
								toolPolicyVersion: CLAUDE_CODE_TOOL_POLICY_VERSION,
							};
							peer.setNativeSession(nativeSession);
							if (metadataSessionFile) {
								await writeClaudeCodeSessionMetadata(
									metadataSessionFile,
									options,
									systemPromptAppend ?? "",
									nativeSession,
								);
							}
							continue;
						}
						if (event.kind === "tool-progress") {
							if (!initialTurnSettled && !observedToolUses.has(event.toolUseId)) {
								observedToolUses.add(event.toolUseId);
								progress.toolCount++;
							}
							progress.currentTool = event.toolName;
							progress.currentToolArgs = "";
							progress.currentToolStartMs = Date.now() - event.elapsedSeconds * 1_000;
							registry.setActivity(options.id, `running ${event.toolName}`, ref);
							if (!initialTurnSettled) emitProgress();
							continue;
						}
						if (event.kind === "assistant") {
							if (!initialTurnSettled) {
								tokens += event.tokens;
								requests += event.requests;
								progress.tokens = tokens;
								progress.requests = requests;
							}
							if (!event.text) continue;
							progress.currentTool = undefined;
							progress.currentToolArgs = undefined;
							progress.currentToolStartMs = undefined;
							if (!initialTurnSettled) lastAssistantText = event.text;
							peer.recordAssistantText(event.text);
							registry.setActivity(options.id, event.text, ref);
							if (!initialTurnSettled) {
								progress.recentOutput = event.text
									.split("\n")
									.filter(line => line.trim())
									.slice(-8)
									.reverse();
								emitProgress();
							}
							continue;
						}
						progress.currentTool = undefined;
						progress.currentToolArgs = undefined;
						progress.currentToolStartMs = undefined;
						if (!initialTurnSettled) {
							rawOutput = event.text;
							tokens = event.tokens;
							requests = event.requests;
							if (event.isError && !terminalYield) {
								exitCode = 1;
								stderr = event.text;
							}
						}
						observedToolUses.clear();
						peer.completeTurn();
						settleInitialTurn();
					}
					eventStreamEnded = true;
					if (!initialTurnSettled) {
						if (!terminalYield) {
							exitCode = 1;
							stderr = "Claude Code query ended unexpectedly.";
						}
						peer.completeTurn();
						settleInitialTurn();
					} else if (!peer.abortState.aborted) {
						await peer.abort({ reason: "Claude Code query ended unexpectedly." });
					}
				} catch (error) {
					eventStreamEnded = true;
					if (!initialTurnSettled) {
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
						peer.completeTurn();
						settleInitialTurn();
					} else if (!peer.abortState.aborted) {
						void peer.abort({ reason: failureMessage(error) }).catch(() => {});
					}
				}
			})();
			peer.attachEventPump(eventPump);
			await initialTurn.promise;
		}
	} finally {
		clearTimeout(runtimeTimeout);
		options.signal?.removeEventListener("abort", cancel);
		const hardAborted = options.signal?.aborted === true || peer.abortState.aborted || runtimeLimitExceeded;
		const lifecycleKeepAlive =
			keepAlive &&
			terminalYield &&
			queryConstructed &&
			nativeSession !== undefined &&
			!eventStreamEnded &&
			!startupRejected &&
			!hardAborted;
		const retainsLive = lifecycleKeepAlive && !isolated;
		const reviveSession = nativeSession
			? createClaudeCodePeerReviver({
					options: { ...options, signal: undefined, keepAlive: true },
					nativeSession,
					appendSystemPrompt: systemPromptAppend ?? "",
					startQuery,
					effort: request.effort,
				})
			: null;
		try {
			await finalizeSubagentLifecycle({
				id: options.id,
				session: peer,
				aborted: hardAborted,
				keepAlive: lifecycleKeepAlive,
				isolated,
				agentIdleTtlMs,
				reviveSession,
				markIdle: peer.turnIdle,
			});
		} catch (error) {
			exitCode = 1;
			stderr ||= failureMessage(error);
		}
		if (!retainsLive && options.asyncJobManager) {
			await reapSubagentJobs(options.asyncJobManager, options.id);
		}
		queryClosed = queryConstructed && peer.queryClosed;
		if (peer.queryCloseFailure) {
			queryCloseFailure = `Claude Code query close failed: ${failureMessage(peer.queryCloseFailure.error)}`;
			exitCode = 1;
			stderr = stderr ? `${stderr}\n${queryCloseFailure}` : queryCloseFailure;
		}
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

/**
 * In-process execution for subagents.
 *
 * Runs each subagent on the main thread and forwards AgentEvents for progress tracking.
 */

import path from "node:path";
import type { AgentEvent, AgentIdentity, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { recordHandoff, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ServiceTierByFamily, Usage } from "@oh-my-pi/pi-ai";
import { logger, popLoopPhase, prompt, pushLoopPhase, untilAborted } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import type { Rule } from "../capability/rule";
import { ModelRegistry } from "../config/model-registry";
import {
	formatModelSelectorValue,
	formatModelStringWithRouting,
	resolveConfiguredModelPatterns,
	resolveExplicitModelRole,
	resolveModelOverride,
	resolveModelOverrideWithAuthFallback,
} from "../config/model-resolver";
import type { PromptTemplate } from "../config/prompt-templates";
import { buildServiceTierByFamily, resolveSubagentServiceTier } from "../config/service-tier";
import { Settings } from "../config/settings";
import { SETTINGS_SCHEMA, type SettingPath } from "../config/settings-schema";
import type { CoordinationBackend } from "../coordination/backend";
import { runExtensionCompact, runExtensionSetModel } from "../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import { buildSkillPromptMessage, type Skill } from "../extensibility/skills";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp/manager";
import type { MnemopiSessionState } from "../mnemopi/state";
import subagentSystemPromptTemplate from "../prompts/system/subagent-system-prompt.md" with { type: "text" };
import { AgentLifecycleManager, type AgentReviver } from "../registry/agent-lifecycle";
import { type AgentPeer, AgentRegistry } from "../registry/agent-registry";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "../sdk";
import { type AgentSession, type AgentSessionEvent, isAgentSession } from "../session/agent-session";
import type { ArtifactManager } from "../session/artifacts";
import type { AuthStorage } from "../session/auth-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../session/messages";
import { SessionManager } from "../session/session-manager";
import { truncateTail } from "../session/streaming-output";
import type { ContextFileEntry } from "../session/tool-session";
import { type ConfiguredThinkingLevel, resolveTaskEffortLevel, type TaskEffort } from "../thinking";
import { isIrcEnabled } from "../tools/hub";
import { normalizeSchema } from "../tools/jtd-to-json-schema";
import { buildOutputValidator, summarizeValidationFailure } from "../tools/output-schema-validator";
import { ToolAbortError } from "../tools/tool-errors";
import type { EventBus } from "../utils/event-bus";
import { trackLateCleanup } from "../utils/late-cleanup";
import type { WorkspaceTree } from "../workspace-tree";
import type { SubagentRuntimeAdmission } from "./admission";
import { generateTaskLabel } from "./label";
import { isReadOnlyAgent } from "./read-only-policy";
import {
	type AgentDefinition,
	type AgentProgress,
	MAX_OUTPUT_BYTES,
	MAX_OUTPUT_LINES,
	type SingleResult,
	type StructuredSubagentOutput,
	type StructuredSubagentSchemaMode,
	type StructuredSubagentSchemaSource,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type YieldItem,
} from "./types";
import { arrayValuedLabels, assembleYieldResult } from "./yield-assembly";

export type { YieldItem } from "./types";

const TASK_ABORT_CLEANUP_GRACE_MS = 10_000;

/**
 * Soft per-agent request budgets (assistant requests per run). Crossing the
 * budget injects a wrap-up steering notice (`task.softRequestBudgetNotice`,
 * on by default); at 1.5x the budget the run is aborted. Entries are ceilings,
 * not fixed values: the `default` key applies to agents without an explicit
 * entry, and `task.softRequestBudget` can only lower an agent's budget (0
 * disables the guard entirely).
 */
export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

/**
 * Resolves the effective soft request budget for an agent. The configured
 * `task.softRequestBudget` and the agent's bundled entry are both upper
 * bounds, so the tighter one wins; a configured budget of 0 disables the
 * guard regardless of the bundled entry.
 */
export function resolveSoftRequestBudget(agentName: string, configuredBudget: number): number {
	const normalized = Math.max(0, Math.trunc(configuredBudget));
	if (normalized === 0) return 0;
	return Math.min(normalized, SOFT_REQUEST_BUDGET[agentName] ?? normalized);
}

/** Steering notice injected when a subagent crosses its soft request budget. */
export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and return your final response. At ${Math.ceil(budget * 1.5)} requests the run is stopped.`;
}

/** Flatten whitespace and clip salvage text for the cancelled-child summary line. */
function formatSalvageSnippet(text: string, maxLength = 500): string {
	const flattened = text.replace(/\s+/g, " ").trim();
	return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened;
}

/** Agent event types to forward for progress tracking. */
const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

interface SubagentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

function resolveSubagentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): SubagentRetryFallbackCandidate[] {
	const candidates: SubagentRetryFallbackCandidate[] = [];
	const seen = new Set<string>();
	const disabledProviders = new Set(settings.get("disabledProviders"));
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		if (disabledProviders.has(resolved.model.provider)) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

function resolveSubagentDefaultRetryFallbackChain(
	settings: Settings,
	modelRegistry: ModelRegistry,
): string[] | undefined {
	const fallbackChain = settings.get("retry.fallbackChains")?.default;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}
	const disabledProviders = new Set(settings.get("disabledProviders"));
	return fallbackChain.filter(entry => {
		const resolved = resolveModelOverride([entry], modelRegistry, settings);
		return !resolved.model || !disabledProviders.has(resolved.model.provider);
	});
}

function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	defaultFallbackChain: string[] | undefined;
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
}): string | undefined {
	const { settings, id, candidates, defaultFallbackChain, model, authFallbackUsed } = args;
	if (!model || authFallbackUsed || candidates.length === 0) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	const existingFallbackChains = settings.get("retry.fallbackChains");
	// A single explicit model may reuse a configured default chain, but never an implicit parent fallback.
	const fallbackChain = fallbackSelectors.length > 0 ? fallbackSelectors : defaultFallbackChain;
	if (
		!Array.isArray(fallbackChain) ||
		fallbackChain.length === 0 ||
		!fallbackChain.every(entry => typeof entry === "string")
	) {
		return undefined;
	}

	const role = `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) {
			modelRoles[existingRole] = selector;
		}
	}
	modelRoles[role] = candidates[selectedIndex].selector;
	settings.override("modelRoles", modelRoles);
	// Insert the task-specific role first so another role assigned to the same model cannot capture fallback routing.
	const fallbackChains: Record<string, string[]> = {
		[role]: fallbackChain,
	};
	for (const existingRole in existingFallbackChains) {
		if (existingRole !== role) {
			fallbackChains[existingRole] = existingFallbackChains[existingRole];
		}
	}
	settings.override("retry.fallbackChains", fallbackChains);
	return role;
}

function renderIrcPeerRoster(selfId: string): string {
	const peers = AgentRegistry.global()
		.list()
		.filter(ref => ref.id !== selfId && ref.status !== "aborted" && ref.kind !== "advisor");
	if (peers.length === 0) return "- (no other agents)";
	const lines = peers.map(
		peer =>
			`- \`${peer.id}\` — ${peer.displayName} (${peer.kind}, ${peer.status})${peer.activity ? `: ${peer.activity}` : ""}`,
	);
	if (peers.some(peer => peer.status === "idle" || peer.status === "parked")) {
		lines.push("Idle/parked peers are not gone: messaging them wakes (or revives) them.");
	}
	return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object") return false;
	return !Array.isArray(value);
}

/** Options for subagent execution */
export interface ExecutorOptions {
	cwd: string;
	/** Additional workspace directories to seed on the subagent session (multi-root). */
	additionalDirectories?: string[];
	/** Exact provider credential resolver inherited from the parent session. */
	getApiKey?: CreateAgentSessionOptions["getApiKey"];
	worktree?: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	/** Shared background from the task call (`task.batch`), rendered into the subagent's system prompt. */
	context?: string;
	/** Pre-set UI label. When absent, a tiny-model label is generated from the assignment. */
	description?: string;
	index: number;
	id: string;
	parentToolCallId?: string;
	/**
	 * Spawn runs as a detached background job (parent turn not blocked on it).
	 * Rides the subagent lifecycle/progress payloads so HUD-style surfaces can
	 * skip spawns the transcript already renders inline. See
	 * {@link SubagentLifecyclePayload.detached}.
	 */
	detached?: boolean;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	/**
	 * Active model selector of the parent session, used as an auth-aware fallback
	 * if the resolved subagent model has no working credentials. See #985.
	 */
	parentActiveModelPattern?: string;
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Caller-requested coarse effort (`lo`/`med`/`hi`); maps onto the resolved model's supported thinking range and wins over {@link thinkingLevel}. */
	effort?: TaskEffort;
	/** Schema used to validate the final structured completion. */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Origin of the selected schema, preserved in {@link SingleResult.structuredOutput}. */
	outputSchemaSource?: StructuredSubagentSchemaSource;
	/**
	 * Caller supplied a schema that supersedes the agent's native output prompt.
	 * A caller schema supersedes the built-in agent output shape.
	 */
	outputSchemaOverridesAgent?: boolean;
	/** Parent task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/**
	 * Override the `task.maxRuntimeMs` wall-clock cap for this run. When provided
	 * it wins over the settings value; `0` disables the per-subagent wall-clock
	 * limit entirely.
	 */
	maxRuntimeMs?: number;
	/** Include IRC only when the invocation policy permits collaboration. */
	enableIrc?: boolean;
	enableLsp?: boolean;
	/**
	 * Enable MCP capabilities for this child. `false` suppresses inherited MCP
	 * manager access and session MCP discovery; it never consults the
	 * process-global MCP manager. Defaults to `true`.
	 */
	enableMCP?: boolean;
	/** Restrict the native Claude Code protocol to its selected tools; ignored by OMP IPython sessions. */
	restrictToolNames?: boolean;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	/** Receives the child provider-session identity after session creation. */
	onSessionCreated?: (providerSessionId: string) => void;
	/**
	 * Epochs (ms, `Date.now()`) bracketing the concurrency-semaphore wait:
	 * `invokedAt` is stamped at the spawn boundary before `acquire()`,
	 * `acquiredAt` immediately after. {@link runSubprocess} reports true queue
	 * wait (`acquiredAt - invokedAt`) and pre-run setup (`startTime - acquiredAt`)
	 * separately in the launch-timing debug log. Undefined for callers that
	 * bypass the semaphore path.
	 */
	invokedAt?: number;
	acquiredAt?: number;
	sessionFile?: string | null;
	persistArtifacts?: boolean;
	artifactsDir?: string;
	eventBus?: EventBus;
	contextFiles?: ContextFileEntry[];
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	workspaceTree?: WorkspaceTree;
	/** Parent-discovered rules, forwarded to skip rule discovery in the subagent. */
	rules?: Rule[];
	/**
	 * Parent's discovered extension source paths. Forwarded to skip the
	 * extension FS scan in the subagent; the subagent then re-binds each
	 * extension against its own `ExtensionAPI` (cwd, eventBus, runtime).
	 */
	preloadedExtensionPaths?: string[];
	/** Parent-authorized extension entrypoints active for a restricted child. */
	restrictedExtensionPaths?: string[];
	mcpManager?: MCPManager;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	/** Root-scoped Task and Hub coordination inherited without reconstruction. */
	coordinationBackend?: CoordinationBackend;
	settings?: Settings;
	/** Scoped job owner inherited by nested Task and Hub tools. */
	asyncJobManager?: AsyncJobManager;
	/**
	 * Parent session's live per-family service tiers, the source of truth for a
	 * subagent whose `tier.subagent` is `"inherit"`. `null` = the parent
	 * explicitly has no tier (e.g. `/fast off`); omitted = no live session, so
	 * inherit falls back to the subagent's configured `tier.*` settings.
	 */
	parentServiceTier?: ServiceTierByFamily | null;
	/** Override local:// protocol options so subagent shares parent's local:// root */
	localProtocolOptions?: LocalProtocolOptions;
	/**
	 * Parent session's ArtifactManager. Subagent adopts it so artifact IDs are
	 * unique across the whole agent tree and all artifacts land in the parent's
	 * artifacts directory (no per-subagent subdir).
	 */
	parentArtifactManager?: ArtifactManager;
	parentHindsightSessionState?: HindsightSessionState;
	parentMnemopiSessionState?: MnemopiSessionState;
	/**  */
	/**
	 * Parent agent's OpenTelemetry configuration. When defined, the subagent's
	 * loop is started with the same tracer/hooks but its own agent identity
	 * stamped, so its `invoke_agent` / `chat` / `execute_tool` spans appear as
	 * a sub-tree under the parent's active `execute_tool task` span. A
	 * `handoff` span is emitted on dispatch to mark the parent → subagent
	 * transition explicitly.
	 */
	parentTelemetry?: AgentTelemetryConfig;
	/** Skills to autoload via sendCustomMessage before the first prompt */
	autoloadSkills?: Skill[];
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent.
	 * Forwarded verbatim to the SDK; the executor never derives it (the spawner
	 * passes its own `getAgentId()`).
	 */
	parentAgentId?: string;
	/**
	 * Keep the finished subagent addressable in the registry for IRC/revival.
	 * Defaults to true; false unregisters the agent after disposal.
	 */
	keepAlive?: boolean;
	/** Called once after the child session is registered and before its first prompt is dispatched. */
	onAdmission?: (admission: SubagentRuntimeAdmission) => void;
	/** Internal ownership handoff for cleanup that outlives the visible Task result. */
	onCleanupDeferred?: (completion: Promise<void>) => void;
}

/** Cancel and await every asynchronous job owned by a settling subagent run. */
export async function reapSubagentJobs(manager: AsyncJobManager, id: string): Promise<void> {
	manager.cancelAll({ ownerId: id });
	while (!(await manager.waitForOwnerJobs(id, { timeoutMs: 10_000 }))) {
		logger.warn("Subagent async jobs still settling; delaying teardown until process exit", { id });
	}
}

function parseStringifiedJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
	try {
		return JSON.parse(trimmed);
	} catch {
		return value;
	}
}

function previewOffendingData(value: unknown, maxLength = 500): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(value) ?? "null";
	} catch {
		serialized = String(value);
	}
	return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
}

function tryParseJsonOutput(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function extractCompletionData(parsed: unknown): unknown {
	if (!parsed || typeof parsed !== "object") return parsed;
	const record = parsed as Record<string, unknown>;
	if ("data" in record) {
		return record.data;
	}
	return parsed;
}

function resolveFallbackCompletion(rawOutput: string, outputSchema: unknown): { data: unknown } | null {
	const parsed = tryParseJsonOutput(rawOutput);
	if (parsed === undefined) return null;
	const candidate = parseStringifiedJson(extractCompletionData(parsed));
	if (candidate === undefined) return null;
	const { validator, error } = buildOutputValidator(outputSchema);
	if (error) return null;
	if (validator && !validator.validate(candidate).success) return null;
	return { data: candidate };
}

export interface FinalizeSubprocessOutputArgs {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	doneAborted: boolean;
	signalAborted: boolean;
	yieldItems?: YieldItem[];
	outputSchema: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	lastAssistantText?: string;
	/** Require an explicit Yield even when the terminal text matches the schema. */
	requireYield?: boolean;
	/** Missing-Yield warning for runtimes with a different reminder policy. */
	missingYieldWarning?: string;
}

export interface FinalizeSubprocessOutputResult {
	rawOutput: string;
	exitCode: number;
	stderr: string;
	abortedViaYield: boolean;
	hasYield: boolean;
	structuredOutput?: StructuredSubagentOutput;
}
export const SUBAGENT_WARNING_SCHEMA_OVERRIDDEN =
	"SYSTEM WARNING: Subagent exhausted schema-retry budget; result was accepted despite failing the output schema.";
export const SUBAGENT_WARNING_NULL_YIELD = "SYSTEM WARNING: Subagent called yield with null data.";
export const SUBAGENT_WARNING_MISSING_YIELD =
	"SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.";
export const SUBAGENT_WARNING_MISSING_YIELD_WITHOUT_REMINDERS =
	"SYSTEM WARNING: Subagent exited without calling yield tool.";
export const SUBAGENT_WARNING_MISSING_OUTPUT = "SYSTEM WARNING: Subagent exited without a final assistant response.";

/** Build a schema_violation outcome — surfaced as a non-zero exit so callers treat it as a failure. */
function buildSchemaViolationOutcome(
	failure: { message: string; missingRequired: string[] },
	data: unknown,
): { rawOutput: string; stderr: string; exitCode: number } {
	const missing = failure.missingRequired;
	const headline =
		missing.length > 0
			? `schema_violation: missing required fields: ${missing.join(", ")}`
			: `schema_violation: ${failure.message}`;
	const payload = {
		error: "schema_violation",
		message: failure.message,
		missingRequired: missing,
		data: previewOffendingData(data),
	};
	let rawOutput: string;
	try {
		rawOutput = JSON.stringify(payload, null, 2);
	} catch {
		rawOutput = `{"error":"schema_violation","message":${JSON.stringify(headline)}}`;
	}
	return { rawOutput, stderr: headline, exitCode: 1 };
}

export function finalizeSubprocessOutput(args: FinalizeSubprocessOutputArgs): FinalizeSubprocessOutputResult {
	let { rawOutput, exitCode, stderr } = args;
	const { yieldItems, doneAborted, signalAborted, outputSchema, lastAssistantText, requireYield = false } = args;
	const mode = args.outputSchemaMode ?? "permissive";
	const source = args.outputSchemaSource ?? (outputSchema === undefined ? "none" : "session");
	const includeStructuredOutput = source !== "none";
	let structuredOutput: StructuredSubagentOutput | undefined;
	let abortedViaYield = false;
	const hasYield = Array.isArray(yieldItems) && yieldItems.length > 0;
	const hadFailureBeforeYield = exitCode !== 0 && stderr.trim().length > 0;

	if (hasYield) {
		const lastYield = yieldItems[yieldItems.length - 1];
		if (lastYield?.status === "aborted") {
			abortedViaYield = true;
			exitCode = 0;
			stderr = lastYield.error || "Subagent aborted task";
			try {
				rawOutput = JSON.stringify({ aborted: true, error: lastYield.error }, null, 2);
			} catch {
				rawOutput = `{"aborted":true,"error":"${lastYield.error || "Unknown error"}"}`;
			}
		} else {
			const assembled = assembleYieldResult(yieldItems, lastAssistantText, arrayValuedLabels(outputSchema));
			if (!assembled || assembled.missingData) {
				rawOutput = rawOutput ? `${SUBAGENT_WARNING_NULL_YIELD}\n\n${rawOutput}` : SUBAGENT_WARNING_NULL_YIELD;
			} else {
				const { validator, error: schemaError, normalized } = buildOutputValidator(outputSchema);
				const completeData = assembled.rawText ? assembled.data : parseStringifiedJson(assembled.data ?? null);
				const validation = validator?.validate(completeData);
				const failure =
					validation && !validation.success
						? summarizeValidationFailure(validation, completeData, validator?.requiredFields ?? [])
						: assembled.schemaOverridden
							? {
									message: SUBAGENT_WARNING_SCHEMA_OVERRIDDEN,
									missingRequired: [],
								}
							: schemaError
								? {
										message: `invalid output schema: ${schemaError}`,
										missingRequired: [],
									}
								: undefined;
				if (includeStructuredOutput) {
					structuredOutput =
						schemaError || normalized === undefined
							? {
									source,
									mode,
									status: "unavailable",
									data: completeData,
									error: schemaError ? `invalid output schema: ${schemaError}` : undefined,
								}
							: failure
								? {
										source,
										mode,
										status: "invalid",
										data: completeData,
										error: failure.message,
									}
								: { source, mode, status: "valid", data: completeData };
				}
				const mustReject =
					failure !== undefined && (mode === "strict" || (!assembled.schemaOverridden && !schemaError));
				if (mustReject && failure) {
					const outcome = buildSchemaViolationOutcome(failure, completeData);
					rawOutput = outcome.rawOutput;
					stderr = outcome.stderr;
					exitCode = outcome.exitCode;
				} else {
					try {
						rawOutput =
							assembled.rawText && typeof completeData === "string"
								? completeData
								: (JSON.stringify(completeData, null, 2) ?? "null");
					} catch (err) {
						const errorMessage = err instanceof Error ? err.message : String(err);
						rawOutput = `{"error":"Failed to serialize yield data: ${errorMessage}"}`;
					}
					if (!hadFailureBeforeYield) {
						exitCode = 0;
						stderr = assembled.schemaOverridden
							? SUBAGENT_WARNING_SCHEMA_OVERRIDDEN
							: (structuredOutput?.error ?? "");
					} else if (!stderr) {
						stderr = "Subagent failed after yielding a result.";
					}
				}
			}
		}
	} else {
		const allowFallback = exitCode === 0 && !doneAborted && !signalAborted && !requireYield;
		const { normalized: normalizedSchema, error: schemaError } = normalizeSchema(outputSchema);
		const hasOutputSchema = normalizedSchema !== undefined && !schemaError;
		const fallback = allowFallback ? resolveFallbackCompletion(rawOutput, outputSchema) : null;
		if (fallback) {
			const { validator } = buildOutputValidator(outputSchema);
			const completeData = parseStringifiedJson(fallback.data ?? null);
			const result = validator?.validate(completeData) ?? {
				success: true as const,
			};
			if (!result.success) {
				const summary = summarizeValidationFailure(result, completeData, validator?.requiredFields ?? []);
				if (includeStructuredOutput) {
					structuredOutput = {
						source,
						mode,
						status: "invalid",
						data: completeData,
						error: summary.message,
					};
				}
				const outcome = buildSchemaViolationOutcome(summary, completeData);
				rawOutput = outcome.rawOutput;
				stderr = outcome.stderr;
				exitCode = outcome.exitCode;
			} else {
				if (includeStructuredOutput) {
					structuredOutput = {
						source,
						mode,
						status: "valid",
						data: completeData,
					};
				}
				try {
					rawOutput = JSON.stringify(completeData, null, 2) ?? "null";
				} catch (err) {
					const errorMessage = err instanceof Error ? err.message : String(err);
					rawOutput = `{"error":"Failed to serialize fallback completion: ${errorMessage}"}`;
				}
				exitCode = 0;
				stderr = "";
			}
		} else if (!hasOutputSchema && allowFallback && rawOutput.trim().length > 0) {
			exitCode = 0;
			stderr = "";
		} else if (exitCode === 0) {
			const warning =
				args.missingYieldWarning ??
				(requireYield ? SUBAGENT_WARNING_MISSING_YIELD : SUBAGENT_WARNING_MISSING_OUTPUT);
			const hasRawOutput = rawOutput.trim().length > 0;
			rawOutput = rawOutput ? `${warning}\n\n${rawOutput}` : warning;
			if (requireYield || hasOutputSchema || !hasRawOutput) {
				exitCode = 1;
				stderr = warning;
			}
		}
	}

	return {
		rawOutput,
		exitCode,
		stderr,
		abortedViaYield,
		hasYield,
		structuredOutput,
	};
}

export interface FinalizeSubprocessResultArgs extends FinalizeSubprocessOutputArgs {
	doneAbortReason?: string;
	/** A terminal cleanup failure remains an abort even when output already yielded. */
	doneAbortOverridesYield?: boolean;
	signalAbortReason?: string;
	runtimeLimitExceeded?: boolean;
	runtimeLimitAbortReason?: string;
	defaultAbortReason?: string;
}

export interface FinalizeSubprocessResult extends FinalizeSubprocessOutputResult {
	aborted: boolean;
	abortReason?: string;
}

/**
 * Apply the shared Task abort precedence after shaping terminal output.
 *
 * A runtime timeout wins over a concurrent Yield. An aborted Yield wins over
 * ordinary process completion. Parent cancellation applies only when no Yield
 * completed, matching the established Pi task behavior.
 */
export function finalizeSubprocessResult(args: FinalizeSubprocessResultArgs): FinalizeSubprocessResult {
	const finalized = finalizeSubprocessOutput(args);
	const lastYield = args.yieldItems?.[args.yieldItems.length - 1];
	const yieldAbortReason = lastYield?.status === "aborted" ? lastYield.error || "Subagent aborted task" : undefined;
	const runtimeLimitExceeded = args.runtimeLimitExceeded === true;
	const doneAbortOverridesYield = args.doneAbortOverridesYield === true && args.doneAborted;
	const aborted =
		runtimeLimitExceeded ||
		doneAbortOverridesYield ||
		finalized.abortedViaYield ||
		(!finalized.hasYield && (args.doneAborted || args.signalAborted));
	const abortReason = aborted
		? runtimeLimitExceeded
			? args.runtimeLimitAbortReason
			: doneAbortOverridesYield
				? (args.doneAbortReason ?? args.defaultAbortReason)
				: finalized.abortedViaYield
					? yieldAbortReason
					: (args.doneAbortReason ?? args.signalAbortReason ?? args.defaultAbortReason)
		: undefined;
	return {
		...finalized,
		exitCode: runtimeLimitExceeded && finalized.exitCode === 0 ? 1 : finalized.exitCode,
		aborted,
		abortReason,
	};
}

/**
 * Extract a short preview from tool args for display.
 */
function extractToolArgsPreview(args: Record<string, unknown>): string {
	// Priority order for preview
	const previewKeys = ["command", "file_path", "path", "pattern", "query", "url", "task", "prompt"];

	for (const key of previewKeys) {
		if (args[key] && typeof args[key] === "string") {
			const value = args[key] as string;
			return value.length > 60 ? `${value.slice(0, 59)}…` : value;
		}
	}

	return "";
}

function getNumberField(record: Record<string, unknown>, key: string): number | undefined {
	if (!Object.hasOwn(record, key)) return undefined;
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstNumberField(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = getNumberField(record, key);
		if (value !== undefined) return value;
	}
	return undefined;
}

/**
 * Tokens for progress display: input + output + cacheWrite per turn.
 *
 * Deliberately excludes cacheRead. With prompt caching, cacheRead in each turn
 * equals the full cached context (potentially hundreds of KB), so summing it
 * across all turns produces a cumulative total that is N×context_size — far
 * larger than the context window and misleading as a "work done" metric.
 * cacheWrite is kept because each byte is written once, not repeated per turn.
 * The cost segment handles billing; dedicated cache_read/cache_write segments
 * handle cache-specific monitoring.
 */
function getUsageTokens(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const record = usage as Record<string, unknown>;

	const input = firstNumberField(record, ["input", "input_tokens", "inputTokens"]) ?? 0;
	const output = firstNumberField(record, ["output", "output_tokens", "outputTokens"]) ?? 0;
	const cacheWrite = firstNumberField(record, ["cacheWrite", "cache_write", "cacheWriteTokens"]) ?? 0;
	const computed = input + output + cacheWrite;
	if (computed > 0) return computed;
	// Fallback for providers that only surface a pre-summed total without individual
	// field breakdown. This total includes cacheRead, but returning it is still better
	// than silently showing 0 for those providers.
	return firstNumberField(record, ["totalTokens", "total_tokens"]) ?? 0;
}

export function createSubagentSettings(
	baseSettings: Settings,
	overrides?: Partial<Record<SettingPath, unknown>>,
	inheritedServiceTier?: ServiceTierByFamily | null,
): Settings {
	const snapshot: Partial<Record<SettingPath, unknown>> = {};
	for (const key of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		snapshot[key] = baseSettings.get(key);
	}
	// Resolve the subagent's per-family tiers from `tier.subagent` ("inherit" =
	// match the parent's live tiers when a live session supplied them, else the
	// subagent's own configured tier.* settings). The result is stamped back onto
	// the snapshot so createAgentSession's tier.* reads pick it up.
	const inheritedTiers =
		inheritedServiceTier === undefined
			? buildServiceTierByFamily(
					baseSettings.get("tier.openai"),
					baseSettings.get("tier.anthropic"),
					baseSettings.get("tier.google"),
				)
			: (inheritedServiceTier ?? {});
	const subagentTiers = resolveSubagentServiceTier(baseSettings.get("tier.subagent"), inheritedTiers);
	snapshot["tier.openai"] = subagentTiers.openai ?? "none";
	snapshot["tier.anthropic"] = subagentTiers.anthropic ?? "none";
	snapshot["tier.google"] = subagentTiers.google ?? "none";
	return Settings.isolated({
		...snapshot,
		// Async jobs and bash auto-backgrounding are inherited from the parent:
		// background jobs are owner-routed to the subagent's own session, and
		// the run driver's async-work settlement + teardown reap guarantee no
		// owner job outlives the run, so worktree capture/cleanup stays
		// race-free (previously both were force-disabled here).

		// Subagents run headless — there is no UI to confirm prompts against, so
		// the parent task approval is the authorization boundary. Use yolo mode
		// to preserve unattended subagent execution.
		"tools.approvalMode": "yolo",
		...overrides,
	});
}

export type AbortReason = "signal" | "terminate" | "timeout" | "budget";

/** Inputs for the run monitor driving one subagent assignment. */
interface RunMonitorArgs {
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	description?: string;
	/** Parent model registry for tiny-model label generation; absent → skip labeling. */
	modelRegistry?: ModelRegistry;
	/** Parent settings for tiny-model label generation. */
	settings?: Settings;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	/** Soft assistant-request budget; 0 disables the guard. */
	softRequestBudget: number;
	/** Whether crossing the soft budget injects a wrap-up steering notice. */
	softRequestBudgetNotice: boolean;
	/** Wall-clock cap in ms; 0 disables the timer. */
	maxRuntimeMs: number;
}

/**
 * The run-monitoring core of {@link runSubprocess}: progress tracking, event
 * processing, abort/budget machinery, usage accumulation, and output capture
 * for one assignment run.
 */
interface SubagentRunMonitor {
	readonly progress: AgentProgress;
	/** Fires when the run was asked to stop (caller signal, timeout, budget, terminate). */
	readonly abortSignal: AbortSignal;
	readonly accumulatedUsage: Usage;
	hasUsage(): boolean;
	runtimeLimitExceeded(): boolean;
	/** The abort kind for this run, when an abort was requested. */
	abortKind(): AbortReason | undefined;
	/** True when the abort carries a precise external reason (signal / wall-clock / budget). */
	hasExplicitAbortReason(): boolean;
	/** Whether the (attempted) abort counts as a cancelled run rather than an internal failure. */
	isAbortedRun(): boolean;
	requestAbort(reason: AbortReason): void;
	abortActiveSession(): Promise<void>;
	waitForActiveSessionAbort(): Promise<void>;
	resolveSignalAbortReason(): string;
	resolveAbortReasonText(): string;
	setActiveSession(session: AgentSession | null): void;
	/** Return and clear the active session reference. */
	takeActiveSession(): AgentSession | null;
	/** Subscribe the monitor to a session's events. Returns the unsubscribe function. */
	attach(session: AgentSession): () => void;
	/** Best-effort capture of the last assistant text for cancelled-run salvage. */
	captureSalvage(session: AgentSession): void;
	lastAssistantSalvageText(): string | undefined;
	/** Final raw output: end-of-run assistant text when available, else accumulated chunks. */
	rawOutput(): string;
	scheduleProgress(flush?: boolean): void;
	/** Stop processing events and clear listeners/timers. Call once the run settled. */
	finish(): void;
}

function createSubagentRunMonitor(args: RunMonitorArgs): SubagentRunMonitor {
	const {
		index,
		id,
		agent,
		task,
		assignment,
		signal,
		onProgress,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	} = args;
	const startTime = Date.now();

	const progress: AgentProgress = {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		status: "running",
		task,
		assignment,
		description: args.description,
		lastIntent: undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		modelOverride: args.modelOverride,
		modelRole: args.modelRole,
	};

	const outputChunks: string[] = [];
	const RECENT_OUTPUT_TAIL_BYTES = 8 * 1024;
	let recentOutputTail = "";
	let recentOutputDirty = false;
	let resolved = false;
	let abortSent = false;
	let abortReason: AbortReason | undefined;
	let runtimeLimitExceeded = false;
	const listenerController = new AbortController();
	const listenerSignal = listenerController.signal;
	const abortController = new AbortController();
	const abortSignal = abortController.signal;
	let activeSession: AgentSession | null = null;

	// Accumulate usage incrementally from message_end events (no memory for streaming events)
	const accumulatedUsage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		reasoningTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	let hasUsage = false;
	let budgetSteerSent = false;
	let budgetLimitExceeded = false;
	let lastAssistantSalvageText: string | undefined;
	let activeSessionAbortPromise: Promise<void> | undefined;

	const abortActiveSession = (): Promise<void> => {
		const session = activeSession;
		if (!session) return Promise.resolve();
		activeSessionAbortPromise ??= session.abort().catch(error => {
			logger.debug("Subagent session abort cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		return activeSessionAbortPromise;
	};

	const waitForActiveSessionAbort = async (): Promise<void> => {
		if (activeSessionAbortPromise) await activeSessionAbortPromise;
	};

	const requestAbort = (reason: AbortReason) => {
		if (reason === "timeout") {
			runtimeLimitExceeded = true;
		}
		if (reason === "budget") {
			budgetLimitExceeded = true;
		}
		if (abortSent) {
			if (reason === "signal" && abortReason !== "signal" && abortReason !== "timeout") {
				abortReason = "signal";
			}
			return;
		}
		if (resolved) return;
		abortSent = true;
		abortReason = reason;
		abortController.abort();
		void abortActiveSession();
	};

	// Handle abort signal
	if (signal) {
		signal.addEventListener(
			"abort",
			() => {
				if (!resolved) requestAbort("signal");
			},
			{ once: true, signal: listenerSignal },
		);
	}

	// Wall-clock hard limit. Defense-in-depth for the case where a provider stream
	// hang escapes the inference-layer watchdog (see openai-completions
	// `isOpenAICompletionsProgressChunk`). Disabled by default; set
	// `task.maxRuntimeMs > 0` to cap each subagent's lifetime.
	let runtimeTimeoutId: NodeJS.Timeout | undefined;
	if (maxRuntimeMs > 0) {
		runtimeTimeoutId = setTimeout(() => {
			if (!resolved) {
				logger.warn("Subagent runtime limit exceeded; aborting", {
					id,
					agent: agent.name,
					maxRuntimeMs,
				});
				requestAbort("timeout");
			}
		}, maxRuntimeMs);
	}

	const resolveSignalAbortReason = (): string => {
		const reason = signal?.reason;
		if (reason instanceof Error) {
			const message = reason.message.trim();
			if (message.length > 0) return message;
		} else if (typeof reason === "string") {
			const message = reason.trim();
			if (message.length > 0) return message;
		}
		return "Cancelled by caller";
	};
	const resolveAbortReasonText = (): string => {
		if (runtimeLimitExceeded) {
			return `Subagent runtime limit exceeded (task.maxRuntimeMs=${maxRuntimeMs})`;
		}
		if (budgetLimitExceeded) {
			return `Soft request budget exceeded (${progress.requests} requests; budget ${softRequestBudget})`;
		}
		return resolveSignalAbortReason();
	};
	const PROGRESS_COALESCE_MS = 150;
	let lastProgressEmitMs = 0;
	let progressTimeoutId: NodeJS.Timeout | null = null;

	// Recompute progress.recentOutput from the capped tail. Deferred: text_delta
	// appends only extend the tail and mark it dirty; the (up to 8KB) split/filter
	// runs synchronously here, immediately before the ONLY places the progress
	// object is snapshotted ({...progress} for onProgress and the eventBus
	// progress channel, both inside emitProgressNow — including the
	// scheduleProgress(flush) finalize/error/cancel paths). Observers therefore
	// always see exact state; no staleness beyond the existing 150ms coalescing.
	const refreshRecentOutput = () => {
		if (!recentOutputDirty) return;
		recentOutputDirty = false;
		const filtered = recentOutputTail.split("\n").filter(line => line.trim());
		progress.recentOutput = filtered.slice(-8).reverse();
	};

	const emitProgressNow = () => {
		refreshRecentOutput();
		progress.durationMs = Date.now() - startTime;
		onProgress?.({ ...progress });
		const activityGist =
			progress.lastIntent ?? (progress.currentTool ? `running ${progress.currentTool}` : undefined);
		if (activityGist) AgentRegistry.global().setActivity(id, activityGist);
		if (args.eventBus) {
			args.eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				index,
				agent: agent.name,
				agentSource: agent.source,
				task,
				parentToolCallId: args.parentToolCallId,
				detached: args.detached,
				assignment,
				progress: { ...progress },
				sessionFile: args.sessionFile,
			});
		}
		lastProgressEmitMs = Date.now();
	};

	const scheduleProgress = (flush = false) => {
		if (flush) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		const now = Date.now();
		const elapsed = now - lastProgressEmitMs;
		if (lastProgressEmitMs === 0 || elapsed >= PROGRESS_COALESCE_MS) {
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
			emitProgressNow();
			return;
		}
		if (progressTimeoutId) return;
		progressTimeoutId = setTimeout(() => {
			progressTimeoutId = null;
			emitProgressNow();
		}, PROGRESS_COALESCE_MS - elapsed);
	};

	// The task wire schema carries no description: when the caller didn't pre-set
	// a UI label (a supplied label), compress the assignment into a
	// tiny-model one-sentence label off the spawn's critical path. Best-effort —
	// a late label still lands via the finalize-time reads of `progress.description`;
	// failures just leave the label unset.
	const labelSource = assignment?.trim();
	if (!args.description && args.modelRegistry && args.settings && labelSource) {
		generateTaskLabel(labelSource, args.modelRegistry, args.settings, id, abortSignal)
			.then(label => {
				if (!label || abortSignal.aborted || progress.description) return;
				progress.description = label;
				if (!resolved) scheduleProgress();
			})
			.catch(err => {
				logger.debug("Subagent label generation failed", {
					id,
					error: err instanceof Error ? err.message : String(err),
				});
			});
	}

	const getMessageContent = (message: unknown): unknown => {
		if (!isRecord(message) || !("content" in message)) {
			return undefined;
		}
		return message.content;
	};

	const getMessageUsage = (message: unknown): unknown => {
		if (!isRecord(message) || !("usage" in message)) {
			return undefined;
		}
		return message.usage;
	};

	const appendRecentOutputTail = (text: string) => {
		if (!text) return;
		recentOutputTail += text;
		if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
			recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
		}
		// O(chunk) hot path: this runs on every text_delta token (hundreds/
		// thousands per second while streaming). Line reconstruction is deferred
		// to refreshRecentOutput() at the emit boundary.
		recentOutputDirty = true;
	};

	const replaceRecentOutputFromContent = (content: unknown[]) => {
		recentOutputTail = "";
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const record = block as { type?: unknown; text?: unknown };
			if (record.type !== "text" || typeof record.text !== "string") continue;
			if (!record.text) continue;
			recentOutputTail += record.text;
			if (recentOutputTail.length > RECENT_OUTPUT_TAIL_BYTES) {
				recentOutputTail = recentOutputTail.slice(-RECENT_OUTPUT_TAIL_BYTES);
			}
		}
		recentOutputDirty = true;
	};

	const resetRecentOutput = () => {
		recentOutputTail = "";
		recentOutputDirty = false;
		progress.recentOutput = [];
	};

	const emitSubagentEvent = (event: AgentSessionEvent) => {
		if (!args.eventBus) return;
		args.eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
			id,
			event,
		});
	};

	const processEvent = (event: AgentEvent) => {
		if (resolved) return;
		const now = Date.now();
		let flushProgress = false;

		switch (event.type) {
			case "message_start":
				if (event.message?.role === "assistant") resetRecentOutput();
				break;

			case "tool_execution_start": {
				progress.toolCount++;
				progress.currentTool = event.toolName;
				let startArgs: Record<string, unknown> = {};
				if ("toolArgs" in event && isRecord(event.toolArgs)) {
					startArgs = event.toolArgs;
				} else if (isRecord(event.args)) {
					startArgs = event.args;
				}
				progress.currentToolArgs = extractToolArgsPreview(startArgs);
				progress.currentToolStartMs = now;
				break;
			}

			case "tool_execution_end":
				if (progress.currentTool) {
					progress.recentTools.unshift({
						tool: progress.currentTool,
						args: progress.currentToolArgs || "",
						endMs: now,
					});
					if (progress.recentTools.length > 5) progress.recentTools.pop();
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartMs = undefined;
				flushProgress = true;
				break;

			case "tool_execution_update":
				break;

			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const assistantEvent = (
					event as AgentEvent & {
						assistantMessageEvent?: { type?: string; delta?: string };
					}
				).assistantMessageEvent;
				if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
					appendRecentOutputTail(assistantEvent.delta);
					break;
				}
				if (assistantEvent && assistantEvent.type !== "text_delta") {
					break;
				}
				const updateContent =
					getMessageContent(event.message) || (event as AgentEvent & { content?: unknown }).content;
				if (updateContent && Array.isArray(updateContent)) {
					replaceRecentOutputFromContent(updateContent);
				}
				break;
			}

			case "message_end": {
				// Extract text from assistant and toolResult messages (not user prompts)
				const role = event.message?.role;
				if (role === "assistant") {
					progress.requests += 1;
					const eventContent = isRecord(event) && "content" in event ? event.content : undefined;
					const messageContent = getMessageContent(event.message) || eventContent;
					if (messageContent && Array.isArray(messageContent)) {
						for (const block of messageContent) {
							if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
								outputChunks.push(block.text);
							}
						}
					}
					if (softRequestBudget > 0 && !abortSent) {
						const stopThreshold = softRequestBudget * 1.5;
						if (progress.requests >= stopThreshold) {
							requestAbort("budget");
						} else if (softRequestBudgetNotice && !budgetSteerSent && progress.requests >= softRequestBudget) {
							budgetSteerSent = true;
							const steerSession = activeSession;
							if (steerSession) {
								// Build the notice now (the count at crossing time), but send
								// behind an async boundary: a synchronously-throwing send must
								// never take down event processing (which escalates to terminate).
								const notice = buildBudgetNotice(progress.requests, softRequestBudget);
								void Promise.resolve()
									.then(() =>
										steerSession.sendUserMessage(notice, {
											deliverAs: "steer",
										}),
									)
									.catch(err => {
										logger.warn("Subagent budget steer failed", {
											error: err instanceof Error ? err.message : String(err),
										});
									});
							}
						}
					}
				}
				// Extract and accumulate usage (prefer message.usage, fallback to event.usage)
				const eventUsage = isRecord(event) && "usage" in event ? event.usage : undefined;
				const messageUsage = getMessageUsage(event.message) || eventUsage;
				if (isRecord(messageUsage)) {
					// Only count assistant messages (not tool results, etc.)
					if (role === "assistant") {
						const costRecord = isRecord(messageUsage.cost) ? messageUsage.cost : undefined;
						hasUsage = true;
						accumulatedUsage.input += getNumberField(messageUsage, "input") ?? 0;
						accumulatedUsage.output += getNumberField(messageUsage, "output") ?? 0;
						accumulatedUsage.cacheRead += getNumberField(messageUsage, "cacheRead") ?? 0;
						accumulatedUsage.cacheWrite += getNumberField(messageUsage, "cacheWrite") ?? 0;
						accumulatedUsage.totalTokens += getNumberField(messageUsage, "totalTokens") ?? 0;
						accumulatedUsage.reasoningTokens =
							(accumulatedUsage.reasoningTokens ?? 0) + (getNumberField(messageUsage, "reasoningTokens") ?? 0);
						if (costRecord) {
							accumulatedUsage.cost.input += getNumberField(costRecord, "input") ?? 0;
							accumulatedUsage.cost.output += getNumberField(costRecord, "output") ?? 0;
							accumulatedUsage.cost.cacheRead += getNumberField(costRecord, "cacheRead") ?? 0;
							accumulatedUsage.cost.cacheWrite += getNumberField(costRecord, "cacheWrite") ?? 0;
							accumulatedUsage.cost.total += getNumberField(costRecord, "total") ?? 0;
							progress.cost = accumulatedUsage.cost.total;
						}
					}
					// Accumulate tokens for progress display
					progress.tokens += getUsageTokens(messageUsage);
					// Track latest per-turn context size so the UI can show
					// "current context", not just cumulative billing volume.
					if (role === "assistant") {
						const perTurnTotal = getNumberField(messageUsage, "totalTokens");
						if (perTurnTotal !== undefined && perTurnTotal > 0) {
							progress.contextTokens = perTurnTotal;
						}
					}
				}
				break;
			}

			case "agent_end":
				flushProgress = true;
				break;
		}

		scheduleProgress(flushProgress);
	};

	const attach = (session: AgentSession): (() => void) => {
		let activeModel = session.model ? formatModelStringWithRouting(session.model) : undefined;
		return session.subscribe(event => {
			emitSubagentEvent(event);
			const nextModel = session.model ? formatModelStringWithRouting(session.model) : undefined;
			if (nextModel && nextModel !== activeModel) {
				activeModel = nextModel;
				progress.resolvedModel = nextModel;
				scheduleProgress(true);
			}
			if (event.type === "auto_retry_start") {
				progress.retryState = {
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
					startedAtMs: Date.now(),
				};
				progress.retryFailure = undefined;
				scheduleProgress(true);
				return;
			}
			if (event.type === "auto_retry_end") {
				const attempt = progress.retryState?.attempt ?? event.attempt;
				progress.retryState = undefined;
				if (!event.success) {
					progress.retryFailure = {
						attempt,
						errorMessage: event.finalError ?? "Auto-retry failed",
					};
				}
				scheduleProgress(true);
				return;
			}
			if (isAgentEvent(event)) {
				// Breadcrumb the synchronous subagent event handling so the loop
				// watchdog can attribute any block to this in-process subagent.
				pushLoopPhase(`subagent:${id}`);
				try {
					processEvent(event);
				} catch (err) {
					logger.error("Subagent event processing failed", {
						error: err instanceof Error ? err.message : String(err),
					});
					requestAbort("terminate");
				} finally {
					popLoopPhase();
				}
			}
			if (event.type === "retry_fallback_applied") {
				progress.resolvedModel = event.to;
				progress.resolvedModelIsFallback = true;
				scheduleProgress(true);
				return;
			}
			if (event.type === "retry_fallback_succeeded") {
				progress.resolvedModel = event.model;
				progress.resolvedModelIsFallback = true;
				scheduleProgress(true);
				return;
			}
		});
	};

	const captureSalvage = (session: AgentSession): void => {
		// Best-effort salvage: capture the last assistant text so
		// cancelled/aborted children can surface "last activity" instead of
		// "(no output)".
		try {
			const lastContent = session.getLastAssistantMessage()?.content;
			if (Array.isArray(lastContent)) {
				const text = lastContent
					.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
					.filter(Boolean)
					.join("\n");
				if (text.trim()) {
					lastAssistantSalvageText = text;
				}
			}
		} catch {
			// Salvage is best-effort; partial sessions may not implement it
		}
	};

	return {
		progress,
		abortSignal,
		accumulatedUsage,
		hasUsage: () => hasUsage,
		runtimeLimitExceeded: () => runtimeLimitExceeded,
		hasExplicitAbortReason: () => abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded,
		abortKind: () => abortReason,
		isAbortedRun: () =>
			abortReason === "signal" || runtimeLimitExceeded || budgetLimitExceeded || abortReason === undefined,
		requestAbort,
		abortActiveSession,
		waitForActiveSessionAbort,
		resolveSignalAbortReason,
		resolveAbortReasonText,
		setActiveSession: session => {
			activeSession = session;
		},
		takeActiveSession: () => {
			const session = activeSession;
			activeSession = null;
			return session;
		},
		attach,
		captureSalvage,
		lastAssistantSalvageText: () => lastAssistantSalvageText,
		rawOutput: () => lastAssistantSalvageText ?? outputChunks.join(""),
		scheduleProgress,
		finish: () => {
			resolved = true;
			listenerController.abort();
			if (runtimeTimeoutId !== undefined) {
				clearTimeout(runtimeTimeoutId);
				runtimeTimeoutId = undefined;
			}
			if (progressTimeoutId) {
				clearTimeout(progressTimeoutId);
				progressTimeoutId = null;
			}
		},
	};
}

interface DriveOutcome {
	exitCode: number;
	error?: string;
	aborted: boolean;
	abortReasonText?: string;
}

/** Drive one native assignment to its terminal assistant response. */
async function driveSessionToCompletion(
	session: AgentSession,
	monitor: SubagentRunMonitor,
	task: string,
): Promise<DriveOutcome> {
	const abortSignal = monitor.abortSignal;
	let exitCode = 0;
	let error: string | undefined;
	let aborted = false;
	let abortReasonText: string | undefined;
	const checkAbort = () => {
		if (!abortSignal.aborted) return;
		aborted = monitor.isAbortedRun();
		if (aborted) abortReasonText ??= monitor.resolveAbortReasonText();
		exitCode = 1;
		throw new ToolAbortError();
	};
	const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
		checkAbort();
		const { promise: abortPromise, reject } = Promise.withResolvers<never>();
		const onAbort = () => {
			try {
				checkAbort();
			} catch (abortError) {
				reject(abortError);
			}
		};
		abortSignal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, abortPromise]);
		} finally {
			abortSignal.removeEventListener("abort", onAbort);
		}
	};

	try {
		await awaitAbortable(session.prompt(task, { attribution: "agent" }));
		await awaitAbortable(session.waitForIdle());

		// A native child may admit its own asynchronous children through IPython.
		// Settle their owner-routed deliveries before accepting the latest terminal
		// assistant response, so isolated work cannot outlive worktree capture.
		while (session.hasPendingAsyncWork?.()) {
			await awaitAbortable(session.settleAsyncWork());
			await awaitAbortable(session.waitForIdle());
		}

		const lastAssistant = session.getLastAssistantMessage();
		if (lastAssistant?.stopReason === "aborted") {
			aborted = monitor.isAbortedRun();
			if (aborted) {
				abortReasonText = monitor.hasExplicitAbortReason()
					? monitor.resolveAbortReasonText()
					: lastAssistant.errorMessage?.trim() || monitor.resolveAbortReasonText();
			}
			exitCode = 1;
		} else if (lastAssistant?.stopReason === "error") {
			exitCode = 1;
			error = lastAssistant.errorMessage || "Subagent failed";
		}
	} catch (runError) {
		exitCode = 1;
		if (!abortSignal.aborted)
			error = runError instanceof Error ? runError.stack || runError.message : String(runError);
	} finally {
		if (abortSignal.aborted) {
			aborted = monitor.isAbortedRun();
			if (aborted) abortReasonText ??= monitor.resolveAbortReasonText();
		}
	}

	return { exitCode, error, aborted, abortReasonText };
}

interface FinalizeRunArgs {
	monitor: SubagentRunMonitor;
	done: {
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		abortOverridesYield?: boolean;
		durationMs: number;
	};
	index: number;
	id: string;
	agent: AgentDefinition;
	task: string;
	assignment?: string;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	artifactsDir?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;
	detached?: boolean;
	sessionFile?: string;
	startTime: number;
}

/**
 * Turn a settled run into a {@link SingleResult}: shape its terminal result via
 * {@link finalizeSubprocessResult}, salvage cancelled-run output, write the
 * `<id>.md` output artifact, flush final progress, and emit the lifecycle end
 * event.
 */
async function finalizeRunResult(args: FinalizeRunArgs): Promise<SingleResult> {
	const { monitor, done, index, id, agent, task, assignment, signal, modelOverride, modelRole } = args;
	const progress = monitor.progress;
	let exitCode = done.exitCode;
	let stderr = done.error ?? "";

	// Use final output if available, otherwise accumulated output
	let rawOutput = monitor.rawOutput();
	// Breadcrumb the synchronous terminal-result shaping (O(rawOutput)) so a block
	// here is attributed to this subagent rather than logged as "unknown".
	pushLoopPhase(`subagent:${id}`);
	let finalized: FinalizeSubprocessResult;
	try {
		const runtimeLimitExceeded = monitor.runtimeLimitExceeded();
		finalized = finalizeSubprocessResult({
			rawOutput,
			exitCode,
			stderr,
			doneAborted: Boolean(done.aborted),
			doneAbortOverridesYield: done.abortOverridesYield,
			signalAborted: Boolean(signal?.aborted),
			outputSchema: args.outputSchema,
			outputSchemaMode: args.outputSchemaMode,
			outputSchemaSource: args.outputSchemaSource,
			lastAssistantText: monitor.lastAssistantSalvageText(),
			doneAbortReason: done.abortReason,
			signalAbortReason: signal?.aborted ? monitor.resolveSignalAbortReason() : undefined,
			runtimeLimitExceeded,
			runtimeLimitAbortReason: runtimeLimitExceeded ? monitor.resolveAbortReasonText() : undefined,
			defaultAbortReason: done.aborted ? monitor.resolveAbortReasonText() : undefined,
		});
	} finally {
		popLoopPhase();
	}
	rawOutput = finalized.rawOutput;
	exitCode = finalized.exitCode;
	stderr = finalized.stderr;
	// Salvage for cancelled/aborted children that produced no completed output:
	// surface the last assistant text + stats instead of "(no output)" so the
	// parent doesn't redo work the child already finished.
	const salvageText = monitor.lastAssistantSalvageText();
	if (
		(done.aborted || signal?.aborted || monitor.runtimeLimitExceeded()) &&
		!rawOutput.trim() &&
		salvageText !== undefined
	) {
		rawOutput = `[cancelled after ${progress.requests} req, ${progress.tokens} tok — last activity: "${formatSalvageSnippet(salvageText)}"]`;
	}
	const wasAborted = finalized.aborted;
	const finalAbortReason = finalized.abortReason;
	const { content: truncatedOutput, truncated } = truncateTail(rawOutput, {
		maxBytes: MAX_OUTPUT_BYTES,
		maxLines: MAX_OUTPUT_LINES,
	});

	// Write output artifact (input and jsonl already written in real-time)
	// Compute output metadata for agent:// URL integration
	let outputMeta: { lineCount: number; charCount: number } | undefined;
	let outputPath: string | undefined;
	if (args.artifactsDir) {
		outputPath = path.join(args.artifactsDir, `${id}.md`);
		try {
			await Bun.write(outputPath, rawOutput);
			outputMeta = {
				lineCount: rawOutput.split("\n").length,
				charCount: rawOutput.length,
			};
		} catch {
			// Non-fatal
		}
	}

	progress.status = wasAborted ? "aborted" : exitCode === 0 ? "completed" : "failed";
	monitor.scheduleProgress(true);

	// Emit lifecycle end after finalization so terminal status is reflected
	if (args.eventBus) {
		args.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: args.parentToolCallId,
			detached: args.detached,
			agentSource: agent.source,
			description: progress.description,
			status: progress.status as "completed" | "failed" | "aborted",
			sessionFile: args.sessionFile,
			index,
		});
	}

	return {
		index,
		id,
		agent: agent.name,
		agentSource: agent.source,
		task,
		assignment,
		description: progress.description,
		lastIntent: progress.lastIntent,
		exitCode,
		output: truncatedOutput,
		stderr,
		truncated: Boolean(truncated),
		...(finalized.structuredOutput ? { structuredOutput: finalized.structuredOutput } : {}),
		durationMs: Date.now() - args.startTime,
		tokens: progress.tokens,
		requests: progress.requests,
		contextTokens: progress.contextTokens,
		contextWindow: progress.contextWindow,
		modelOverride,
		modelRole,
		resolvedModel: progress.resolvedModel,
		resolvedModelIsFallback: progress.resolvedModelIsFallback,
		error: exitCode !== 0 && stderr ? stderr : undefined,
		aborted: wasAborted,
		abortReason: finalAbortReason,
		usage: monitor.hasUsage() ? monitor.accumulatedUsage : undefined,
		outputPath,
		extractedToolData: progress.extractedToolData,
		retryFailure: progress.retryFailure,
		outputMeta,
	};
}

/** Inputs for {@link attachIrcWakeTurnMonitor}. */
export interface IrcWakeTurnMonitorOptions {
	/** Registry id of the kept-alive subagent whose autonomous IRC wake turns are monitored. */
	id: string;
	index?: number;
	agent: AgentDefinition;
	description?: string;
	modelOverride?: string | string[];
	/** Explicit pre-expansion model role alias selected for this run. */
	modelRole?: string;
	eventBus?: EventBus;
	parentToolCallId?: string;
	/** Fallback session file when the registry ref carries none. */
	sessionFile?: string;
	maxRuntimeMs?: number;
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	artifactsDir?: string;
}

/**
 * Bracket a kept-alive subagent's autonomous IRC wake turns with a task run
 * monitor so RPC/collab subscribers see the same `subagent_lifecycle` /
 * `subagent_progress` frames a first run emits. Shared by the live executor
 * reviver and the persisted cold-revive path so a resumed process's parked
 * subagents are not blind spots. The observer runs after the session has
 * flushed its post-prompt settle (see {@link AgentSession.setIrcWakeTurnObserver}).
 */
export function attachIrcWakeTurnMonitor(session: AgentSession, options: IrcWakeTurnMonitorOptions): void {
	const { id, agent } = options;
	const index = options.index ?? 0;
	const maxRuntimeMs = options.maxRuntimeMs ?? 0;
	session.setIrcWakeTurnObserver(records => {
		const ircTask =
			records
				.map(record => {
					const body =
						record.details && typeof record.details === "object"
							? Reflect.get(record.details, "message")
							: undefined;
					return typeof body === "string" ? body : record.content;
				})
				.filter(Boolean)
				.join("\n\n") || "IRC follow-up";
		const turnStartTime = Date.now();
		const sessionFile = AgentRegistry.global().get(id)?.sessionFile ?? options.sessionFile ?? undefined;
		const turnMonitor = createSubagentRunMonitor({
			index,
			id,
			agent,
			task: ircTask,
			description: options.description,
			modelOverride: options.modelOverride,
			modelRole: options.modelRole,
			eventBus: options.eventBus,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			sessionFile,
			softRequestBudget: 0,
			softRequestBudgetNotice: false,
			maxRuntimeMs,
		});

		if (options.eventBus) {
			options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
				id,
				agent: agent.name,
				parentToolCallId: options.parentToolCallId,
				detached: true,
				agentSource: agent.source,
				description: options.description,
				status: "started",
				sessionFile,
				index,
			});
		}

		turnMonitor.setActiveSession(session);
		const unsubscribeTurn = turnMonitor.attach(session);
		return async turnError => {
			unsubscribeTurn();
			const activeSession = turnMonitor.takeActiveSession();
			if (activeSession) turnMonitor.captureSalvage(activeSession);
			const lastAssistant = session.getLastAssistantMessage();
			const runtimeLimitExceeded = turnMonitor.runtimeLimitExceeded();
			const aborted = runtimeLimitExceeded || lastAssistant?.stopReason === "aborted";
			const error =
				lastAssistant?.stopReason === "error"
					? lastAssistant.errorMessage || "Subagent failed"
					: turnError !== undefined
						? turnError instanceof Error
							? turnError.stack || turnError.message
							: String(turnError)
						: undefined;
			turnMonitor.finish();
			try {
				await finalizeRunResult({
					monitor: turnMonitor,
					done: {
						exitCode: aborted || error ? 1 : 0,
						error,
						aborted,
						abortReason: aborted ? turnMonitor.resolveAbortReasonText() : undefined,
						durationMs: Date.now() - turnStartTime,
					},
					index,
					id,
					agent,
					task: ircTask,
					modelOverride: options.modelOverride,
					modelRole: options.modelRole,
					outputSchema: options.outputSchema,
					outputSchemaMode: options.outputSchemaMode,
					outputSchemaSource: options.outputSchemaSource,
					artifactsDir: options.artifactsDir,
					eventBus: options.eventBus,
					parentToolCallId: options.parentToolCallId,
					detached: true,
					sessionFile,
					startTime: turnStartTime,
				});
			} catch (finalizeError) {
				logger.warn("IRC subagent turn finalization failed", {
					id,
					error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
				});
			}
		};
	});
}

/**
 * Settle a subagent's registry lifecycle after a run: terminal teardown for
 * hard aborts, unregister for one-shot helpers, park for isolated runs, and
 * idle + lifecycle adoption for kept-alive agents. A soft-budget abort on a
 * kept-alive, revivable agent is treated as a self-inflicted stop rather than
 * a kill — the agent stays interrogable and resumable (irc wake / revival).
 */
export async function finalizeSubagentLifecycle(args: {
	id: string;
	session: AgentPeer;
	aborted: boolean;
	/** Which watchdog (if any) requested the abort; decides revivability. */
	abortKind?: AbortReason;
	keepAlive: boolean;
	isolated: boolean;
	agentIdleTtlMs: number;
	reviveSession: AgentReviver | null;
	cleanupDeadlineAt?: number;
	onCleanupDeferred?: (completion: Promise<void>) => void;
	/** False when a queued follow-up already owns the retained peer. */
	markIdle?: boolean;
}): Promise<void> {
	const registry = AgentRegistry.global();
	const ref = registry.get(args.id);
	const ownsRef = Boolean(ref && ref.session === args.session);
	const cleanupDeadlineAt = args.cleanupDeadlineAt ?? Date.now() + 5000;
	const disposeSession = async (): Promise<void> => {
		const disposal = args.session.dispose();
		const remainingMs = Math.max(0, cleanupDeadlineAt - Date.now());
		try {
			await untilAborted(AbortSignal.timeout(remainingMs), () => disposal);
		} catch (error) {
			if (Date.now() >= cleanupDeadlineAt) {
				args.onCleanupDeferred?.(disposal);
				return;
			}
			logger.warn("Subagent session cleanup failed", {
				id: args.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};

	// A budget abort leaves a consistent session with its transcript on disk;
	// caller signals, wall-clock timeouts (possible stream hang), and internal
	// terminations are genuine kills and stay terminal.
	const resumableAbort =
		args.abortKind === "budget" && args.keepAlive && !args.isolated && args.reviveSession !== null;
	if (args.aborted && !resumableAbort) {
		if (ref && ownsRef) {
			// Route hard kills through the lifecycle owner so the terminal
			// decision is durable and a restart cannot rediscover the transcript
			// as a revivable parked agent.
			try {
				await AgentLifecycleManager.global().release(args.id, ref, { tombstone: true });
			} catch (error) {
				logger.warn("runSubagent: failed to persist kill tombstone", { id: args.id, error: String(error) });
				registry.setStatus(args.id, "aborted", ref);
				registry.detachSession(args.id, ref);
				await disposeSession();
			}
		} else {
			await disposeSession();
		}
		return;
	}

	if (!args.keepAlive) {
		// One-shot helper: dispose and unregister. No IRC, no revival.
		await disposeSession();
		if (ref && ownsRef) registry.unregister(args.id, ref);
		return;
	}

	if (args.isolated) {
		// Isolated run: the worktree is merged + cleaned after the run, so
		// the session is not resumable. Park the ref WITHOUT adopting — the
		// transcript stays reachable (history://), but ensureLive will throw.
		// Status must flip to "parked" before dispose so the sdk dispose
		// wrapper skips unregister.
		if (ref && ownsRef) registry.setStatus(args.id, "parked", ref);
		await disposeSession();
		if (ref && ownsRef) registry.detachSession(args.id, ref);
		return;
	}

	// Keep-alive: finished and failed subagents both stay interrogable.
	// The lifecycle manager owns idle-TTL parking + revival from here on.
	if (!ref || !ownsRef || (args.markIdle !== false && !registry.setStatus(args.id, "idle", ref))) {
		await disposeSession();
		return;
	}
	AgentLifecycleManager.global().adopt(
		args.id,
		{
			idleTtlMs: args.agentIdleTtlMs,
			revive: args.reviveSession ?? undefined,
		},
		ref,
	);
}

/** Options for {@link runSubagentFollowUpTurn}. */
export interface FollowUpTurnOptions {
	/** Registry id of the (live or parked) subagent to continue. */
	id: string;
	/** Agent definition the session was originally spawned with (drives progress labels + finalize). */
	agent: AgentDefinition;
	/** The follow-up message; sent as the turn's user prompt. */
	message: string;
	index?: number;
	description?: string;
	/** Explicit pre-expansion model role alias retained from the original run. */
	modelRole?: string;
	/** Structured-output state retained from the original invocation. */
	outputSchema?: unknown;
	outputSchemaMode?: StructuredSubagentSchemaMode;
	outputSchemaSource?: StructuredSubagentSchemaSource;
	signal?: AbortSignal;
	onProgress?: (progress: AgentProgress) => void;
	eventBus?: EventBus;
	parentToolCallId?: string;
	/** When set, the turn's raw output is (re)written to `<artifactsDir>/<id>.md` so `agent://<id>` tracks the latest turn. */
	artifactsDir?: string;
	/** Wall-clock cap in ms for this turn; 0 disables. */
	maxRuntimeMs?: number;
}

/**
 * Continue a previously spawned (keep-alive) subagent with one more monitored
 * turn: revive it if parked, send `message` as a real prompt, drive it to
 * a terminal assistant response, and finalize a {@link SingleResult} exactly like a first run.
 *
 * The session's full conversation history is retained (live session, or JSONL
 * replay through the lifecycle reviver), so the turn sees all prior context.
 * Unlike {@link runSubprocess}, the session is NOT torn down afterwards — it
 * stays adopted by the {@link AgentLifecycleManager} (idle → TTL park →
 * revive), and an aborted turn only aborts the in-flight turn.
 */
export async function runSubagentFollowUpTurn(options: FollowUpTurnOptions): Promise<SingleResult> {
	const { id, agent, message, signal } = options;
	const index = options.index ?? 0;
	const startTime = Date.now();
	const session = await AgentLifecycleManager.global().ensureLive(id);
	if (!isAgentSession(session)) {
		throw new Error(`Agent "${id}" runtime does not support Pi follow-up turns.`);
	}
	const ref = AgentRegistry.global().get(id);
	const sessionFile = ref?.sessionFile ?? undefined;

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task: message,
		description: options.description,
		modelRole: options.modelRole,
		signal,
		onProgress: options.onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		softRequestBudget: 0,
		softRequestBudgetNotice: false,
		maxRuntimeMs: options.maxRuntimeMs ?? 0,
	});

	if (options.eventBus) {
		options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id,
			agent: agent.name,
			parentToolCallId: options.parentToolCallId,
			detached: true,
			agentSource: agent.source,
			description: options.description,
			status: "started",
			sessionFile,
			index,
		});
	}

	monitor.setActiveSession(session);
	const unsubscribe = monitor.attach(session);
	let outcome: DriveOutcome;
	try {
		outcome = await driveSessionToCompletion(session, monitor, message);
	} finally {
		try {
			await untilAborted(AbortSignal.timeout(5000), () => monitor.waitForActiveSessionAbort());
		} catch {
			// Ignore abort cleanup timeouts; the session stays adopted either way.
		}
		unsubscribe();
		const active = monitor.takeActiveSession();
		if (active) monitor.captureSalvage(active);
		monitor.finish();
	}

	return finalizeRunResult({
		monitor,
		done: {
			...outcome,
			abortReason: outcome.abortReasonText,
			durationMs: Date.now() - startTime,
		},
		index,
		id,
		agent,
		task: message,
		modelRole: options.modelRole,
		outputSchema: options.outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: true,
		sessionFile,
		startTime,
	});
}

/**
 * Run a single agent in-process.
 */
export async function runSubprocess(options: ExecutorOptions): Promise<SingleResult> {
	const {
		cwd,
		agent,
		task,
		assignment,
		index,
		id,
		worktree,
		modelOverride,
		modelRole,
		thinkingLevel,
		outputSchema,
		enableLsp,
		signal,
		onProgress,
	} = options;
	const startTime = Date.now();
	// Set by the session's onFirstChatDispatch hook the first time the agent
	// loop dispatches a chat request to the provider — the launch-complete boundary.
	let firstChatDispatchAt: number | undefined;

	// Check if already aborted
	if (signal?.aborted) {
		return {
			index,
			id,
			agent: agent.name,
			agentSource: agent.source,
			task,
			assignment,
			description: options.description,
			exitCode: 1,
			output: "",
			stderr: "Cancelled before start",
			truncated: false,
			durationMs: 0,
			tokens: 0,
			requests: 0,
			modelOverride,
			modelRole,
			error: "Cancelled before start",
			aborted: true,
			abortReason: "Cancelled before start",
		};
	}

	// Set up artifact paths and write input file upfront if artifacts dir provided
	let subtaskSessionFile: string | undefined;
	if (options.artifactsDir) {
		subtaskSessionFile = path.join(options.artifactsDir, `${id}.jsonl`);
	}

	const settings = options.settings ?? Settings.isolated();
	const subagentSettings = createSubagentSettings(
		settings,
		// Isolated runs must not expose roots outside the worktree.
		worktree === undefined ? undefined : { "workspace.additionalDirectories": [] },
		options.parentServiceTier,
	);
	const maxRecursionDepth = settings.get("task.maxRecursionDepth") ?? 2;
	const maxRuntimeMs = Math.max(
		0,
		Math.trunc(Number(options.maxRuntimeMs ?? settings.get("task.maxRuntimeMs") ?? 0) || 0),
	);
	// TTL before an adopted idle subagent is parked by the lifecycle manager.
	// <= 0 disables parking (the session stays live until process teardown).
	const agentIdleTtlMs = Math.trunc(Number(settings.get("task.agentIdleTtlMs") ?? 420_000) || 0);
	const configuredDefaultBudget = Math.max(
		0,
		Math.trunc(Number(settings.get("task.softRequestBudget") ?? SOFT_REQUEST_BUDGET.default) || 0),
	);
	const softRequestBudget = resolveSoftRequestBudget(agent.name, configuredDefaultBudget);
	const softRequestBudgetNotice = settings.get("task.softRequestBudgetNotice") ?? false;
	const parentDepth = options.taskDepth ?? 0;
	const childDepth = parentDepth + 1;
	const atMaxDepth = maxRecursionDepth >= 0 && childDepth >= maxRecursionDepth;
	const ircEnabled = options.enableIrc !== false && isIrcEnabled(subagentSettings, childDepth);

	const modelPatterns = normalizeModelPatterns(modelOverride ?? agent.model);
	const sessionFile = subtaskSessionFile ?? null;
	const spawnsEnv = atMaxDepth
		? ""
		: agent.spawns === undefined
			? ""
			: agent.spawns === "*"
				? "*"
				: agent.spawns.join(",");

	const lspEnabled = enableLsp ?? true;

	const monitor = createSubagentRunMonitor({
		index,
		id,
		agent,
		task,
		assignment,
		description: options.description,
		modelRegistry: options.modelRegistry,
		settings,
		modelOverride,
		modelRole,
		signal,
		onProgress,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		softRequestBudget,
		softRequestBudgetNotice,
		maxRuntimeMs,
	});
	const progress = monitor.progress;
	let unsubscribe: (() => void) | null = null;
	let reviveSession: AgentReviver | null = null;
	// Adopted (kept-alive) subagents flip registry status from session events on
	// later turns: revive/wake → running, turn drained → idle. The subscription
	// intentionally survives this run; a disposed session emits nothing, so it
	// needs no teardown.
	const installRegistryStatusSync = (target: AgentSession): void => {
		target.subscribe(event => {
			if (event.type === "agent_start") {
				AgentRegistry.global().setStatus(id, "running", target);
			} else if (event.type === "agent_end") {
				AgentRegistry.global().setStatus(id, "idle", target);
			}
		});
	};
	const installIrcWakeTurnMonitor = (target: AgentSession): void => {
		attachIrcWakeTurnMonitor(target, {
			id,
			index,
			agent,
			description: options.description,
			modelOverride,
			modelRole,
			eventBus: options.eventBus,
			parentToolCallId: options.parentToolCallId,
			sessionFile: subtaskSessionFile,
			maxRuntimeMs,
			outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			outputSchemaSource: options.outputSchemaSource,
			artifactsDir: options.artifactsDir,
		});
	};

	const runSubagent = async (): Promise<{
		exitCode: number;
		error?: string;
		aborted?: boolean;
		abortReason?: string;
		abortOverridesYield?: boolean;
		durationMs: number;
	}> => {
		const sessionAbortController = new AbortController();
		const abortSignal = monitor.abortSignal;
		let exitCode = 0;
		let error: string | undefined;
		let aborted = false;
		let abortReasonText: string | undefined;
		let abortOverridesYield = false;
		const checkAbort = () => {
			if (abortSignal.aborted) {
				throw new ToolAbortError();
			}
		};
		const awaitAbortable = async <T>(promise: Promise<T>): Promise<T> => {
			checkAbort();
			const { promise: abortPromise, reject } = Promise.withResolvers<never>();
			const onAbort = () => {
				try {
					checkAbort();
				} catch (err) {
					reject(err);
				}
			};
			abortSignal.addEventListener("abort", onAbort, { once: true });
			try {
				return await Promise.race([promise, abortPromise]);
			} finally {
				abortSignal.removeEventListener("abort", onAbort);
			}
		};
		// Launch-latency phase marks (performance.now()); read by the debug log
		// emitted before this closure returns. Left undefined when setup throws
		// before reaching the phase, which itself localizes the cost.
		const perfStart = performance.now();
		let resolvedAt: number | undefined;
		let sessionOpenedAt: number | undefined;
		let sessionCreatedAt: number | undefined;
		let readyAt: number | undefined;

		try {
			checkAbort();
			// Pin authStorage to modelRegistry.authStorage — mirrors the createAgentSession invariant.
			const registryFromParent = options.modelRegistry !== undefined;
			const modelRegistry =
				options.modelRegistry ??
				new ModelRegistry(options.authStorage ?? (await awaitAbortable(discoverAuthStorage())));
			const authStorage = modelRegistry.authStorage;
			if (options.authStorage && options.authStorage !== authStorage) {
				throw new Error(
					"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
				);
			}
			checkAbort();
			if (!registryFromParent) {
				modelRegistry.refreshInBackground();
			} else {
				logger.debug("runSubagent: reusing parent modelRegistry; skipping refresh");
			}
			checkAbort();

			const configuredModelPatterns = resolveConfiguredModelPatterns(modelPatterns, settings);
			const defaultRetryFallbackChain =
				configuredModelPatterns.length === 1
					? resolveSubagentDefaultRetryFallbackChain(subagentSettings, modelRegistry)
					: undefined;
			const {
				model,
				thinkingLevel: resolvedThinkingLevel,
				explicitThinkingLevel,
				authFallbackUsed,
				warning: modelResolutionWarning,
			} = await awaitAbortable(
				resolveModelOverrideWithAuthFallback(
					modelPatterns,
					options.parentActiveModelPattern,
					modelRegistry,
					settings,
					id,
				),
			);
			if (modelResolutionWarning) {
				logger.warn("Subagent model resolution warning", {
					warning: modelResolutionWarning,
					requested: modelPatterns,
				});
			}
			if (authFallbackUsed && model) {
				logger.warn("Subagent model has no working credentials; falling back to parent session model", {
					requested: modelPatterns,
					parentModel: options.parentActiveModelPattern,
					resolvedProvider: model.provider,
					resolvedModel: model.id,
				});
			}
			const retryFallbackRole = installSubagentRetryFallbackChain({
				settings: subagentSettings,
				id,
				candidates: resolveSubagentRetryFallbackCandidates(modelPatterns, modelRegistry, subagentSettings),
				defaultFallbackChain: defaultRetryFallbackChain,
				model,
				authFallbackUsed,
			});
			if (retryFallbackRole) {
				logger.debug("Configured subagent runtime model fallback chain", {
					role: retryFallbackRole,
					requested: modelPatterns,
				});
			}
			if (model?.contextWindow && model.contextWindow > 0) {
				progress.contextWindow = model.contextWindow;
			}
			// Caller-requested coarse effort maps onto the resolved model's
			// supported range, then respects the operator-configured ceiling.
			// Undefined (no effort, or no controllable effort surface) falls
			// through to the normal selectors below.
			// The ceiling outlives initial resolution: it rides into the session so
			// retry-fallback recovery can never clamp effort back up past it.
			const spawnEffortCeiling = options.effort !== undefined ? settings.get("task.maxEffort") : undefined;
			const effortLevel =
				options.effort !== undefined
					? resolveTaskEffortLevel(model, options.effort, spawnEffortCeiling)
					: undefined;
			if (model) {
				const displayLevel = effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : undefined);
				progress.resolvedModel =
					displayLevel !== undefined
						? formatModelSelectorValue(formatModelStringWithRouting(model), displayLevel)
						: formatModelStringWithRouting(model);
			}
			// Precedence: caller `effort` > explicit `:level` suffix on the resolved
			// model pattern > agent-definition default (e.g. task's `auto`) >
			// pattern-derived level.
			const effectiveThinkingLevel =
				effortLevel ?? (explicitThinkingLevel ? resolvedThinkingLevel : (thinkingLevel ?? resolvedThinkingLevel));
			resolvedAt = performance.now();
			const effectiveCwd = worktree ?? cwd;
			const sessionManagerPromise = sessionFile
				? SessionManager.open(sessionFile, undefined, undefined, {
						initialCwd: effectiveCwd,
						suppressBreadcrumb: true,
					})
				: Promise.resolve(SessionManager.inMemory(effectiveCwd));
			// Setup below can fail before this promise's consumption boundary.
			// Observe rejection immediately while preserving it for the later await.
			sessionManagerPromise.catch(() => {});

			const enableMCP = options.enableMCP ?? true;
			const mcpManager = enableMCP ? options.mcpManager : undefined;

			// Derive subagent-scoped telemetry from the parent's config so the
			// child loop's spans nest under the parent's active execute_tool span
			// (OTEL context propagation handles parent linkage automatically),
			// carry the subagent's own agent identity, and use the subagent's
			// own session id for `gen_ai.conversation.id`.
			const subagentAgentIdentity: AgentIdentity | undefined = options.parentTelemetry
				? {
						id,
						name: agent.name,
						description: agent.description,
					}
				: undefined;
			const subagentTelemetry: AgentTelemetryConfig | undefined =
				options.parentTelemetry && subagentAgentIdentity
					? {
							...options.parentTelemetry,
							agent: subagentAgentIdentity,
							// Clear parent's conversationId; the child loop falls back to
							// its own AgentLoopConfig.sessionId.
							conversationId: undefined,
						}
					: undefined;

			if (options.parentTelemetry && subagentAgentIdentity) {
				const parentTelemetryHandle = resolveTelemetry(
					options.parentTelemetry,
					options.parentTelemetry.conversationId,
				);
				recordHandoff(parentTelemetryHandle, {
					fromAgent: options.parentTelemetry.agent,
					toAgent: subagentAgentIdentity,
				});
			}

			const { normalized: normalizedOutputSchema } = normalizeSchema(outputSchema);
			const restrictedExtensionPaths = options.restrictedExtensionPaths ?? [];

			// Captured by the lifecycle reviver: rebuilding an equivalent session from
			// the same JSONL file re-invokes createAgentSession with the exact options
			// of the original run (same agent id, tools, model, system prompt,
			// artifacts dir) — only the SessionManager differs.
			const buildSubagentSessionOptions = (
				sessionManagerForRun: SessionManager,
				expectedAgentRef: CreateAgentSessionOptions["expectedAgentRef"],
			): CreateAgentSessionOptions => ({
				cwd: worktree ?? cwd,
				additionalDirectories: worktree !== undefined ? undefined : options.additionalDirectories,
				authStorage,
				modelRegistry,
				getApiKey: options.getApiKey,
				settings: subagentSettings,
				coordinationBackend: options.coordinationBackend,
				model,
				modelPattern: model || modelOverride === undefined ? undefined : modelPatterns,
				modelPatternAuthFallback:
					model || modelOverride === undefined ? undefined : options.parentActiveModelPattern,
				modelPatternFallbackRole:
					model || modelOverride === undefined ? undefined : `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`,
				modelPatternDefaultFallbackChain:
					model || modelOverride === undefined ? undefined : defaultRetryFallbackChain,
				thinkingLevel: effectiveThinkingLevel,
				thinkingLevelCeiling: spawnEffortCeiling,
				outputSchema,
				outputSchemaMode: options.outputSchemaMode,
				contextFiles: options.contextFiles,
				skills: options.skills,
				promptTemplates: options.promptTemplates,
				workspaceTree: options.workspaceTree,
				rules: options.rules,
				preloadedExtensionPaths: [...(options.preloadedExtensionPaths ?? []), ...restrictedExtensionPaths],
				systemPrompt: defaultPrompt => {
					const subagentPrompt = prompt.render(subagentSystemPromptTemplate, {
						agent: agent.systemPrompt,
						context: options.context?.trim() ?? "",
						worktree: worktree ?? "",
						outputSchema: normalizedOutputSchema,
						outputSchemaOverridesAgent: options.outputSchemaOverridesAgent === true,
						ircPeers: ircEnabled ? renderIrcPeerRoster(id) : "",
						ircSelfId: ircEnabled ? id : "",
					});
					return defaultPrompt.length === 0
						? [subagentPrompt]
						: [...defaultPrompt.slice(0, -1), subagentPrompt, defaultPrompt[defaultPrompt.length - 1]];
				},
				sessionManager: sessionManagerForRun,
				hasUI: false,
				spawns: spawnsEnv,
				taskDepth: childDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
				parentTaskPrefix: id,
				parentAgentId: options.parentAgentId,
				agentId: id,
				agentDisplayName: options.description ?? agent.name,
				expectedAgentRef,
				enableLsp: lspEnabled,
				enableIrc: options.enableIrc,
				enableMCP,
				mcpManager,
				localProtocolOptions: options.localProtocolOptions,
				telemetry: subagentTelemetry,
				onFirstChatDispatch: () => {
					firstChatDispatchAt ??= performance.now();
				},
			});

			const sessionManager = await awaitAbortable(sessionManagerPromise);
			if (options.parentArtifactManager) {
				sessionManager.adoptArtifactManager(options.parentArtifactManager);
			}
			sessionOpenedAt = performance.now();

			const sessionPromise = createAgentSession(buildSubagentSessionOptions(sessionManager, null));
			let session: AgentSession;
			try {
				({ session } = await awaitAbortable(sessionPromise));
			} catch (err) {
				// Abort raced session startup. The session may still resolve later
				// holding live LSP/MCP child processes — dispose it when it does so
				// a cancelled subagent cannot leak them.
				void sessionPromise.then(created => created.session.dispose()).catch(() => {});
				throw err;
			}
			sessionCreatedAt = performance.now();
			options.onSessionCreated?.(session.sessionId);

			monitor.setActiveSession(session);
			installRegistryStatusSync(session);
			if (options.onAdmission) {
				const admittedSessionFile = session.sessionManager.getSessionFile();
				const admittedModel =
					progress.resolvedModel ??
					(session.model ? formatModelStringWithRouting(session.model) : undefined) ??
					(typeof options.modelOverride === "string" ? options.modelOverride : options.modelOverride?.[0]);
				if (!admittedModel) throw new Error(`Subagent ${id} started without a resolved model.`);
				options.onAdmission({
					id,
					name: id,
					sessionId: session.sessionManager.getSessionId(),
					sessionDir: admittedSessionFile
						? path.dirname(admittedSessionFile)
						: session.sessionManager.getSessionDir(),
					...(admittedSessionFile ? { sessionFile: admittedSessionFile } : {}),
					model: admittedModel,
					cwd: worktree ?? options.cwd,
				});
			}
			if (sessionFile !== null && worktree === undefined) {
				// Lifecycle reviver: park closed the JSONL writer, so reopening takes
				// the single-writer lock cleanly and restores the full message history
				// (createAgentSession → agent.replaceMessages). Isolated runs are not
				// resumable (worktree is merged + cleaned) and never get a reviver.
				reviveSession = async expectedAgentRef => {
					const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
						suppressBreadcrumb: true,
					});
					if (options.parentArtifactManager) {
						reopened.adoptArtifactManager(options.parentArtifactManager);
					}
					const { session: revived } = await createAgentSession(
						buildSubagentSessionOptions(reopened, expectedAgentRef),
					);
					installRegistryStatusSync(revived);
					installIrcWakeTurnMonitor(revived);
					return revived;
				};
			}

			// Emit lifecycle start event
			if (options.eventBus) {
				options.eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
					id,
					agent: agent.name,
					parentToolCallId: options.parentToolCallId,
					detached: options.detached,
					agentSource: agent.source,
					description: options.description,
					status: "started",
					sessionFile: subtaskSessionFile,
					index,
				});
			}

			session.sessionManager.appendSessionInit({
				systemPrompt: session.agent.state.systemPrompt.join("\n\n"),
				task,
				tools: ["ipython"],
				agent: agent.name,
				modelRole: modelRole ?? resolveExplicitModelRole(modelOverride ?? agent.model, subagentSettings),
				resolvedModel: progress.resolvedModel,
				readOnly: isReadOnlyAgent(agent),
				spawns: spawnsEnv,
				outputSchema,
				outputSchemaMode: options.outputSchemaMode,
			});

			abortSignal.addEventListener(
				"abort",
				() => {
					void monitor.abortActiveSession();
				},
				{ once: true, signal: sessionAbortController.signal },
			);
			// Defensive: if the wall-clock timer (or external signal) fired during
			// the awaited setup above, the listener registration races the dispatch
			// and may not observe the already-fired abort event. Mirror it manually.
			if (abortSignal.aborted) {
				void monitor.abortActiveSession();
			}

			const pendingExtensionMessages: Array<Promise<unknown>> = [];
			const extensionRunner = session.extensionRunner;
			if (extensionRunner) {
				extensionRunner.initialize(
					{
						sendMessage: (message, options) => {
							const sendPromise = session.sendCustomMessage(message, options).catch(e => {
								logger.error("Extension sendMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						sendUserMessage: (content, options) => {
							const sendPromise = session.sendUserMessage(content, options).catch(e => {
								logger.error("Extension sendUserMessage failed", {
									error: e instanceof Error ? e.message : String(e),
								});
							});
							pendingExtensionMessages.push(sendPromise);
						},
						appendEntry: (customType, data) => {
							session.sessionManager.appendCustomEntry(customType, data);
						},
						setLabel: (targetId, label) => {
							session.sessionManager.appendLabelChange(targetId, label);
						},
						getCommands: () => getSessionSlashCommands(session),
						setModel: model => runExtensionSetModel(session, model),
						getThinkingLevel: () => session.thinkingLevel,
						setThinkingLevel: level => session.setThinkingLevel(level),
						getServiceTiers: () => session.serviceTierByFamily,
						setServiceTier: (family, tier) => session.setServiceTierFamily(family, tier),
						getSessionName: () => session.sessionManager.getSessionName(),
						setSessionName: async name => {
							await session.sessionManager.setSessionName(name, "user");
						},
					},
					{
						getModel: () => session.model,
						isIdle: () => !session.isStreaming,
						abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
						hasPendingMessages: () => session.queuedMessageCount > 0,
						shutdown: () => {},
						getContextUsage: () => session.getContextUsage(),
						getSystemPrompt: () => session.systemPrompt,
						compact: instructionsOrOptions => runExtensionCompact(session, instructionsOrOptions),
					},
				);
				extensionRunner.onError(err => {
					logger.error("Extension error", {
						path: err.extensionPath,
						error: err.error,
					});
				});
				await awaitAbortable(extensionRunner.emit({ type: "session_start" }));
				while (pendingExtensionMessages.length > 0) {
					await awaitAbortable(Promise.all(pendingExtensionMessages.splice(0)));
				}
			}

			unsubscribe = monitor.attach(session);

			checkAbort();
			// Autoload skills via sendCustomMessage (same mechanic as /skill:<name>)
			if (options.autoloadSkills?.length) {
				for (const skill of options.autoloadSkills) {
					const { message } = await buildSkillPromptMessage(skill, "", "autoload");
					await session.sendCustomMessage(
						{
							customType: SKILL_PROMPT_MESSAGE_TYPE,
							content: message,
							display: false,
							details: { name: skill.name, path: skill.filePath },
						},
						{ triggerTurn: false },
					);
				}
			}

			readyAt = performance.now();
			const outcome = await driveSessionToCompletion(session, monitor, task);
			exitCode = outcome.exitCode;
			error = outcome.error;
			aborted = outcome.aborted;
			abortReasonText = outcome.abortReasonText;
		} catch (err) {
			exitCode = 1;
			if (!abortSignal.aborted) {
				error = err instanceof Error ? err.stack || err.message : String(err);
			}
		} finally {
			const cleanupDeadlineAt = Date.now() + TASK_ABORT_CLEANUP_GRACE_MS;
			const cleanupChangeStatus =
				worktree === undefined
					? "This task was not isolated, so its changes may remain in the working directory."
					: "No isolated changes were applied.";
			const lateCleanups: Promise<void>[] = [];
			let deferredSessionShutdown: Promise<void> | undefined;
			const deferCleanup = (completion: Promise<void>): void => {
				lateCleanups.push(completion);
				exitCode = 1;
				aborted = true;
				abortOverridesYield = true;
				abortReasonText = `cleanup exceeded ${TASK_ABORT_CLEANUP_GRACE_MS} ms`;
				error ??= `Task aborted. Cleanup did not finish within ${TASK_ABORT_CLEANUP_GRACE_MS} ms. ${cleanupChangeStatus}`;
			};
			if (abortSignal.aborted) {
				aborted = monitor.isAbortedRun();
				if (aborted) {
					abortReasonText ??= monitor.resolveAbortReasonText();
				}
				if (exitCode === 0) exitCode = 1;
			}
			sessionAbortController.abort();
			const activeSessionAbort = monitor.waitForActiveSessionAbort();
			try {
				await untilAborted(
					AbortSignal.timeout(Math.max(0, cleanupDeadlineAt - Date.now())),
					() => activeSessionAbort,
				);
			} catch (cleanupError) {
				if (Date.now() >= cleanupDeadlineAt) {
					deferCleanup(activeSessionAbort);
				} else {
					logger.warn("Subagent abort cleanup failed", {
						id,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
			if (unsubscribe) {
				try {
					unsubscribe();
				} catch {
					// Ignore unsubscribe errors
				}
				unsubscribe = null;
			}
			const jobManager = AsyncJobManager.instance();
			if (jobManager) {
				const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
				if (!reap.settled) {
					deferCleanup(reap.completion);
					logger.warn("Subagent async job cleanup exceeded its deadline", {
						id,
						pendingJobIds: reap.pendingJobIds,
					});
				}
			}
			const session = monitor.takeActiveSession();
			if (session) {
				monitor.captureSalvage(session);
				if (options.keepAlive !== false && worktree === undefined) {
					installIrcWakeTurnMonitor(session);
				}
				await finalizeSubagentLifecycle({
					id,
					session,
					aborted,
					abortKind: monitor.abortKind(),
					keepAlive: options.keepAlive !== false,
					isolated: worktree !== undefined,
					agentIdleTtlMs,
					reviveSession,
					cleanupDeadlineAt,
					onCleanupDeferred: completion => {
						deferredSessionShutdown = completion;
						deferCleanup(completion);
					},
				});
			}
			if (jobManager) {
				if (deferredSessionShutdown) {
					const finalReap = Promise.allSettled([deferredSessionShutdown]).then(async () => {
						const reap = await jobManager.cancelAndReapOwnerJobs(id, Date.now());
						await reap.completion;
					});
					lateCleanups.push(finalReap);
				} else {
					const reap = await jobManager.cancelAndReapOwnerJobs(id, cleanupDeadlineAt);
					if (!reap.settled) {
						deferCleanup(reap.completion);
						logger.warn("Subagent async job cleanup exceeded its deadline after session shutdown", {
							id,
							pendingJobIds: reap.pendingJobIds,
						});
					}
				}
			}
			if (lateCleanups.length > 0) {
				const completion = Promise.allSettled(lateCleanups).then(() => {});
				trackLateCleanup(completion, { id, resource: "subagent" });
				options.onCleanupDeferred?.(completion);
			}
		}

		// Launch-latency breakdown (subagent invocation → first chat dispatch).
		// Phase deltas are performance.now() spans; the subagent concurrency
		// brackets use the Date.now epochs captured by the spawn site
		// (invokedAt before acquire, acquiredAt after) so queue wait and
		// pre-run setup are reported apart.
		const span = (from: number | undefined, to: number | undefined): number | undefined =>
			from !== undefined && to !== undefined ? Math.round(to - from) : undefined;
		const queueMs =
			options.invokedAt !== undefined && options.acquiredAt !== undefined
				? Math.round(options.acquiredAt - options.invokedAt)
				: undefined;
		const preRunMs = options.acquiredAt !== undefined ? Math.round(startTime - options.acquiredAt) : undefined;
		const setupToFirstChatMs = span(perfStart, firstChatDispatchAt);
		const invokeToFirstChatMs =
			options.invokedAt !== undefined && setupToFirstChatMs !== undefined
				? Math.round(startTime - options.invokedAt) + setupToFirstChatMs
				: undefined;
		logger.debug("subagent launch timing", {
			id,
			agent: agent.name,
			queueMs,
			preRunMs,
			resolveMs: span(perfStart, resolvedAt),
			sessionOpenMs: span(resolvedAt, sessionOpenedAt),
			createSessionMs: span(sessionOpenedAt, sessionCreatedAt),
			readyMs: span(sessionCreatedAt, readyAt),
			promptToFirstChatMs: span(readyAt, firstChatDispatchAt),
			setupToFirstChatMs,
			invokeToFirstChatMs,
		});
		return {
			exitCode,
			error,
			aborted,
			abortOverridesYield,
			abortReason: aborted ? abortReasonText : undefined,
			durationMs: Date.now() - startTime,
		};
	};

	const done = await runSubagent();
	monitor.finish();

	const result = await finalizeRunResult({
		monitor,
		done,
		index,
		id,
		agent,
		task,
		assignment,
		modelOverride,
		modelRole,
		outputSchema,
		outputSchemaMode: options.outputSchemaMode,
		outputSchemaSource: options.outputSchemaSource,
		signal,
		artifactsDir: options.artifactsDir,
		eventBus: options.eventBus,
		parentToolCallId: options.parentToolCallId,
		detached: options.detached,
		sessionFile: subtaskSessionFile,
		startTime,
	});
	AgentRegistry.global().setHistory(id, { outputPath: result.outputPath });
	return result;
}

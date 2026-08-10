/**
 * Task service - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */
import path from "node:path";
import { realizesPriorityServiceTier, type ServiceTierFamily, serviceTierFamily, type Usage } from "@oh-my-pi/pi-ai";
import { $env, logger, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "..";
import { formatModelSelectorValue, formatModelString, resolveModelRoleValue } from "../config/model-resolver";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import taskAsyncContractTemplate from "../prompts/tools/task-async-contract.md" with { type: "text" };
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { TASK_EFFORTS, type TaskEffort } from "../thinking";
import { isIrcEnabled } from "../tools/hub";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { isScoutSpawnable, resolveSpawnPolicy } from "./spawn-policy";
import {
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskRunDetails,
	type TaskSchemaInstance,
} from "./types";
// Import review tools for side effects (registers subagent tool handlers)
import "../tools/review";
import type { AsyncJobManager } from "../async";
import { hasResolvableTranscript } from "../internal-urls/registry-helpers";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../session/messages";
import type {
	SubagentRuntimeAdmission,
	TaskAdmissionRequest,
	TaskAdmissionService,
	TaskChildAdmission,
	TaskChildProjection,
	TaskIsolationControls,
	TaskModelProjection,
} from "./admission";
import { generateTaskName } from "./name-generator";

const RLM_SERVICE_TIERS = ["auto", "default", "flex", "scale", "priority"] as const;
type RlmServiceTier = (typeof RLM_SERVICE_TIERS)[number];

import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimitAllSettled, Semaphore } from "./parallel";
import { repairTaskParams } from "./repair-args";
import { resolveEffectiveSubagentPolicy, runStructuredSubagent, StructuredSubagentError } from "./structured-subagent";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentUserPromptTemplate, {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

// Re-export types and utilities
export type {
	SubagentRuntimeAdmission,
	TaskAdmissionRequest,
	TaskAdmissionService,
	TaskChildAdmission,
	TaskChildProjection,
	TaskIsolationControls,
	TaskModelProjection,
} from "./admission";
export { isTaskAdmissionService } from "./admission";
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export * from "./read-only-policy";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskRunDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

/** Result returned by the Task service and serialized by its external bridge. */
export interface TaskSpawnResult {
	content: Array<{ type: string; text?: string }>;
	details?: TaskRunDetails;
	isError?: boolean;
}

/** Receives a complete progress snapshot while a Task spawn is active. */
export type TaskSpawnUpdateCallback = (result: TaskSpawnResult) => void | Promise<void>;

interface StructuredSpawnOverrides {
	model?: string;
	serviceTier?: TaskAdmissionRequest["serviceTier"];
	isolation?: TaskIsolationControls;
	keepAlive?: boolean;
	onAdmission?: (admission: SubagentRuntimeAdmission) => void;
}

function childStatus(status: AgentRef["status"]): TaskChildProjection["status"] {
	if (status === "running") return "running";
	if (status === "aborted") return "error";
	return "completed";
}

function abortMessage(signal: AbortSignal): string {
	return signal.reason instanceof Error ? signal.reason.message : "RLM admission was interrupted";
}

function createTaskModeError(text: string): TaskSpawnResult {
	return {
		content: [{ type: "text", text }],
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
	};
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/**
 * Reject legacy fields and shape/configuration combinations the Task service
 * cannot accept. `outputSchema` is a first-class per-spawn field; stale
 * `schema` is a removed alias and is rejected.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if (Object.hasOwn(params, "schema")) {
		return "Task spawn uses `outputSchema`; rename the stale `schema` field.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the Task spawn does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the external MCP shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */

/** Reject an out-of-range `effort` selector on internal/stale-transcript calls that bypass the wire schema. */
function validateEffort(effort: TaskEffort | undefined, label: string): string | undefined {
	if (effort === undefined || TASK_EFFORTS.includes(effort)) return undefined;
	return `${label} has an invalid \`effort\` value ${JSON.stringify(effort)}. Use "lo", "med", or "hi".`;
}

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
		}
		if (hasTask) {
			return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
		for (let i = 0; i < tasks.length; i++) {
			const item = tasks[i];
			if (!item || typeof item.task !== "string" || item.task.trim() === "") {
				return `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} is missing \`task\`. Every task needs complete, self-contained instructions.`;
			}
			const effortError = validateEffort(item.effort, `Task ${i + 1}${item.name ? ` (\`${item.name}\`)` : ""}`);
			if (effortError) return effortError;
		}
		const seen = new Map<string, string>();
		for (const item of tasks) {
			const name = item.name?.trim();
			if (!name) continue;
			const key = name.toLowerCase();
			const existing = seen.get(key);
			if (existing !== undefined) {
				return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
			}
			seen.set(key, name);
		}
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `task`. Provide complete, self-contained instructions for the agent.";
	}
	return validateEffort(params.effort, "The call");
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — `#runSpawn`
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = {
		name: params.name,
		agent: params.agent,
		task: params.task,
	};
	if ("outputSchema" in params) item.outputSchema = params.outputSchema;
	if ("schemaMode" in params) item.schemaMode = params.schemaMode;
	if ("effort" in params) item.effort = params.effort;
	if ("isolated" in params) item.isolated = params.isolated;
	return [item];
}

/**
 * Per-spawn params handed to the executor path: top-level call fields with the
 * item's identity substituted in. Each spawn's `agent` resolves here —
 * the item's own value, else `defaultAgent` from the session spawn policy.
 * `tasks` never leaks into a spawn; the shared `context` rides along
 * unchanged. Keys are only materialized when present — `#runSpawn`
 * distinguishes an absent `isolated` from an explicit one. The item's
 * `isolated` (batch form) wins over the top-level flag (flat form).
 */
function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if ("outputSchema" in item) spawn.outputSchema = item.outputSchema;
	if ("schemaMode" in item) spawn.schemaMode = item.schemaMode;
	if ("effort" in item) spawn.effort = item.effort;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	return spawn;
}

/** One sync-executed spawn: its item, position in the original call, and (for mixed calls) a pre-claimed agent id. */
interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

/** Merged view of a sync spawn set's payloads: joined text plus flattened results/usage/paths. */
interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
}

/**
 * Merge per-spawn sync payloads into one result view. `index` is each spawn's
 * position in the original call so batch rows keep stable ordering; a missing
 * payload (cancelled before start) becomes an explanatory content line.
 */
function mergeSyncPayloads(spawns: SyncSpawnRef[], payloads: (TaskSpawnResult | undefined)[]): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
	};
}

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["task", "sonic"]);

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	scoutAvailable = true,
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialist = scoutAvailable
		? `Check the agent list for a closer specialist type — e.g. read-only research belongs on ` +
			`\`agent: "scout"\`, which runs on a faster model.`
		: `Check the agent list for a closer specialist type.`;
	return `Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ${specialist}`;
}

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via the
 * hub when one call creates ≥2 live siblings and it still holds spawn
 * capacity. Returns undefined when there is nothing to coordinate or peer
 * messaging is unavailable.
 */
export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`hub\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`hub\` op:"list" to see who is doing what.`
	);
}

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
export function composeSpawnAdvisory(args: {
	agents: string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
	scoutAvailable?: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.scoutAvailable),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

/** Sentinel for async jobs whose subagent finished with a failing result; progress is already updated. */
class TaskJobError extends Error {}

// ═══════════════════════════════════════════════════════════════════════════
// Task Service
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Session-local owner for subagent spawning and RLM admission.
 *
 * A call may start one subagent or a settings-enabled batch. Async-enabled
 * sessions register background jobs; otherwise the service waits for results.
 */
export class TaskService implements TaskAdmissionService {
	/**
	 * One semaphore per TaskService instance (i.e. per session): bounds concurrent
	 * subagents across direct Task service calls. Resized in place from
	 * `task.maxConcurrency` before every acquire/release so a mid-session settings
	 * change applies to both new spawns and work already parked in the queue.
	 */
	readonly #blockedAgent: string | undefined;
	#spawnSemaphore: Semaphore | undefined;
	/** Non-authoritative session metadata; AgentRegistry remains the only child roster. */
	readonly #admissionMetadata = new Map<string, SubagentRuntimeAdmission>();
	readonly #pendingAdmissionNames = new Set<string>();

	/** Schema exposed only by the deliberate Claude Code MCP bridge. */
	get schema(): TaskSchemaInstance {
		const isolationEnabled = this.session.settings.get("task.isolation.mode") !== "none";
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			effortEnabled: this.session.settings.get("task.enableEffort"),
			defaultAgent,
		});
	}

	private constructor(private readonly session: ToolSession) {
		this.#blockedAgent = $env.PI_BLOCKED_AGENT;
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("task.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("task.maxConcurrency");
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

	/**
	 * Resolve the shared policy before detached work exists. The resulting
	 * policy intentionally stays local: executor dispatch resolves again from
	 * normalized task params rather than smuggling internal policy over the
	 * task wire contract.
	 */
	#resolveSpawnPreflight(params: TaskParams, overrides?: StructuredSpawnOverrides) {
		return resolveEffectiveSubagentPolicy({
			session: this.session,
			assignment: (params.task ?? "").trim(),
			context: this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined,
			agent: params.agent,
			model: overrides?.model,
			...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
			...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...(overrides?.isolation
				? { isolation: overrides.isolation }
				: "isolated" in params
					? { isolation: { requested: params.isolated } }
					: {}),
			blockedAgent: this.#blockedAgent,
			enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
			enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
			maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
		});
	}

	/** Create the session-local Task service. */
	static create(session: ToolSession): TaskService {
		return new TaskService(session);
	}

	#availableModels(): TaskModelProjection[] {
		const bySelector = new Map<string, TaskModelProjection>();
		const registry = this.session.modelRegistry;
		if (!registry) return [];
		for (const model of registry.getAvailable()) {
			const selector = formatModelString(model);
			bySelector.set(selector, {
				provider: model.provider,
				id: model.id,
				name: model.name || model.id,
				selector,
				concreteSelector: selector,
				available: true,
			});
		}
		return [...bySelector.values()].sort((left, right) => left.selector.localeCompare(right.selector));
	}

	/**
	 * Configured role aliases ("@role") projected for RLM model search,
	 * including roles whose concrete model is currently unavailable and an
	 * empty native catalog. `@role` surfaces its resolved provider/id in
	 * {@link TaskModelProjection.concreteSelector} and flips `available` to
	 * false when the role has no runnable model.
	 */
	#roleModelMatches(): TaskModelProjection[] {
		const roles = this.session.settings.getModelRoles();
		const registry = this.session.modelRegistry;
		// Resolve the concrete selector against the full catalog so a role
		// keeps its concreteSelector even when it is not executable right now;
		// availability derives from the executable (getAvailable) catalog.
		const availableModels = registry ? registry.getAvailable() : [];
		const fullModels = registry?.getAll ? registry.getAll() : availableModels;
		const availableSelectors = new Set(availableModels.map(model => formatModelString(model)));
		const out: TaskModelProjection[] = [];
		for (const role of Object.keys(roles).sort()) {
			const selector = `@${role}`;
			const executable = resolveModelRoleValue(roles[role], availableModels, { settings: this.session.settings });
			const catalog = resolveModelRoleValue(roles[role], fullModels, { settings: this.session.settings });
			const resolved = executable.model ? executable : catalog;
			const model = resolved.model;
			const baseSelector = model ? formatModelString(model) : undefined;
			const concreteSelector = baseSelector
				? formatModelSelectorValue(baseSelector, resolved.thinkingLevel)
				: undefined;
			const provider = model?.provider || "unknown";
			const id = model?.id ?? roles[role] ?? role;
			const available =
				executable.model !== undefined && baseSelector !== undefined && availableSelectors.has(baseSelector);
			out.push({
				provider,
				id,
				name: model ? `@${role} → ${concreteSelector}` : `@${role} → ${id}`,
				selector,
				...(concreteSelector ? { concreteSelector } : {}),
				available,
			});
		}
		return out;
	}

	findModels(query: string, limit: number): TaskModelProjection[] {
		const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
		const normalized = normalize(query.trim());
		const candidates = [...this.#roleModelMatches(), ...this.#availableModels()].map(model => {
			const fields = [model.selector, model.concreteSelector ?? "", model.id, model.name].map(normalize);
			let score = normalized ? Number.POSITIVE_INFINITY : 0;
			if (normalized) {
				const exact = fields.indexOf(normalized);
				const prefix = fields.findIndex(field => field.startsWith(normalized));
				const partial = fields.findIndex(field => field.includes(normalized));
				if (exact >= 0) score = exact;
				else if (prefix >= 0) score = 3 + prefix;
				else if (partial >= 0) score = 6 + partial;
			}
			return { model, score };
		});
		return candidates
			.filter(candidate => Number.isFinite(candidate.score))
			.sort((left, right) => left.score - right.score || left.model.selector.localeCompare(right.model.selector))
			.slice(0, limit)
			.map(candidate => candidate.model);
	}

	/** Resolve an admitted RLM model reference to the exact provider/id the spawn should use. */
	#resolveAdmitModel(selector: string | undefined): string | undefined {
		if (selector === undefined) return undefined;
		const trimmed = selector.trim();
		if (!trimmed) throw new Error("RLM model must not be empty");
		if (trimmed.startsWith("@")) {
			const role = trimmed.slice(1);
			const match = this.#roleModelMatches().find(match => match.selector === trimmed);
			if (!match) throw new Error(`RLM model role "@${role}" is not configured`);
			if (!match.concreteSelector || match.available !== true) {
				throw new Error(`RLM model role "@${role}" has no available model`);
			}
			return match.concreteSelector;
		}
		if (!this.#availableModels().some(model => model.selector === trimmed)) {
			throw new Error(
				`RLM model must be one exact selector returned by rlm.find_models(); unavailable selector: ${trimmed}`,
			);
		}
		return trimmed;
	}

	/**
	 * Service tiers (or null to omit) an explicit rlm.run service_tier request
	 * may select. A configured list is authoritative. An absent list falls back
	 * to the effective tier.subagent value for the selected model family.
	 */
	#rlmAllowedServiceTiers(family?: ServiceTierFamily): ReadonlySet<RlmServiceTier | null> {
		const configured = this.session.settings.get("rlmAllowedServiceTiers");
		if (configured.length > 0) {
			for (const tier of configured) {
				if (tier !== null && !(RLM_SERVICE_TIERS as readonly string[]).includes(tier)) {
					throw new Error(`rlmAllowedServiceTiers contains unsupported value ${JSON.stringify(tier)}`);
				}
			}
			return new Set(configured);
		}
		const setting = this.session.settings.get("tier.subagent");
		if (setting === "none") return new Set([null]);
		if (setting !== "inherit" && (RLM_SERVICE_TIERS as readonly string[]).includes(setting)) {
			return new Set([setting as RlmServiceTier]);
		}
		const inherited = family ? this.session.getServiceTierByFamily?.()?.[family] : undefined;
		return new Set<RlmServiceTier | null>([inherited ?? null]);
	}

	#projectChild(ref: AgentRef): TaskChildProjection {
		const admitted = this.#admissionMetadata.get(ref.id);
		const sessionFile = admitted?.sessionFile ?? ref.sessionFile ?? undefined;
		const sessionDir = admitted?.sessionDir ?? (sessionFile ? path.dirname(sessionFile) : this.session.cwd);
		return {
			id: ref.id,
			name: admitted?.name ?? ref.id,
			...(ref.session && admitted?.sessionId ? { activeSessionId: admitted.sessionId } : {}),
			...(admitted?.sessionId ? { sessionId: admitted.sessionId } : {}),
			sessionDir,
			status: childStatus(ref.status),
			lifecycleStatus: ref.status,
			...(admitted?.model || ref.history?.resolvedModel
				? { model: admitted?.model ?? ref.history?.resolvedModel }
				: {}),
		};
	}

	async #directChildren(signal?: AbortSignal): Promise<AgentRef[]> {
		if (signal?.aborted) throw new Error(abortMessage(signal));
		const parentId = this.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const local = (this.session.agentRegistry ?? AgentRegistry.global())
			.list()
			.filter(ref => ref.kind === "sub" && ref.parentId === parentId);
		const backend = this.session.coordinationBackend;
		if (!backend) return local;
		const roster = await backend.listPeers(signal);
		const world = roster.peers.filter(ref => ref.kind === "sub" && ref.parentId === parentId);
		const byId = new Map(local.map(ref => [ref.id, ref]));
		for (const ref of world) {
			if (byId.has(ref.id)) throw new Error(`Child identity conflict between Task and parent: ${ref.id}`);
			byId.set(ref.id, ref);
		}
		const relevantError = roster.errors.find(error => error.peerId === parentId || byId.has(error.peerId));
		if (relevantError) throw new Error(relevantError.detail);
		return [...byId.values()];
	}

	async listDirectChildren(signal?: AbortSignal): Promise<TaskChildProjection[]> {
		const children = await this.#directChildren(signal);
		return children
			.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
			.map(ref => this.#projectChild(ref));
	}

	async deleteDirectChild(target: string, signal?: AbortSignal): Promise<TaskChildProjection> {
		const selector = target.trim();
		if (!selector) throw new Error("RLM child target must be a nonempty string");
		const parentId = this.session.getAgentId?.() ?? MAIN_AGENT_ID;
		const children = await this.#directChildren(signal);
		const matches = children.filter(
			candidate => candidate.id === selector || this.#admissionMetadata.get(candidate.id)?.name === selector,
		);
		if (matches.length === 0) throw new Error(`Direct Task child not found: ${selector}`);
		if (matches.length > 1) throw new Error(`Direct Task child name is ambiguous: ${selector}`);
		const ref = matches[0]!;
		const before = this.#projectChild(ref);
		const registry = this.session.agentRegistry ?? AgentRegistry.global();
		const local = registry.get(ref.id);
		if (local === ref) {
			const manager = this.session.asyncJobManager;
			const job = manager?.getJob(ref.id);
			if (job && job.ownerId === parentId) {
				if (job.status === "running") manager?.cancel(job.id, { ownerId: parentId });
				manager?.acknowledgeDeliveries([job.id]);
				if (signal) await untilAborted(signal, () => job.promise);
				else await job.promise;
			}
			const current = registry.get(ref.id);
			if (current?.kind === "sub" && current.parentId === parentId) {
				if (current.status === "running" && current.session) {
					await current.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				const lifecycle = this.session.agentLifecycle?.();
				if (lifecycle) await lifecycle.release(current.id, current);
				else {
					await current.session?.dispose();
					registry.unregister(current.id, current);
				}
			}
		} else {
			const backend = this.session.coordinationBackend;
			if (!backend) throw new Error(`Direct Task child is no longer registered: ${selector}`);
			await backend.interrupt(ref.id, "Deleted through RLM", signal);
		}
		this.#admissionMetadata.delete(ref.id);
		return { ...before, status: "error", lifecycleStatus: "aborted", activeSessionId: undefined };
	}

	async admit(request: TaskAdmissionRequest): Promise<TaskChildAdmission> {
		if (request.signal?.aborted) throw new Error(abortMessage(request.signal));
		const assignment = request.assignment.trim();
		if (!assignment) throw new Error("RLM prompt must be a nonempty string");
		const requestedName = request.name?.trim();
		if (requestedName && requestedName.length > 64) {
			throw new Error("RLM name must be at most 64 characters");
		}
		const admitModel = this.#resolveAdmitModel(request.model);
		const manager = this.session.asyncJobManager;
		if (!manager) throw new Error("RLM admission requires the session AsyncJobManager");
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const spawnParams: TaskParams = {
			task: assignment,
			agent: defaultAgent,
			...(requestedName ? { name: requestedName } : {}),
		};
		const overrides: StructuredSpawnOverrides = {
			...(admitModel ? { model: admitModel } : {}),
			...(request.isolation ? { isolation: request.isolation } : {}),
			keepAlive: true,
		};
		const policy = await this.#resolveSpawnPreflight(spawnParams, overrides);
		if (request.serviceTier !== undefined) {
			const modelReference =
				admitModel ??
				(typeof policy.modelOverride === "string" ? policy.modelOverride : policy.modelOverride?.[0]) ??
				this.session.getActiveModelString?.();
			const availableModels = this.session.modelRegistry?.getAvailable() ?? [];
			const selectedModel = modelReference
				? resolveModelRoleValue(modelReference, availableModels, { settings: this.session.settings }).model
				: undefined;
			const allowedTiers = this.#rlmAllowedServiceTiers(
				selectedModel ? serviceTierFamily(selectedModel) : undefined,
			);
			if (!allowedTiers.has(request.serviceTier)) {
				const allowed = [...allowedTiers].map(tier => (tier === null ? "null" : tier)).join(", ");
				throw new Error(
					`rlm.run service_tier ${String(request.serviceTier)} is not allowed; allowed values are ${allowed}`,
				);
			}
			overrides.serviceTier =
				request.serviceTier === "priority" &&
				selectedModel &&
				!realizesPriorityServiceTier("priority", selectedModel)
					? "default"
					: request.serviceTier;
		}
		if (request.signal?.aborted) throw new Error(abortMessage(request.signal));
		if (this.session.coordinationBackend && (policy.isIsolated || policy.claudeCode)) {
			throw new Error(
				`unsupported_world_runtime: Parent Task supports only native, non-isolated workers; selected ${policy.claudeCode ? "claude-code" : "isolated"}`,
			);
		}
		if (requestedName) {
			if (this.#pendingAdmissionNames.has(requestedName)) {
				throw new Error(`RLM name ${JSON.stringify(requestedName)} is already in use by a sibling`);
			}
			const duplicate = (await this.#directChildren(request.signal)).some(
				child => (this.#admissionMetadata.get(child.id)?.name ?? child.displayName) === requestedName,
			);
			if (duplicate) throw new Error(`RLM name ${JSON.stringify(requestedName)} is already in use by a sibling`);
			this.#pendingAdmissionNames.add(requestedName);
		}
		try {
			let outputManager = this.session.agentOutputManager;
			if (!outputManager) {
				outputManager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				this.session.agentOutputManager = outputManager;
			}
			const requestedId =
				requestedName && /^[A-Za-z0-9_-]{1,48}$/.test(requestedName) ? requestedName : generateTaskName();
			const agentId = await outputManager.allocate(requestedId);
			const progress: AgentProgress = {
				index: 0,
				id: agentId,
				agent: defaultAgent,
				agentSource: policy.agent.source,
				modelRole: policy.modelRole,
				status: "pending",
				task: renderSubagentUserPrompt(assignment),
				assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
			};
			const details = (): TaskRunDetails => ({
				projectAgentsDir: null,
				results: [],
				totalDurationMs: 0,
				progress: [{ ...progress }],
				async: { state: "running", jobId: agentId, type: "task" },
			});
			const admitted = Promise.withResolvers<TaskChildAdmission>();
			let settled = false;
			let jobId = agentId;
			overrides.onAdmission = runtime => {
				if (settled) return;
				settled = true;
				const metadata = { ...runtime, name: requestedName ?? runtime.name };
				this.#admissionMetadata.set(runtime.id, metadata);
				admitted.resolve({ ...metadata, jobId });
			};
			jobId = this.#registerSpawnJob({
				manager,
				requestId: request.sourceId,
				spawnParams,
				agentId,
				progress,
				ircEnabled: policy.enableIrc,
				buildDetails: details,
				structuredOverrides: overrides,
				onUpdate: update => {
					const text = update.content.find(part => part.type === "text")?.text;
					if (text && request.onProgress) {
						void Promise.resolve(request.onProgress(text)).catch(error =>
							logger.warn("RLM admission progress callback failed", { error: String(error) }),
						);
					}
				},
			});
			const job = manager.getJob(jobId);
			if (!job) throw new Error(`RLM Task job was not registered: ${jobId}`);
			void job.promise.then(() => {
				if (settled) return;
				settled = true;
				admitted.reject(new Error(job.errorText || `RLM Task ${agentId} ended before admission`));
			});
			const abort = () => {
				if (settled) return;
				settled = true;
				manager.cancel(jobId, { ownerId: this.session.getAgentId?.() ?? MAIN_AGENT_ID });
				admitted.reject(new Error(request.signal ? abortMessage(request.signal) : "RLM admission was interrupted"));
			};
			request.signal?.addEventListener("abort", abort, { once: true });
			if (request.signal?.aborted) abort();
			try {
				return await admitted.promise;
			} finally {
				request.signal?.removeEventListener("abort", abort);
			}
		} finally {
			if (requestedName) this.#pendingAdmissionNames.delete(requestedName);
		}
	}

	async spawn(
		requestId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: TaskSpawnUpdateCallback,
	): Promise<TaskSpawnResult> {
		const params = repairTaskParams(rawParams as TaskParams);
		// The external MCP bridge validates its advertised schema, but direct callers
		// may still omit an agent. `spawnParamsFor` resolves each
		// item's agent type against the session's actual default agent.
		const defaultAgent = resolveSpawnPolicy(this.session.getSessionSpawns()).defaultAgent;
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const spawnItems = resolveSpawnItems(params);
		const normalizedSpawnParams = spawnItems.map(item => spawnParamsFor(params, item, defaultAgent));
		const resolvedAgents = normalizedSpawnParams.map(spawn => spawn.agent ?? defaultAgent);
		// Resolve every item before choosing an execution path. No executor or
		// job manager may observe a batch unless every effective policy is valid.
		const preflights = await Promise.all(
			normalizedSpawnParams.map(async spawn => {
				try {
					return { policy: await this.#resolveSpawnPreflight(spawn) };
				} catch (error) {
					return {
						error: error instanceof StructuredSubagentError ? error.message : String(error),
					};
				}
			}),
		);
		const preflightFailures = preflights
			.map((preflight, index) => ("error" in preflight ? { index, error: preflight.error } : undefined))
			.filter((failure): failure is { index: number; error: string } => failure !== undefined);
		if (preflightFailures.length > 0) {
			if (!batchEnabled) {
				return createTaskModeError(`Task execution failed: ${preflightFailures[0]!.error}`);
			}
			return createTaskModeError(
				preflightFailures
					.map(({ index, error }) => {
						const item = spawnItems[index]!;
						return `Task ${item.name?.trim() || `#${index + 1}`} failed preflight: ${error}`;
					})
					.join("\n"),
			);
		}
		const policies = preflights.map(preflight => preflight.policy!);
		if (this.session.coordinationBackend) {
			const unsupportedIndex = policies.findIndex(policy => policy.isIsolated || policy.claudeCode !== undefined);
			if (unsupportedIndex >= 0) {
				const policy = policies[unsupportedIndex]!;
				const runtime = policy.claudeCode ? "claude-code" : "isolated";
				return createTaskModeError(
					`unsupported_parent_runtime: Parent Task supports only native, non-isolated workers; item ${unsupportedIndex + 1} selected ${runtime}`,
				);
			}
		}
		const itemBlocking = policies.map(policy => policy.effectiveAgent.blocking === true);

		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		const depthCapacity = canSpawnAtDepth(
			this.session.settings.get("task.maxRecursionDepth") ?? 2,
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0);

		if (!manager || asyncItems.length === 0) {
			// Sync fallback: async execution disabled, orphaned host that never
			// wired a job manager, or every item's agent type declares
			// `blocking: true`.
			if (asyncEnabled && !this.session.asyncJobManager) {
				logger.warn("task: no AsyncJobManager registered; falling back to sync execution");
			}
			const advisory = this.session.suppressSpawnAdvisory
				? undefined
				: composeSpawnAdvisory({
						agents: resolvedAgents,
						items: asyncItems,
						depthCapacity,
						ircEnabled,
						willRunAsync: false,
						scoutAvailable: isScoutSpawnable(
							this.session.settings.get("task.disabledAgents") as string[] | undefined,
							this.session.getSessionSpawns?.() ?? "*",
						),
					});
			const result = await this.#executeSyncFanout(
				requestId,
				params,
				spawnItems.map((item, index) => ({ item, index })),
				defaultAgent,
				signal,
				onUpdate,
			);
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		}

		// Coordination only makes sense for spawns that keep running after this
		// call returns (the async subset). Blocking items have already completed
		// by then, so a "coordinate while they run" hint would misfire.
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync: asyncItems.length > 0,
					scoutAvailable: isScoutSpawnable(
						this.session.settings.get("task.disabledAgents") as string[] | undefined,
						this.session.getSessionSpawns?.() ?? "*",
					),
				});
		// Returns a fresh result (copied content array, copied text part) rather
		// than mutating the caller's — task results are short-lived here, but an
		// in-place edit on a shared/cached TaskSpawnResult would be a hidden trap.
		const withAdvisory = (result: TaskSpawnResult): TaskSpawnResult => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (asyncItems.length === 0) {
			return withAdvisory(
				await this.#executeSyncFanout(
					requestId,
					params,
					spawnItems.map((item, index) => ({ item, index })),
					defaultAgent,
					signal,
					onUpdate,
				),
			);
		}

		// Async IDs are claimed before job registration, so retain the fallback
		// manager on the session rather than recreating it for every call.
		let outputManager = this.session.agentOutputManager;
		if (!outputManager) {
			outputManager = new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
			this.session.agentOutputManager = outputManager;
		}
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (const [index, item] of spawnItems.entries()) {
			const agentType = resolvedAgents[index]!;
			const policy = policies[index]!;
			const agentSource = policy.agent.source;
			const requestedName = item.name?.trim();
			const agentId =
				this.session.coordinationBackend && requestedName
					? requestedName
					: await outputManager.allocate(requestedName || generateTaskName());
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					modelRole: policy.modelRole,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = [...new Set(asyncSpawns.map(spawn => spawn.progress.agent))].join(", ");

		// Aggregate state for the one tool call. Async spawns report into the
		// shared progress snapshot through their jobs: the async half stays
		// "running" until every job settles, then turns "failed" if any spawn
		// failed. Blocking spawns run inline below and land in `results` before
		// the call returns, so post-return job updates never drop them.
		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskRunDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: [...syncResults],
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task",
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					requestId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task job${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${failedSchedules.length} spawn${failedSchedules.length === 1 ? "" : "s"}: ${failedSchedules.join("; ")}.`
				: "";
		const coordinationHint = [
			started.length === 1
				? ircEnabled
					? `DM \`${started[0].agentId}\` via \`hub\` send to coordinate while it runs; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task.`
				: ircEnabled
					? `DM these ids via \`hub\` send to coordinate while they run; use \`hub\` only to inspect (\`jobs\`), wait, or cancel a stuck task.`
					: `Use \`hub\` to inspect (\`jobs\`), wait, or cancel a stuck task by id.`,
			taskAsyncContractTemplate.trim(),
		].join("\n");

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: `Spawned agent \`${agentId}\` (job \`${jobId}\`). Its result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first. ${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				});
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
				details: buildAsyncDetails(),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${startedListing}\n${coordinationHint}`,
					},
				],
				details: buildAsyncDetails(),
			});
		}

		// Mixed call: the async jobs above already run detached; the blocking
		// subset runs inline and gates the call's return — exactly what each
		// agent type declares (`blocking: true` = the parent waits on it).
		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${syncLabel} inline; ${started.length} background agent${started.length === 1 ? "" : "s"} spawned...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			requestId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({
				item: spawn.item,
				index: spawn.index,
				preAllocatedId: spawn.agentId,
			})),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns.find(candidate => candidate.index === index);
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		syncResults.push(...merged.results);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		// Settle the inline spawns' progress rows from their merged results so
		// post-return job updates carry final statuses, not the last snapshot.
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				spawn.progress.status = result.aborted
					? "aborted"
					: result.exitCode === 0 && !result.error
						? "completed"
						: "failed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary =
			started.length > 0
				? `Spawned ${started.length} background agent${started.length === 1 ? "" : "s"}.${scheduleFailureSummary} Each result auto-delivers on yield unless a settled \`hub jobs\`/\`wait\` snapshot consumes it first.\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
				: scheduleFailureSummary.trim();
		const text = [merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return withAdvisory({
			content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
			details: buildAsyncDetails(),
		});
	}

	/**
	 * Register one background job that runs a single spawn to completion and
	 * delivers its terminal result. The job body mirrors the sync path; `buildDetails`
	 * supplies the (possibly batch-shared) progress snapshot and `onSettled`
	 * feeds the caller's aggregate counters.
	 */
	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		requestId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskRunDetails;
		onUpdate?: TaskSpawnUpdateCallback;
		onSettled?: (failed: boolean) => void;
		structuredOverrides?: StructuredSpawnOverrides;
	}): string {
		const {
			manager,
			requestId,
			spawnParams,
			agentId,
			progress,
			ircEnabled,
			buildDetails,
			onUpdate,
			onSettled,
			structuredOverrides,
		} = options;
		const buildFollowUpHint = async (aborted: boolean): Promise<string> => {
			const candidateRef = AgentRegistry.global().get(agentId);
			const transcriptAvailable = await hasResolvableTranscript(agentId);
			const ref = AgentRegistry.global().get(agentId) === candidateRef ? candidateRef : undefined;
			const resumable = ref?.status === "idle" || ref?.status === "parked";
			if (!resumable && !transcriptAvailable) return "";

			const transcript = transcriptAvailable ? `transcript at history://${agentId}` : "transcript unavailable";
			if (aborted) {
				if (resumable) {
					const followUp = ircEnabled ? "contact it through peer messaging to resume; " : "";
					return `\n\n${agentId} was stopped but is still resumable — ${followUp}${transcript}`;
				}
				return `\n\n${agentId} was aborted — ${transcript}`;
			}
			if (resumable) {
				const followUp = ircEnabled ? "contact it through peer messaging to follow up; " : "";
				return `\n\n${agentId} is now idle — ${followUp}${transcript}`;
			}
			return `\n\nTranscript available at history://${agentId}`;
		};
		return manager.register(
			"task",
			agentId,
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				let semaphoreHeld = false;
				// Every release funnels through here: the flag flips before the
				// release so no path — acquire-time abort, executor failure, or a
				// future refactor that reorders the branches — can return a permit
				// twice. Releasing a permit this job never acquired would steal one
				// from a running job and let a later spawn start past
				// task.maxConcurrency.
				const releasePermit = () => {
					if (!semaphoreHeld) return;
					semaphoreHeld = false;
					this.#releaseSpawnSemaphore();
				};
				try {
					await semaphore.acquire(runSignal);
					semaphoreHeld = true;
				} catch {
					// Fall through so an acquire-time abort goes through the same
					// path as the post-acquire race below: progress + onSettled
					// have to fire even when the spawn never reached the executor,
					// otherwise the batch aggregate state stays "running" forever.
				}
				const acquiredAt = Date.now();
				if (!semaphoreHeld || runSignal.aborted) {
					releasePermit();
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(`Running background task ${agentId}...`, buildDetails());
					const forwardSyncProgress: TaskSpawnUpdateCallback = async update => {
						const nextProgress = update.details?.progress?.[0];
						if (nextProgress) {
							// The job body owns status and identity (id/index/agent);
							// copy only the live metrics the subagent streams so the
							// polling row reflects the resolved model, reasoning level,
							// and running counters without reverting the "running"
							// status back to the subagent's initial "pending" snapshot.
							progress.modelRole = nextProgress.modelRole ?? progress.modelRole;
							progress.resolvedModel = nextProgress.resolvedModel;
							progress.resolvedModelIsFallback =
								nextProgress.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
							progress.tokens = nextProgress.tokens;
							progress.requests = nextProgress.requests;
							progress.contextTokens = nextProgress.contextTokens;
							progress.contextWindow = nextProgress.contextWindow;
							progress.cost = nextProgress.cost;
							progress.toolCount = nextProgress.toolCount;
							progress.currentTool = nextProgress.currentTool;
							progress.lastIntent = nextProgress.lastIntent;
							progress.recentTools = nextProgress.recentTools.slice();
							progress.recentOutput = nextProgress.recentOutput.slice();
							progress.retryState = nextProgress.retryState;
							progress.retryFailure = nextProgress.retryFailure;
						}
						const updateText =
							update.content.find(part => part.type === "text")?.text ?? `Running background task ${agentId}...`;
						await reportProgress(updateText, buildDetails());
					};
					const result = await this.#executeSync(
						requestId,
						spawnParams,
						runSignal,
						forwardSyncProgress,
						agentId,
						progress.index,
						true,
						{ invokedAt: startedAt, acquiredAt },
						structuredOverrides,
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					// A missing result means the sync path failed at the tool level
					// (results: []) — treat it as a failure, not success.
					const resultFailed = !singleResult || (singleResult.aborted ?? false) || singleResult.exitCode !== 0;
					progress.status = singleResult?.aborted ? "aborted" : resultFailed ? "failed" : "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					progress.modelRole = singleResult?.modelRole ?? progress.modelRole;
					if (singleResult?.resolvedModel) {
						progress.resolvedModel = singleResult.resolvedModel;
						progress.resolvedModelIsFallback =
							singleResult.resolvedModelIsFallback ?? progress.resolvedModelIsFallback;
					} else {
						delete progress.resolvedModel;
						delete progress.resolvedModelIsFallback;
					}
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText, buildDetails());
					const deliveryText = `${finalText}${await buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						// Mark the job itself failed; the failed agent stays interrogable.
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText, buildDetails());
					const message = error instanceof Error ? error.message : String(error);
					const hint = await buildFollowUpHint(false);
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					releasePermit();
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				onProgress: text => {
					onUpdate?.({
						content: [{ type: "text", text }],
						details: buildDetails(),
					});
				},
			},
		);
	}

	/**
	 * Sync fan-out (async unavailable, or every item's agent type is
	 * `blocking: true`): run every spawn to completion inline and merge the
	 * per-spawn payloads into a single tool result. The session-scoped
	 * semaphore still bounds concurrency across parallel task calls.
	 */
	async #executeSyncFanout(
		requestId: string,
		params: TaskParams,
		spawns: SyncSpawnRef[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: TaskSpawnUpdateCallback,
	): Promise<TaskSpawnResult> {
		if (spawns.length === 1) {
			const spawn = spawns[0]!;
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					requestId,
					spawnParamsFor(params, spawn.item, defaultAgent),
					signal,
					onUpdate,
					spawn.preAllocatedId,
					spawn.index,
					false,
					{ invokedAt, acquiredAt },
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawns.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			requestId,
			params,
			defaultAgent,
			signal,
			spawns,
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(spawns, payloads);
		return {
			content: [{ type: "text", text: merged.contentParts.join("\n\n") }],
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	/**
	 * Run a set of spawns to completion inline, bounded by the session spawn
	 * semaphore. `preAllocatedId` reuses an id claimed up front (mixed calls);
	 * `index` is each item's position in the original call so progress rows and
	 * merged results keep stable ordering. Per-item progress snapshots flow
	 * through `onItemProgress`. Returns per-spawn payloads in input order;
	 * `undefined` marks a spawn cancelled before it started.
	 */
	async #runSyncSpawns(args: {
		requestId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(TaskSpawnResult | undefined)[]> {
		const { requestId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimitAllSettled(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				let semaphoreHeld = false;
				try {
					await semaphore.acquire(workerSignal);
					semaphoreHeld = true;
				} catch (error) {
					if (workerSignal.aborted) return undefined;
					throw error;
				}
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: TaskSpawnUpdateCallback | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						requestId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
					);
				} finally {
					if (semaphoreHeld) this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results.map((settled, position) => {
			if (!settled) return undefined;
			if (settled.status === "fulfilled") return settled.value;
			const message = settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
			const item = spawns[position].item;
			return {
				content: [
					{
						type: "text",
						text: `Task ${item.name?.trim() || `#${spawns[position].index + 1}`} failed: ${message}`,
					},
				],
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		});
	}

	/**
	 * Synchronous execution of one spawn. Used as the body of every
	 * async job and directly by the sync fallback (no job manager / blocking
	 * agent) and by in-process callers that need the result inline (e.g. the
	 * commit flow's analyze_files tool).
	 */
	async #executeSync(
		requestId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: TaskSpawnUpdateCallback,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		structuredOverrides?: StructuredSpawnOverrides,
	): Promise<TaskSpawnResult> {
		return this.#runSpawn(
			requestId,
			params,
			signal,
			onUpdate,
			preAllocatedId,
			spawnIndex,
			detached,
			launchTiming,
			structuredOverrides,
		);
	}

	/** Spawn a fresh subagent and run it to completion. */
	async #runSpawn(
		requestId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: TaskSpawnUpdateCallback,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
		structuredOverrides?: StructuredSpawnOverrides,
	): Promise<TaskSpawnResult> {
		const startTime = Date.now();
		const assignment = (params.task ?? "").trim();
		const context = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		let latestProgress: AgentProgress | undefined;
		try {
			const execution = await runStructuredSubagent({
				session: this.session,
				assignment,
				context,
				agent: params.agent,
				model: structuredOverrides?.model,
				serviceTier: structuredOverrides?.serviceTier,
				...(Object.hasOwn(params, "outputSchema") ? { outputSchema: params.outputSchema } : {}),
				...(Object.hasOwn(params, "schemaMode") ? { schemaMode: params.schemaMode } : {}),
				...(params.effort !== undefined ? { effort: params.effort } : {}),
				identity: { id: preAllocatedId, label: params.name },
				index: spawnIndex,
				parentToolCallId: requestId,
				detached,
				keepAlive: structuredOverrides?.keepAlive ?? this.session.keepAliveSubagents,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				...(structuredOverrides?.isolation
					? { isolation: structuredOverrides.isolation }
					: "isolated" in params
						? { isolation: { requested: params.isolated } }
						: {}),
				blockedAgent: this.#blockedAgent,
				enableLsp: (this.session.enableLsp ?? true) && this.session.settings.get("task.enableLsp"),
				enableIrc: isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0),
				maxRuntimeMs: this.session.settings.get("task.maxRuntimeMs"),
				signal,
				onAdmission: structuredOverrides?.onAdmission,
				onProgress: progress => {
					latestProgress = {
						...progress,
						recentTools: progress.recentTools.slice(),
					};
					onUpdate?.({
						content: [{ type: "text", text: `Running agent ${progress.id}...` }],
						details: {
							projectAgentsDir: null,
							results: [],
							totalDurationMs: Date.now() - startTime,
							progress: [latestProgress],
						},
					});
				},
			});
			return this.#buildResultPayload(
				execution.result,
				execution.policy.discovery.projectAgentsDir,
				Date.now() - startTime,
				execution.mergeSummary,
			);
		} catch (error) {
			const message = error instanceof StructuredSubagentError ? error.message : String(error);
			return {
				content: [{ type: "text", text: `Task execution failed: ${message}` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					...(latestProgress ? { progress: [latestProgress] } : {}),
				},
			};
		}
	}

	/** Build the tool result (summary text + details) for a settled run. */
	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): TaskSpawnResult {
		const status = result.aborted
			? "cancelled"
			: result.exitCode === 0 && result.error
				? "merge failed"
				: result.exitCode === 0
					? "completed"
					: `failed (exit ${result.exitCode})`;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
		// the parent so it can resume via irc instead of redoing the work.
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}

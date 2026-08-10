import type { AgentOptions, AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import type { AsyncJobManager } from "../async/job-manager";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { CoordinationBackend } from "../coordination/backend";
import type { CronManager } from "../cron";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { DaemonCompletionNotification } from "../launch/protocol";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { AgentLifecycleManager } from "../registry/agent-lifecycle";
import type { AgentRegistry } from "../registry/agent-registry";
import type { AgentOutputManager } from "../task/output-manager";
import type { StructuredSubagentSchemaMode } from "../task/types";
import type { TodoPhase } from "../tools/todo";
import type { EventBus } from "../utils/event-bus";
import type { VibeModeState } from "../vibe/state";
import type { WorkspaceTree } from "../workspace-tree";
import type { ArtifactManager } from "./artifacts";
import type { ClientBridge } from "./client-bridge";
import type { CustomMessage } from "./messages";
import type { UsageStatistics } from "./session-entries";
import type { SessionManager } from "./session-manager";

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
};

/** Image attachment handle exposed to tools for user-facing labels such as `Image #1`. */
export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

/** Session context for tool factories */
export interface ToolSession {
	/** Current working directory */
	cwd: string;
	/** Additional workspace directories beyond cwd (multi-root), forwarded to subagents. */
	additionalDirectories?: string[];
	/** Whether UI is available */
	hasUI: boolean;
	/** Whether this session has begun disposal. */
	isDisposed?: () => boolean;
	/**
	 * Suppress the spawn specialization/coordination advisory appended to `task`
	 * results. Set by internal/programmatic callers (e.g. the commit agent's
	 * file-analysis fan-out) whose results are consumed by code — not by a model
	 * orchestrating further spawns — so the nudge would only be noise.
	 */
	suppressSpawnAdvisory?: boolean;
	/** Optional fetch implementation injected into the URL read pipeline (tests, proxies). Defaults to global fetch. */
	fetch?: FetchImpl;
	/** Provider credential resolver forwarded unchanged to restricted child sessions. */
	getApiKey?: AgentOptions["getApiKey"];
	/** Pre-loaded context files (AGENTS.md, etc) */
	contextFiles?: ContextFileEntry[];
	/** Pre-loaded workspace tree (forwarded to subagents to skip re-scanning) */
	workspaceTree?: WorkspaceTree;
	/** Pre-loaded skills */
	skills?: readonly Skill[];
	/** Rediscover live session skills after a tool mutates their backing files. */
	refreshSkills?: () => Promise<void>;
	/** Pre-loaded prompt templates */
	promptTemplates?: PromptTemplate[];
	/** Pre-loaded rules (forwarded to subagents to skip re-discovery). */
	rules?: Rule[];
	/**
	 * Pre-discovered extension source paths. Forwarded to subagents so they
	 * skip the FS scan but still re-bind extensions to their own session-scoped
	 * `ExtensionAPI` (cwd, eventBus, runtime). Inline extension factories
	 * (`<inline-N>`) are NOT included — those are session-local.
	 */
	extensionPaths?: string[];
	/** Whether LSP integrations are enabled */
	enableLsp?: boolean;
	/** Whether LSP is limited to navigation and diagnostics. */
	lspReadOnly?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;
	/**
	 * Whether MCP capabilities may be forwarded to child sessions. `false`
	 * prohibits inherited-manager and process-global MCP fallback.
	 */
	enableMCP?: boolean;
	/** Event bus for tool/extension communication */
	eventBus?: EventBus;
	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/**
	 * Constrain the active set to the caller's explicit built-in names (plus a
	 * required yield tool). Suppresses automatic tool-set expansion.
	 */
	restrictToolNames?: boolean;
	/** Task recursion depth (0 = top-level, 1 = first child, etc.) */
	taskDepth?: number;
	/** Override whether Task children remain addressable after their run settles. */
	keepAliveSubagents?: boolean;
	/** Get session file */
	getSessionFile: () => string | null;
	/** Parent session journal used by tools that persist runtime lifecycle state. */
	sessionManager?: Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush" | "getBranch" | "getEntries">;
	/** Get session ID */
	getSessionId?: () => string | null;
	/** Get Hindsight runtime state for this agent session. */
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	/** Get Mnemopi runtime state for this agent session. */
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	/** Agent identity used for IRC routing. Returns the registry id (e.g. "Main", "AuthLoader"). */
	getAgentId?: () => string | null;
	/** Agent registry for IRC routing across live sessions. */
	agentRegistry?: AgentRegistry;
	/** Idle→parked→revive lifecycle owner; lets the hub kill a non-job-backed agent registration. Default: AgentLifecycleManager.global(). */
	agentLifecycle?: () => AgentLifecycleManager;
	/** Get artifacts directory for artifact:// URLs */
	getArtifactsDir?: () => string | null;
	/** Get the ArtifactManager backing this session (shared across parent + subagents). */
	getArtifactManager?: () => ArtifactManager | null;
	/** Allocate a new artifact path and ID for session-scoped truncated output. */
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	/** Get session spawns */
	getSessionSpawns: () => string | null;
	/** Get resolved model string if explicitly set for this session */
	getModelString?: () => string | undefined;
	/** Get the current session model string, regardless of how it was chosen */
	getActiveModelString?: () => string | undefined;
	/** Get the current session model object (provider/api capabilities), regardless of how it was chosen. */
	getActiveModel?: () => Model | undefined;
	/** Get the session's live per-family service tiers (undefined = none). Source of truth for subagent `tier.subagent: inherit`. */
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	/** Auth storage for passing to subagents (avoids re-discovery) */
	authStorage?: import("../session/auth-storage").AuthStorage;
	/** Model registry for passing to subagents (avoids re-discovery) */
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	/** Agent output manager for unique agent:// IDs across task invocations */
	agentOutputManager?: AgentOutputManager;
	/**
	 * Async job manager scoped to this session.
	 *
	 * - Top-level session that constructed one: its own manager.
	 * - Subagent (`parentTaskPrefix` set): the parent's manager, so background
	 *   bash/task work and `onJobComplete` deliveries flow into the conversation
	 *   that spawned it.
	 * - Secondary in-process top-level session that found a singleton already
	 *   installed (issue #1923): `undefined`. Tools refuse async work rather
	 *   than silently route completions into the owning session's `yieldQueue`.
	 *
	 * Tools MUST use this instead of `AsyncJobManager.instance()` so a secondary
	 * session never borrows the owning session's manager by accident.
	 */
	asyncJobManager?: AsyncJobManager;
	/** Scheduler the cron tools create, list, and delete jobs through. */
	cronManager?: CronManager;
	/** MCP manager visible to subagents without relying on the process-global singleton. */
	mcpManager?: MCPManager;
	/** Local protocol root to propagate to nested subagents. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Settings instance for passing to subagents */
	settings: Settings;
	/** Vibe mode state (if active). */
	getVibeModeState?: () => VibeModeState | undefined;
	/** Goal mode state (if active or paused) */
	getGoalModeState?: () => GoalModeState | undefined;
	/** Goal runtime for the active agent session. */
	getGoalRuntime?: () => GoalRuntime | undefined;
	/** Get cumulative session usage statistics (input/output tokens, cost). */
	getUsageStatistics?: () => UsageStatistics;
	/** Bridge to the connected client (e.g. ACP editor host). Tools should route fs/terminal/permission requests through this when available. */
	getClientBridge?: () => ClientBridge | undefined;
	/** Get cached todo phases for this session. */
	getTodoPhases?: () => TodoPhase[];
	/** Replace cached todo phases for this session. */
	setTodoPhases?: (phases: TodoPhase[]) => void;
	/** Steer a hidden custom message. */
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	/** Queue a hidden message to be injected at the next agent turn. */
	queueDeferredMessage?(message: CustomMessage): void;
	/** Queue a broker supervised-process completion for the owning session. */
	queueLaunchCompletion?(notification: DaemonCompletionNotification): Promise<void>;
	/** Register cleanup that runs when this session is disposed; returns a handle that removes the cleanup. */
	registerDisposeCallback?(callback: () => void): (() => void) | void;
	/** Register cleanup that runs when this ToolSession adopts a different session ID. */
	registerSessionChangeCallback?(callback: () => void): (() => void) | void;
	/** Get the active OpenTelemetry config so subagent dispatch can forward
	 *  the parent's tracer/hooks with the subagent's own identity stamped. */
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	/** Return image attachments visible to tools for resolving labels such as `Image #1`. */
	getImageAttachments?: () => ImageAttachmentEntry[];
	/** Root-scoped Task and Hub coordination selected when this session starts. */
	coordinationBackend?: CoordinationBackend;
}

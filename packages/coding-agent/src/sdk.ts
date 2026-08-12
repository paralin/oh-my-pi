import {
	Agent,
	type AgentMessage,
	type AgentOptions,
	type AgentTelemetryConfig,
	type AgentTool,
	AppendOnlyContextManager,
	filterProviderReplayMessages,
	type ThinkingLevel,
} from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	CredentialDisabledEvent,
	Effort,
	Message,
	Model,
	ModelUsageHealth,
	ServiceTier,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import {
	getOpenAICodexTransportDetails,
	prewarmOpenAICodexResponses,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { $env, getAgentDir, getProjectDir, logger, postmortem, Snowflake } from "@oh-my-pi/pi-utils";
import {
	discoverAdvisorConfigs,
	discoverWatchdogFiles,
	formatActiveRepoWatchdogPrompt,
	formatAdvisorContextPrompt,
	loadAdvisorTranscriptCosts,
} from "./advisor";
import { createSessionAskOwner } from "./ask/session-owner";
import { AsyncJobManager } from "./async";
import { createAutoresearchExtension } from "./autoresearch";
import { loadCapability } from "./capability";
import { type Rule, ruleCapability, setActiveRules } from "./capability/rule";
import { bucketRules } from "./capability/rule-buckets";
import { shouldEnableAppendOnlyContext } from "./config/append-only-context-mode";
import { isAuthenticated, kNoAuth, ModelRegistry } from "./config/model-registry";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	getModelMatchPreferences,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveCliModel,
	resolveConfiguredModelPatterns,
	resolveModelRoleValue,
} from "./config/model-resolver";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "./config/prompt-templates";
import { applyProviderGlobalsFromSettings } from "./config/provider-globals";
import { buildServiceTierByFamily } from "./config/service-tier";
import { Settings, type SkillsSettings } from "./config/settings";
import type { CoordinationBackend, CoordinationLifecycle } from "./coordination/backend";
import { CronManager } from "./cron";
import { OmpAgentFamilyService } from "./ipython/agent-family";
import { IpythonAskService } from "./ipython/ask-service";
import { IpythonAutoQaService } from "./ipython/autoqa-service";
import { createIpythonBrowserService } from "./ipython/browser-service";
import { IpythonComputerService } from "./ipython/computer-service";
import { IpythonCronService } from "./ipython/cron-service";
import { createIpythonGithubService } from "./ipython/github-service";
import { createIpythonImageService } from "./ipython/image-service";
import {
	createIpythonProviderTool,
	preserveIpythonProviderTools,
	snapshotIpythonProviderTools,
} from "./ipython/provider-tool";
import { resolvePythonSkillPackages } from "./ipython/python-packages";
import { IpythonSecurityService } from "./ipython/security-service";
import { IpythonVibeService } from "./ipython/vibe-service";
import { createIpythonWebService } from "./ipython/web-service";
import { getSecurityCoordinator } from "./security/coordinator";
import type { SecurityPublisher } from "./security/publication";
import { SecurityStore } from "./security/store";
import { type RequestProfile, RequestProfileOwner } from "./session/request-profile";
import "./discovery";
import { initializeWithSettings } from "./discovery";
import { withOmpExtensionRootScope } from "./discovery/omp-extension-roots";
import {
	type CustomCommandsLoadResult,
	type LoadedCustomCommand,
	loadCustomCommands as loadCustomCommandsInternal,
} from "./extensibility/custom-commands";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type Extension,
	type ExtensionFactory,
	ExtensionRunner,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	loadExtensionFromFactory,
	loadExtensions,
	loadExtensionsIntoRuntime,
} from "./extensibility/extensions";
import {
	loadSkills as loadSkillsInternal,
	type Skill,
	type SkillWarning,
	setActiveSkills,
} from "./extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "./extensibility/slash-commands";
import type { HindsightSessionState } from "./hindsight/state";
import { LocalProtocolHandler, type LocalProtocolOptions } from "./internal-urls";
import { discoverStartupLspServers, type LspStartupServerInfo, warmupLspServers } from "./lsp";
import { setSharedLspEnabled } from "./lsp/client";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "./lsp/startup-events";
import { type MCPLoadResult, MCPManager } from "./mcp";
import { MCP_CONNECTION_STATUS_EVENT_CHANNEL, type McpConnectionStatusEvent } from "./mcp/startup-events";
import { createSessionMemoryRuntimeContext, resolveMemoryBackend } from "./memory-backend";
import type { MnemopiSessionState } from "./mnemopi/state";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "./registry/agent-registry";
import { AgentSession, type InitialRetryFallbackState } from "./session/agent-session";
import { discoverAuthStorage as discoverAuthStorageFromConfig } from "./session/auth-broker-config";
import type { AuthStorage } from "./session/auth-storage";
import { createInterruptedTurnAbortMessage } from "./session/exit-diagnostics";
import { convertToLlm, replaceLlmImagesWithText, USER_INTERRUPT_LABEL, wrapSteeringForModel } from "./session/messages";
import { clampProviderContextImages } from "./session/provider-image-budget";
import {
	expandDefaultRetryFallbackChains,
	findRetryFallbackCandidates,
	type RetryFallbackResolutionContext,
	resolveRetryFallbackChainKey,
} from "./session/retry-fallback-chains";
import { getRestorableSessionModels } from "./session/session-context";
import { SessionManager } from "./session/session-manager";
import { createSettingsAwareStreamFn } from "./session/settings-stream-fn";
import { SnapcompactInlineTransformer } from "./session/snapcompact-inline";
import { createSnapcompactSavingsRecorder } from "./session/snapcompact-savings-journal";
import type { ToolSession } from "./session/tool-session";
import { closeAllConnections } from "./ssh/connection-manager";
import { unmountAll } from "./ssh/sshfs-mount";
import {
	type BuildSystemPromptResult,
	buildSystemPrompt as buildSystemPromptInternal,
	loadProjectContextFiles as loadContextFilesInternal,
} from "./system-prompt";
import { TaskService } from "./task";
import { AgentOutputManager } from "./task/output-manager";
import { wrapStreamFnWithProviderConcurrency } from "./task/provider-concurrency";
import { isScoutSpawnable } from "./task/spawn-policy";
import type { StructuredSubagentSchemaMode } from "./task/types";
import { recordActTelemetry, recordIpythonCellTelemetry } from "./telemetry-export";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	parseConfiguredThinkingLevel,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "./thinking";
import { createComputerSessionSnapshot } from "./tools/computer/session-snapshot";
import { ComputerSupervisor } from "./tools/computer/supervisor";
import { ToolContextStore } from "./tools/context";
import { clampTimeout } from "./tools/operation-timeouts";
import { reportAutoQaIssue } from "./tools/report-tool-issue";
import { resolveActiveRepoContext } from "./utils/active-repo-context";
import { EventBus } from "./utils/event-bus";
import { VibeSessionRegistry } from "./vibe/runtime";
import { buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

type McpNotificationEntry = {
	serverName: string;
	uri: string;
};

function buildMcpNotificationBatchMessage(entries: McpNotificationEntry[]): AgentMessage | null {
	const resources: McpNotificationEntry[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const key = `${entry.serverName}\0${entry.uri}`;
		if (seen.has(key)) continue;
		seen.add(key);
		resources.push(entry);
	}
	if (resources.length === 0) return null;
	const lines = [`[MCP notification] ${resources.length} resource(s) updated:`];
	for (const resource of resources) {
		lines.push(`- server="${resource.serverName}" uri=${resource.uri}`);
	}
	lines.push('Use read(path="mcp://<uri>") to inspect if relevant.');
	return {
		role: "user",
		content: [{ type: "text", text: lines.join("\n") }],
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function logMCPLoadErrors(errors: MCPLoadResult["errors"]): void {
	for (const [serverName, error] of errors) {
		logger.error("MCP tool load failed", { path: `mcp:${serverName}`, error });
	}
}

function applyMCPEnvironment(result: { exaApiKeys: string[] }): void {
	if (result.exaApiKeys.length > 0 && !$env.EXA_API_KEY) {
		Bun.env.EXA_API_KEY = result.exaApiKeys[0];
	}
}

// Types
export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute or cwd-relative. */
	additionalDirectories?: string[];
	/** Global config directory. Default: ~/.omp/agent */
	agentDir?: string;
	/** Spawns to allow. Default: "*" */
	spawns?: string;

	/** Auth storage for credentials. Default: discoverAuthStorage(agentDir) */
	authStorage?: AuthStorage;
	/** Model registry. Default: discoverModels(authStorage, agentDir) */
	modelRegistry?: ModelRegistry;
	/**
	 * Request credential resolver. Defaults to the model registry's normal
	 * session-affine resolver. Security scans use this narrow seam to keep one
	 * durable OAuth row pinned for the operation without changing ordinary
	 * provider routing.
	 */
	getApiKey?: AgentOptions["getApiKey"];

	/** Model to use. Default: from settings, else first available */
	model?: Model;
	/** Raw model pattern(s) (e.g. from --model CLI flag) to resolve after extensions load.
	 * Used when model lookup is deferred because extension-provided models aren't registered yet. */
	modelPattern?: string | string[];
	/** Authenticated fallback selector for deferred subagent model patterns. */
	modelPatternAuthFallback?: string;
	/** Role name used to install retry fallbacks after deferred subagent patterns resolve. */
	modelPatternFallbackRole?: string;
	/** Validated default retry chain to install when a deferred singleton pattern resolves. */
	modelPatternDefaultFallbackChain?: string[];
	/** Thinking selector. Default: from settings, else unset */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); retry-fallback recovery re-clamps to it. */
	thinkingLevelCeiling?: Effort;
	/** OpenAI service-tier override for this session. `null` omits `service_tier`. */
	openAIServiceTier?: ServiceTier | null;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

	/** Provider-facing system prompt override. Replaces the fully rendered default blocks. */
	systemPrompt?: string | string[] | ((defaultPrompt: string[]) => string | string[]);
	/** Explicit prompt-and-tool profile for a specialized session such as compression. */
	requestProfile?: RequestProfile;
	/** Already-loaded custom prompt text rendered through the bundled custom system prompt template. */
	customSystemPrompt?: string;
	/** Already-loaded text appended through the bundled system prompt templates. */
	appendSystemPrompt?: string;
	/**
	 * Already-loaded title-generation system prompt override (typically
	 * {@link discoverTitleSystemPromptFile} → {@link resolvePromptInput}). When
	 * set, every automatic session-title generation path on this session — the
	 * first-input title and the replan-driven refresh — uses this prompt
	 * instead of the bundled default. Refresh on cwd change via
	 * {@link AgentSession.setTitleSystemPrompt}.
	 */
	titleSystemPrompt?: string;
	/** Optional provider-facing session identifier for prompt caches and sticky auth selection.
	 * Keeps persisted session files isolated while reusing provider-side caches. */
	providerSessionId?: string;
	/** Optional provider-facing prompt cache key, distinct from request lineage. */
	providerPromptCacheKey?: string;
	/** Whether `providerPromptCacheKey` is caller-pinned or inherited from a full fork. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Absolute wall-clock deadline in Unix epoch milliseconds. */
	deadline?: number;

	/** Inline extensions (merged with discovery). */
	extensions?: ExtensionFactory[];
	/** Additional extension paths to load (merged with discovery). */
	additionalExtensionPaths?: string[];
	/** Disable extension discovery (explicit paths still load). */
	disableExtensionDiscovery?: boolean;
	/**
	 * Pre-loaded extensions (skips file discovery and the per-session factory
	 * call). Used by the CLI when extensions are loaded early to parse custom
	 * flags — the same process owns the returned instances, so reusing them is
	 * safe.
	 *
	 * NEVER pass this across session boundaries (e.g. parent → subagent).
	 * `Extension` instances close over a parent-bound `ExtensionAPI` (cwd,
	 * eventBus, runtime), and reusing them would route tools/handlers/commands
	 * back through the parent. For subagents, forward
	 * {@link preloadedExtensionPaths} instead.
	 *
	 * @internal
	 */
	preloadedExtensions?: LoadExtensionsResult;
	/**
	 * Pre-discovered extension source paths. When provided, the filesystem-scan
	 * inside `discoverExtensionPaths()` is skipped — the session still calls
	 * `loadExtensions()` itself so each `Extension` is bound to THIS session's
	 * `ExtensionAPI` (cwd, eventBus, runtime).
	 *
	 * This is the safe pass-through for parent → subagent forwarding.
	 */
	preloadedExtensionPaths?: string[];

	/** Shared event bus for tool/extension communication. Default: creates new bus. */
	eventBus?: EventBus;

	/** Skills. Default: discovered from multiple locations */
	skills?: Skill[];
	/** Rules. Default: discovered from multiple locations */
	rules?: Rule[];
	/** Context files (AGENTS.md content). Default: discovered walking up from cwd */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-built workspace tree (skips re-scanning; passed by parents to subagents). */
	workspaceTree?: WorkspaceTree;
	/** Prompt templates. Default: discovered from cwd/.omp/prompts/ + agentDir/prompts/ */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands. Default: discovered from commands/ directories */
	slashCommands?: FileSlashCommand[];

	/**
	 * Enable MCP capabilities. `false` skips MCP discovery and ignores
	 * `mcpManager`, preventing process-global or inherited MCP access. Default:
	 * true.
	 */
	enableMCP?: boolean;
	/** Existing MCP manager to reuse when MCP is enabled (skips discovery, propagates to toolSession). */
	mcpManager?: MCPManager;

	/** Enable LSP integration (tool, formatting, diagnostics, warmup). Default: true */
	enableLsp?: boolean;
	/** Restrict LSP to navigation and diagnostics even when enabled. Defaults to true for restricted sessions. */
	lspReadOnly?: boolean;
	/** Whether this invocation may expose IRC. `false` removes it even for subagents. */
	enableIrc?: boolean;

	/** Output schema for structured completion (subagents). */
	outputSchema?: unknown;
	/** Enforcement policy for {@link outputSchema}; defaults to legacy permissive behavior. */
	outputSchemaMode?: StructuredSubagentSchemaMode;
	/** Task recursion depth (for subagent sessions). Default: 0 */
	taskDepth?: number;
	/** Parent Hindsight state to alias for subagent memory host operations. */
	parentHindsightSessionState?: HindsightSessionState;
	/** Parent Mnemopi state to alias for subagent memory host operations. */
	parentMnemopiSessionState?: MnemopiSessionState;
	/** Pre-allocated agent identity for IRC routing. Default: "Main" for top-level, parentTaskPrefix-derived for sub. */
	agentId?: string;
	/** Display name for the agent in IRC. Default: "main" or "sub". */
	agentDisplayName?: string;
	/** Optional shared agent registry for IRC routing. Default: AgentRegistry.global(). */
	agentRegistry?: AgentRegistry;
	/**
	 * Registry generation authorized for this creation. `null` requires the id
	 * to be absent; an AgentRef allows a parked revival to reuse only that ref.
	 * Undefined preserves legacy unconditional registration for external SDK callers.
	 * @internal
	 */
	expectedAgentRef?: AgentRef | null;
	/** Parent task ID prefix for nested artifact naming (e.g., "Extensions") */
	parentTaskPrefix?: string;
	/**
	 * Registry id of the spawning agent, recorded as this subagent's parent in
	 * the agent registry. Distinct from `parentTaskPrefix`, which is this agent's
	 * own artifact/output-id prefix (the executor passes the child's own id
	 * there, so it must never double as the parent link). Undefined for the
	 * top-level "Main" session, which has no parent.
	 */
	parentAgentId?: string;

	/** Session manager. Default: session stored under the configured agentDir sessions root */
	sessionManager?: SessionManager;

	/** Override local:// protocol options for subagent local:// sharing. Default: uses the session's own artifacts dir and session ID. */
	localProtocolOptions?: LocalProtocolOptions;

	/** Root-scoped Task and Hub coordination inherited by child sessions. */
	coordinationBackend?: CoordinationBackend;
	/** Awaited custody boundary for top-level session and model transitions. */
	coordinationLifecycle?: CoordinationLifecycle;
	/** Settings instance. Default: Settings.init({ cwd, agentDir }) */
	settings?: Settings;
	/**
	 * Legacy alias for `settings`. Older Pi extensions pass SettingsManager.create(...)
	 * through this field; accept it so their SDK calls keep the configured settings.
	 */
	settingsManager?: Settings | Promise<Settings>;

	/** Whether UI is available (enables interactive tools like ask). Default: false */
	hasUI?: boolean;
	/**
	 * Defer `confirm` reserve-policy fallback until AgentSession prompt-time UI is configured.
	 * ACP uses this while capabilities are negotiated without enabling UI-only tools.
	 */
	deferUsageReserveConfirmation?: boolean;

	/**
	 * Opt-in OpenTelemetry instrumentation forwarded to the underlying Agent.
	 * Passing `{}` enables the loop's GenAI-semantic-convention spans. See
	 * {@link AgentTelemetryConfig} for the full surface (hooks, content capture,
	 * cost estimator, agent identity).
	 *
	 * Safe to enable without an OTEL SDK registered in the host: the
	 * `@opentelemetry/api` package returns a no-op tracer in that case.
	 */
	telemetry?: AgentTelemetryConfig;

	/**
	 * Fired once, when the agent loop hands its first request to the provider
	 * transport (i.e. the `streamFn` wrapper is first invoked). Used to measure
	 * subagent launch latency — the boundary between "session built" and "model
	 * call dispatched". This is the loop's dispatch point, slightly before the
	 * actual provider HTTP call (per-request prep, identical across all
	 * requests, follows it), which is the right granularity for launch timing.
	 */
	onFirstChatDispatch?: () => void;

	/** Whether to auto-approve all tool calls (--auto-approve CLI flag). Default: false */
	autoApprove?: boolean;
	/** Bound native security result publisher, available only to this session's IPython host handlers. */
	securityPublisher?: SecurityPublisher;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (loaded extensions + runtime) */
	extensionsResult: LoadExtensionsResult;
	/** Update tool UI context (interactive mode) */
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** MCP manager for server lifecycle management (undefined if MCP disabled) */
	mcpManager?: MCPManager;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
	/** LSP servers detected for startup; warmup may continue in the background */
	lspServers?: LspStartupServerInfo[];
	/** Shared event bus for tool/extension communication */
	eventBus: EventBus;
}

// Re-exports

export type { PromptTemplate } from "./config/prompt-templates";
export { Settings, type SkillsSettings } from "./config/settings";
export type {
	CustomCommand,
	CustomCommandFactory,
} from "./extensibility/custom-commands/types";
export type * from "./extensibility/extensions";
export type { Skill } from "./extensibility/skills";
export type { FileSlashCommand } from "./extensibility/slash-commands";
export type {
	MCPManager,
	MCPServerConfig,
	MCPServerConnection,
} from "./mcp";
// Agent registry: pass a private instance per `createAgentSession` when
// embedding several concurrent top-level sessions in one process (the default
// global registry admits only one "Main" per process generation).
export {
	type AgentRef,
	AgentRegistry,
	MAIN_AGENT_ID,
} from "./registry/agent-registry";
export {
	buildDirectoryTree,
	buildWorkspaceTree,
	type DirectoryTree,
	type WorkspaceTree,
} from "./workspace-tree";

export type { ToolSession };

// Helper Functions

// Discovery Functions

/**
 * Create an AuthStorage instance.
 *
 * Default: local SQLite store at `<agentDir>/agent.db`.
 *
 * Broker mode: when `OMP_AUTH_BROKER_URL` is set, credentials are pulled from
 * a remote auth-broker over the wire. Refresh tokens never leave the broker;
 * the client receives access tokens with `refresh = "__remote__"` and calls
 * back into the broker through the {@link AuthStorageOptions.refreshOAuthCredential}
 * override to re-mint access tokens when needed.
 *
 * Delegates to {@link ./session/auth-broker-config} so the TUI and the catalog
 * generator share the same credential-discovery logic.
 */
export async function discoverAuthStorage(agentDir: string = getAgentDir()): Promise<AuthStorage> {
	return discoverAuthStorageFromConfig(agentDir);
}

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
): Promise<string[]> {
	const configuredPaths = options.disableExtensionDiscovery
		? (options.additionalExtensionPaths ?? [])
		: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = options.disableExtensionDiscovery
		? undefined
		: (settings.get("disabledExtensions") ?? []);
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, {
		ambient: !options.disableExtensionDiscovery,
	});
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings);
	const result = await logger.time("loadExtensions", loadExtensions, paths, cwd, eventBus);
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
	}
	return result;
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`omp bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.omp/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `omp models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

/**
 * Discover skills from cwd and agentDir.
 */
export async function discoverSkills(
	cwd?: string,
	_agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
	});
}

/**
 * Discover context files (AGENTS.md) walking up from cwd.
 * Returns files sorted by depth (farther from cwd first, so closer files appear last/more prominent).
 */
export async function discoverContextFiles(
	cwd?: string,
	_agentDir?: string,
	disabledExtensions?: string[],
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		disabledExtensions,
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 */
export async function discoverSlashCommands(cwd?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

// API Key Helpers

// System Prompt

export interface BuildSystemPromptOptions {
	contextFiles?: Array<{ path: string; content: string }>;
	cwd?: string;
	customPrompt?: string;
	appendPrompt?: string;
}

/** Build the fixed IPython provider prompt and caller-supplied context. */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	return await buildSystemPromptInternal({
		appendSystemPrompt: options.appendPrompt,
		contextFiles: options.contextFiles,
		customPrompt: options.customPrompt,
		cwd: options.cwd,
	});
}

// Internal Helpers

let sshCleanupRegistered = false;

async function cleanupSshResources(): Promise<void> {
	const results = await Promise.allSettled([closeAllConnections(), unmountAll()]);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("SSH cleanup failed", { error: String(result.reason) });
		}
	}
}

function registerSshCleanup(): void {
	if (sshCleanupRegistered) return;
	sshCleanupRegistered = true;
	postmortem.register("ssh-cleanup", cleanupSshResources);
}

// Factory

/**
 * Build LoadedCustomCommand entries for all MCP prompts across connected servers.
 * These are re-created whenever prompts change (setOnPromptsChanged callback).
 */
function buildMCPPromptCommands(manager: MCPManager): LoadedCustomCommand[] {
	const commands: LoadedCustomCommand[] = [];
	for (const serverName of manager.getConnectedServers()) {
		const prompts = manager.getServerPrompts(serverName);
		if (!prompts?.length) continue;
		for (const prompt of prompts) {
			const commandName = `${serverName}:${prompt.name}`;
			commands.push({
				path: `mcp:${commandName}`,
				resolvedPath: `mcp:${commandName}`,
				source: "bundled",
				command: {
					name: commandName,
					description: prompt.description ?? `MCP prompt from ${serverName}`,
					async execute(args: string[]) {
						const promptArgs: Record<string, string> = {};
						for (const arg of args) {
							const eqIdx = arg.indexOf("=");
							if (eqIdx > 0) {
								promptArgs[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
							}
						}
						const result = await manager.executePrompt(serverName, prompt.name, promptArgs);
						if (!result) return "";
						const parts: string[] = [];
						for (const msg of result.messages) {
							const contentItems = Array.isArray(msg.content) ? msg.content : [msg.content];
							for (const item of contentItems) {
								if (item.type === "text") {
									parts.push(item.text);
								} else if (item.type === "resource") {
									const resource = item.resource;
									if (resource.text) parts.push(resource.text);
								}
							}
						}
						return parts.join("\n\n");
					},
				},
			});
		}
	}
	return commands;
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@oh-my-pi/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // Full control
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   getApiKey: async () => Bun.env.MY_KEY,
 *   systemPrompt: ['You are helpful.'],
 *   skills: [],
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	const rootMode = options.disableExtensionDiscovery ? "explicit-only" : "merge";
	return await withOmpExtensionRootScope(options.additionalExtensionPaths ?? [], rootMode, () =>
		createAgentSessionScoped(options),
	);
}

async function createAgentSessionScoped(options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> {
	const cwd = options.cwd ?? getProjectDir();
	const agentDir = options.agentDir ?? getAgentDir();
	const eventBus = options.eventBus ?? new EventBus();

	registerSshCleanup();

	// Pin authStorage to modelRegistry.authStorage: ModelRegistry.getApiKey() routes refresh
	// failures through that instance, so any divergent storage handed to the bridge / mcpManager
	// / session would silently miss credential_disabled events.
	const modelRegistry =
		options.modelRegistry ??
		new ModelRegistry(options.authStorage ?? (await logger.time("discoverModels", discoverAuthStorage, agentDir)));
	// Track whether we internally created the authStorage so we can close it
	// if construction fails before the session takes ownership.
	const ownsAuthStorage = !options.authStorage && !options.modelRegistry;
	const authStorage = modelRegistry.authStorage;
	if (options.authStorage && options.authStorage !== authStorage) {
		throw new Error(
			"options.authStorage and options.modelRegistry.authStorage must be the same instance when both are provided",
		);
	}
	// Subscribe before any getApiKey() call so startup model probes can't fire a
	// credential_disabled event past us. An embedder's constructor handler makes the
	// listener set non-empty from construction, which defeats AuthStorage's no-listener
	// buffer — so we can't rely on it to catch startup events for the extension runner.
	const startupCredentialDisabledEvents: CredentialDisabledEvent[] = [];
	let credentialDisabledTarget: ExtensionRunner | undefined;
	const unsubscribeCredentialDisabled: (() => void) | undefined = authStorage.onCredentialDisabled(event => {
		if (credentialDisabledTarget) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void credentialDisabledTarget.emitCredentialDisabled(event);
		} else {
			startupCredentialDisabledEvents.push(event);
		}
	});
	const settings = await (options.settings ??
		options.settingsManager ??
		logger.time("settings", Settings.init, { cwd, agentDir }));
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	if (!options.modelRegistry) {
		modelRegistry.refreshInBackground();
	}
	// Kick off workspace tree discovery early. The native workspace scan returns
	// both the rendered-tree input and the AGENTS.md directory-context index, so
	// startup does not perform a second recursive filesystem search. Subagents
	// inherit the parent's resolved values via options.
	const STARTUP_SCAN_DEADLINE_MS = 5000;
	const includeWorkspaceTree = settings.get("includeWorkspaceTree") ?? false;
	const workspaceTreePromise: Promise<WorkspaceTree> = options.workspaceTree
		? Promise.resolve(options.workspaceTree)
		: includeWorkspaceTree
			? logger.time("buildWorkspaceTree", () => buildWorkspaceTree(cwd, { timeoutMs: STARTUP_SCAN_DEADLINE_MS }))
			: Promise.resolve({
					rootPath: cwd,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				});
	workspaceTreePromise.catch(() => {});

	// Independent discoveries that depend only on cwd/agentDir — kicked off in parallel and awaited
	// at their respective consumer sites. Their work can overlap with model and credential resolution,
	// session-context build, tool creation, MCP discovery, and extension discovery.
	const contextFilesPromise = options.contextFiles
		? Promise.resolve(options.contextFiles)
		: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir);
	contextFilesPromise.catch(() => {});
	const resolveRepoContext = async (repoCwd: string) => {
		try {
			return await resolveActiveRepoContext(repoCwd);
		} catch (err) {
			logger.debug("Failed to resolve active repo context", {
				err: String(err),
			});
			return null;
		}
	};
	const activeRepoContextPromise = logger.time("resolveActiveRepoContext", resolveRepoContext, cwd);
	activeRepoContextPromise.catch(() => {});
	const watchdogFilesPromise = logger.time("discoverWatchdogFiles", () => discoverWatchdogFiles(cwd, agentDir));
	watchdogFilesPromise.catch(() => {});
	const advisorConfigsPromise = logger.time("discoverAdvisorConfigs", () => discoverAdvisorConfigs(cwd, agentDir));
	advisorConfigsPromise.catch(() => {});
	const promptTemplatesPromise = options.promptTemplates
		? Promise.resolve(options.promptTemplates)
		: logger.time("discoverPromptTemplates", discoverPromptTemplates, cwd, agentDir);
	promptTemplatesPromise.catch(() => {});
	const slashCommandsPromise = options.slashCommands
		? Promise.resolve(options.slashCommands)
		: logger.time("discoverSlashCommands", discoverSlashCommands, cwd);
	slashCommandsPromise.catch(() => {});
	const skillsSettings = settings.getGroup("skills");
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	const discoveredSkillsPromise =
		options.skills === undefined
			? logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...skillsSettings,
					disabledExtensions: disabledExtensionIds,
				})
			: undefined;
	discoveredSkillsPromise?.catch(() => {});

	// Initialize provider preferences from settings
	applyProviderGlobalsFromSettings(settings);

	const sessionManager =
		options.sessionManager ??
		logger.time("sessionManager", () =>
			SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir)),
		);
	const configuredDirs = options.additionalDirectories
		? options.additionalDirectories
		: settings.get("workspace.additionalDirectories");
	if (configuredDirs.length > 0) {
		// Merge with any roots restored from the session header (resume/fork), not replace.
		const existing = sessionManager.getAdditionalDirectories();
		const merged = [...new Set([...existing, ...configuredDirs])];
		await sessionManager.setAdditionalDirectories(merged);
	}
	const providerSessionId = options.providerSessionId ?? sessionManager.getSessionId();
	const forkCacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined;
	const inheritedPromptCacheKey = forkCacheShapeChanged
		? undefined
		: sessionManager.getHeader()?.providerPromptCacheKey;
	const providerPromptCacheKey = options.providerPromptCacheKey ?? inheritedPromptCacheKey;
	const providerPromptCacheKeySource =
		options.providerPromptCacheKey !== undefined
			? (options.providerPromptCacheKeySource ?? "explicit")
			: providerPromptCacheKey !== undefined
				? "fork"
				: undefined;
	// Startup model *selection* only needs to know whether auth is configured for
	// a candidate's provider — never the resolved key bytes. Use the synchronous,
	// side-effect-free probe (`hasConfiguredAuth`): it refreshes no OAuth tokens,
	// executes no `!command` keys, and issues no auth-broker requests. Resolving the
	// real key here (`getApiKey`) blocks resume on those network paths — a slow or
	// unreachable OAuth/broker endpoint stalls startup for the full ~10s refresh
	// timeout per candidate (observed as a hang in `restoreSessionModel`). The real
	// key is resolved lazily per request via ModelRegistry.resolver.
	const hasModelAuth = (candidate: Model): boolean => modelRegistry.hasConfiguredAuth(candidate);

	// An abnormal process exit after a non-terminal message tail is durable
	// evidence that the old process can no longer finish that turn. Preserve the
	// partial transcript and append one terminal aborted assistant record before
	// rebuilding runtime context. The helper is idempotent once that record exists.
	let existingBranch = logger.time("getSessionBranch", () => sessionManager.getBranch());
	const interruptedTurnAbort = createInterruptedTurnAbortMessage(existingBranch);
	if (interruptedTurnAbort) {
		sessionManager.appendMessage(interruptedTurnAbort);
		existingBranch = logger.time("getRecoveredSessionBranch", () => sessionManager.getBranch());
	}
	let existingSession = logger.time("loadSessionContext", () => sessionManager.buildSessionContext());
	const hasExistingSession = existingBranch.length > 0;
	const hasThinkingEntry = existingBranch.some(entry => entry.type === "thinking_level_change");
	const hasServiceTierEntry = existingBranch.some(entry => entry.type === "service_tier_change");

	const deferredModelPatterns = Array.isArray(options.modelPattern)
		? options.modelPattern.map(pattern => pattern.trim()).filter(Boolean)
		: options.modelPattern?.trim()
			? [options.modelPattern.trim()]
			: [];
	const hasExplicitModel = options.model !== undefined || deferredModelPatterns.length > 0;
	const modelMatchPreferences = getModelMatchPreferences(settings);
	const allowedModels = await logger.time("resolveAllowedModels", () =>
		resolveAllowedModels(modelRegistry, settings, modelMatchPreferences),
	);
	let defaultRoleSpec = logger.time("resolveDefaultModelRole", () =>
		resolveModelRoleValue(settings.getModelRole("default"), allowedModels, {
			settings,
			matchPreferences: modelMatchPreferences,
		}),
	);
	let model = options.model;
	let modelFallbackMessage: string | undefined;
	let initialRetryFallback: InitialRetryFallbackState | undefined;
	// Identify session model strings to restore in fallback order. We do an
	// initial pass here so model-dependent setup (thinking-level resolution,
	// host preconnect) can use the restored model; extension-registered
	// providers aren't visible yet, so we retry the preferred candidates once
	// extensions register below.
	const sessionModelStrings =
		!hasExplicitModel && hasExistingSession
			? getRestorableSessionModels(existingSession.models, sessionManager.getLastModelChangeRole())
			: [];
	let restoredSessionModelIndex = -1;
	let restoredSessionThinkingLevel: ConfiguredThinkingLevel | undefined;
	if (!hasExplicitModel && !model && sessionModelStrings.length > 0) {
		logger.time("restoreSessionModel", () => {
			let failedSessionModel: string | undefined;
			for (let i = 0; i < sessionModelStrings.length; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					allowAutoAlias: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) {
					failedSessionModel ??= sessionModelStr;
					continue;
				}

				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					break;
				}
				failedSessionModel ??= sessionModelStr;
			}
			if (failedSessionModel) {
				modelFallbackMessage = `Could not restore model ${failedSessionModel}`;
			}
		});
	}

	// If still no model, try settings default.
	// Skip settings fallback when an explicit model was requested.
	if (!hasExplicitModel && !model && defaultRoleSpec.model) {
		const settingsDefaultModel = defaultRoleSpec.model;
		logger.time("resolveSettingsDefaultModel", () => {
			// defaultRoleSpec.model already comes from modelRegistry.getAvailable(),
			// so re-validating auth here just repeats the expensive lookup path.
			model = settingsDefaultModel;
		});
	}

	const taskDepth = options.taskDepth ?? 0;

	// Resolves the session/agent thinking level using the same precedence we
	// apply at startup: explicit option → persisted session entry → restored
	// model selector suffix → default role's explicit selector → selected
	// model's defaultLevel → global settings default. Run again after extension
	// role reclaim so the final model's own defaults aren't masked by an earlier
	// fallback model's.
	const pickInitialThinkingLevel = (selectedModel: Model | undefined): ConfiguredThinkingLevel | undefined => {
		let level = options.thinkingLevel;
		if (level === undefined && hasExistingSession && hasThinkingEntry) {
			level =
				parseConfiguredThinkingLevel(existingSession.configuredThinkingLevel) ??
				parseThinkingLevel(existingSession.thinkingLevel);
		}
		if (level === undefined && !hasThinkingEntry && restoredSessionThinkingLevel !== undefined) {
			level = restoredSessionThinkingLevel;
		}
		if (level === undefined && !hasExplicitModel && !hasThinkingEntry && defaultRoleSpec.explicitThinkingLevel) {
			level = defaultRoleSpec.thinkingLevel;
		}
		if (level === undefined && selectedModel?.thinking?.defaultLevel !== undefined) {
			level = selectedModel.thinking.defaultLevel;
		}
		if (level === undefined) {
			level = parseConfiguredThinkingLevel(settings.get("defaultThinkingLevel"));
		}
		return level;
	};
	let thinkingLevel = pickInitialThinkingLevel(model);
	let autoThinking = thinkingLevel === AUTO_THINKING;
	// Concrete level the agent/session start with. With `auto` this is the
	// provisional level shown until the first per-turn classification resolves;
	// `auto` itself stays a session-only concept handled by AgentSession.
	let effectiveThinkingLevel: ThinkingLevel | undefined = concreteThinkingLevel(thinkingLevel);
	if (model) {
		const resolvedModel = model;
		effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
			autoThinking
				? resolveProvisionalAutoLevel(resolvedModel)
				: resolveThinkingLevelForModel(resolvedModel, effectiveThinkingLevel),
		);
		// Fire-and-forget TLS+H2 handshake to the model's host so it overlaps
		// with the rest of session setup (extension and skill loading, MCP discovery,
		// system prompt build). Without this, the first `fetch(...)` pays the
		// full handshake serially — 100–300 ms transcontinental for
		// api.anthropic.com from a residential IP. Every mode benefits
		// (interactive, print, rpc, acp).
		preconnectModelHost(model.baseUrl);
	}

	let skills: Skill[];
	let skillWarnings: SkillWarning[];
	if (options.skills !== undefined) {
		skills = options.skills;
		skillWarnings = [];
	} else {
		const discovered = await (discoveredSkillsPromise ?? Promise.resolve({ skills: [], warnings: [] }));
		skills = discovered.skills;
		skillWarnings = discovered.warnings;
	}
	const resolvedPythonPackages = await resolvePythonSkillPackages(skills);
	skillWarnings = [
		...skillWarnings,
		...resolvedPythonPackages.warnings.map(item => ({ skillPath: item.skillPath, message: item.message })),
	];

	// Discover rules and bucket them in one pass to avoid repeated scans over large rule sets.
	const { ttsrManager, rulebookRules, alwaysApplyRules, allRules } = await logger.time(
		"discoverTtsrRules",
		async () => {
			const { TtsrManager } = await import("./export/ttsr");
			const ttsrSettings = settings.getGroup("ttsr");
			const ttsrManager = new TtsrManager(ttsrSettings);
			const rulesResult =
				options.rules !== undefined
					? { items: options.rules, warnings: undefined }
					: await loadCapability<Rule>(ruleCapability.id, { cwd });
			const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
				builtinRules: ttsrSettings.builtinRules,
				disabledRules: ttsrSettings.disabledRules,
			});
			if (existingSession.injectedTtsrRules.length > 0) {
				ttsrManager.restoreInjected(existingSession.injectedTtsrRules);
			}
			return {
				ttsrManager,
				rulebookRules,
				alwaysApplyRules,
				allRules: rulesResult.items,
			};
		},
	);

	// Resolve contextFiles up-front (it's needed before tool creation). The
	// workspace tree scan is slow on large repos and we MUST NOT block startup on
	// it. On timeout we forward `undefined` to ToolSession; buildSystemPromptInternal
	// will re-race the same promise through its own withDeadline path. Background
	// work continues so caches still warm.
	const raceWithDeadline = async <T>(name: string, work: Promise<T>): Promise<T | undefined> => {
		let timedOut = false;
		const result = await Promise.race([
			work,
			Bun.sleep(STARTUP_SCAN_DEADLINE_MS).then(() => {
				timedOut = true;
				return undefined;
			}),
		]);
		if (timedOut) {
			logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
				name,
				timeoutMs: STARTUP_SCAN_DEADLINE_MS,
				cwd,
			});
		}
		return result;
	};
	const [initialContextFiles, resolvedWorkspaceTree, watchdogFiles, initialActiveRepoContext, discoveredAdvisors] =
		await Promise.all([
			contextFilesPromise,
			raceWithDeadline("buildWorkspaceTree", workspaceTreePromise),
			watchdogFilesPromise,
			activeRepoContextPromise,
			advisorConfigsPromise,
		]);
	let contextFiles = initialContextFiles;

	let agent: Agent;
	let session!: AgentSession;
	let hasSession = false;
	let hasRegistered = false;
	const enableLsp = options.enableLsp ?? true;
	const lspReadOnly = options.lspReadOnly ?? false;
	const asyncMaxJobs = Math.min(100, Math.max(1, settings.get("async.maxJobs") ?? 100));
	// Only the first top-level session in a process owns an AsyncJobManager.
	// Subagents inherit the parent's manager via `AsyncJobManager.instance()`
	// (set below), and any additional top-level session spun up in-process
	// (e.g. the agent-creation architect in `agent-dashboard.ts`) must share
	// the live singleton — otherwise its dispose path would clobber the
	// owning session's manager and break the `task`/`bash` async paths
	// (issue #1923). The `instance()` guard means later sessions also skip
	// constructing an orphaned manager that nothing would ever route to.
	// Delivery is owner-routed: every AgentSession registers its own sink
	// (see session/async-job-delivery.ts), so the manager takes no default
	// onJobComplete here.
	const asyncJobManager =
		!options.parentTaskPrefix && !AsyncJobManager.instance()
			? new AsyncJobManager({ maxRunningJobs: asyncMaxJobs })
			: undefined;

	const scopedAsyncJobManager = asyncJobManager ?? (options.parentTaskPrefix ? AsyncJobManager.instance() : undefined);

	// The scheduler hands a fired job to the session that can run it. Durable
	// jobs are keyed on the transcript path, so a `/new` session switch moves the
	// scheduler to that session's jobs rather than replaying the previous set.
	const cronManager = new CronManager({
		getSessionFile: () => sessionManager.getSessionFile(),
		getSessionId: () => sessionManager.getSessionId(),
		storage: sessionManager.getStorage(),
		enqueuePrompt: async promptText => session?.deliverScheduledPrompt(promptText),
	});

	const agentRegistry = options.agentRegistry ?? AgentRegistry.global();
	const resolvedAgentId = options.agentId ?? options.parentTaskPrefix ?? MAIN_AGENT_ID;
	const resolvedAgentDisplayName =
		options.agentDisplayName ?? ((options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? "sub" : "main");
	const agentKind = (options.taskDepth ?? 0) > 0 || options.parentTaskPrefix ? ("sub" as const) : ("main" as const);
	let registeredAgentRef: AgentRef | undefined;
	/**
	 * Forget the agent ref on teardown — unless it is a retained terminal ref.
	 * Parking disposes the session but keeps the ref addressable (history://,
	 * revive); a hard kill leaves it as a terminal `aborted` tombstone. Both are
	 * detached (session === null) by the time dispose runs, per the AgentRef
	 * invariant, so preserving them never keeps a disposed session reachable — an
	 * aborted ref that still holds a live session is a bug and is unregistered
	 * rather than handed to ensureLive. Only process teardown / a plain release
	 * unregisters.
	 */
	const unregisterUnlessParked = (): void => {
		const ref = registeredAgentRef;
		if (!ref || agentRegistry.get(resolvedAgentId) !== ref) return;
		if (ref.status === "parked" || (ref.status === "aborted" && !ref.session)) return;
		if (AgentLifecycleManager.global().isParking(resolvedAgentId, ref)) return;
		agentRegistry.unregister(resolvedAgentId, ref);
	};

	try {
		const getActiveModelString = (): string | undefined => {
			const activeModel = agent?.state.model;
			if (activeModel) return formatModelString(activeModel);
			if (model) return formatModelString(model);
			return undefined;
		};
		const disposeCallbacks = new Set<() => void>();
		const toolSession: ToolSession = {
			get cwd() {
				return sessionManager.getCwd();
			},
			hasUI: options.hasUI ?? false,
			getApiKey: options.getApiKey,
			get additionalDirectories() {
				return sessionManager.getAdditionalDirectories();
			},
			enableLsp,
			lspReadOnly,
			enableIrc: options.enableIrc,
			coordinationBackend: options.coordinationBackend,
			contextFiles,
			workspaceTree: resolvedWorkspaceTree,
			get skills() {
				return session?.skills ?? skills;
			},
			refreshSkills: () => session.refreshSkills(),
			rules: allRules,
			eventBus,
			outputSchema: options.outputSchema,
			outputSchemaMode: options.outputSchemaMode,
			taskDepth: options.taskDepth ?? 0,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			sessionManager,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
			isDisposed: () => session?.isDisposed ?? false,
			getHindsightSessionState: () => session?.getHindsightSessionState(),
			getMnemopiSessionState: () => session?.getMnemopiSessionState(),
			getAgentId: () => resolvedAgentId,
			agentRegistry,
			// The global lifecycle releases through AgentRegistry.global(); wiring it
			// onto a caller-supplied registry would report a cancel while releasing an
			// unrelated global ref. With no lifecycle, hub cancel falls back to
			// dispose + unregister on the session's own registry.
			agentLifecycle: options.agentRegistry ? undefined : () => AgentLifecycleManager.global(),
			getSessionSpawns: () => options.spawns ?? "*",
			getModelString: () => (hasExplicitModel && model ? formatModelString(model) : undefined),
			getActiveModelString,
			getActiveModel: () => agent?.state.model ?? model,
			getServiceTierByFamily: () => session?.serviceTierByFamily,
			getImageAttachments: () => session?.getImageAttachments() ?? [],
			getVibeModeState: () => session?.getVibeModeState(),
			getGoalModeState: () => session?.getGoalModeState(),
			getGoalRuntime: () => session?.goalRuntime,
			getUsageStatistics: () => sessionManager.getUsageStatistics(),
			getClientBridge: () => session?.clientBridge,
			queueLaunchCompletion: notification =>
				session?.queueLaunchCompletion(notification) ??
				Promise.reject(new Error("Session unavailable for launch completion delivery")),
			registerDisposeCallback: callback => {
				disposeCallbacks.add(callback);
				return () => disposeCallbacks.delete(callback);
			},
			registerSessionChangeCallback: callback => session?.registerSessionChangeCallback(callback),
			getTodoPhases: () => session.getTodoPhases(),
			setTodoPhases: phases => session.setTodoPhases(phases),
			steer: msg =>
				session.agent.steer({
					role: "custom",
					customType: msg.customType,
					content: msg.content,
					display: false,
					details: msg.details,
					attribution: "agent",
					timestamp: Date.now(),
				}),
			allocateOutputArtifact: async toolType => {
				try {
					return await sessionManager.allocateArtifactPath(toolType);
				} catch {
					return {};
				}
			},
			getArtifactManager: () => sessionManager.getArtifactManager(),
			settings,
			authStorage,
			modelRegistry,
			getTelemetry: () => agent?.telemetry,
			// Subagents inherit the singleton (the parent's manager) so their bash/task
			// completions still flow into the spawning conversation's yieldQueue.
			// Secondary in-process top-level sessions (no parentTaskPrefix, no
			// constructed manager because the singleton was already installed) leave
			// this undefined so tools and session job snapshots refuse async work
			// instead of silently routing into the owning session (issue #1923).
			asyncJobManager: scopedAsyncJobManager,
			cronManager,
		};

		// The root releases the shared backend. Descendants receive the same object
		// and must not close it when their shorter session lifetime ends.
		if (!options.parentTaskPrefix && options.coordinationBackend) {
			disposeCallbacks.add(() => {
				void options.coordinationBackend?.close().catch(error => {
					logger.warn("Failed to close coordination backend", { error });
				});
			});
		}

		// Wire process-wide internal URL singletons owned by their real classes.
		// Top-level sessions install the active snapshots; subagents inherit them.
		// Artifact and agent-output URLs resolve via `AgentRegistry.global()` —
		// the protocol handlers walk each ref's `sessionManager.getArtifactsDir()`,
		// which collapses to the parent's dir for subagents (they adopt the
		// parent's ArtifactManager) so one lookup hits everything.
		const getArtifactsDir = () => sessionManager.getArtifactsDir();
		if (!options.parentTaskPrefix) {
			setActiveSkills(skills);
			// Include TTSR rules so `rule://<name>` can resolve them too. They are
			// registered with the manager and bucketed out before rulebook/always,
			// so without this a TTSR-only rule (e.g. a triggered builtin) is not
			// addressable and `rule://` reports "Available: none".
			setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
			if (asyncJobManager) AsyncJobManager.setInstance(asyncJobManager);
		}
		const localProtocolOptions = options.localProtocolOptions ?? {
			getArtifactsDir,
			getSessionId: () => sessionManager.getSessionId?.() ?? null,
		};
		if (options.localProtocolOptions && !options.parentTaskPrefix) {
			LocalProtocolHandler.setOverride(options.localProtocolOptions);
		}
		toolSession.getArtifactsDir = getArtifactsDir;
		toolSession.localProtocolOptions = localProtocolOptions;
		toolSession.agentOutputManager = new AgentOutputManager(
			getArtifactsDir,
			options.parentTaskPrefix ? { parentPrefix: options.parentTaskPrefix } : undefined,
		);

		// The provider ABI is fixed. Its closure resolves the session after construction.
		const ipythonTool = createIpythonProviderTool((code, signal, deferJournal) => {
			if (!session) throw new Error("IPython session is not initialized.");
			return session.executeIpythonCell({ code, origin: "model", signal, deferJournal });
		});

		const enableMCP = options.enableMCP ?? true;
		let mcpManager: MCPManager | undefined = enableMCP ? options.mcpManager : undefined;
		toolSession.mcpManager = mcpManager;
		toolSession.enableMCP = enableMCP;
		const deferMCPDiscoveryForUI = enableMCP && !mcpManager && options.hasUI === true;
		let startDeferredMCPDiscovery: ((liveSession: AgentSession) => void) | undefined;
		const startupQuiet = settings.get("startup.quiet");
		const onMCPStatus = (event: McpConnectionStatusEvent) => {
			if (!options.hasUI || startupQuiet) return;
			if (event.type === "connecting" && event.serverNames.length === 0) return;
			eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
		};
		const mcpDiscoverOptions = {
			onStatus: onMCPStatus,
			enableProjectConfig: settings.get("mcp.enableProjectConfig") ?? true,
			// Always filter Exa - we have native integration
			filterExa: true,
			// Filter browser MCP servers when the browser host service is active
			filterBrowser: settings.get("browser.enabled") ?? false,
		};
		if (enableMCP && !mcpManager) {
			if (deferMCPDiscoveryForUI) {
				mcpManager = new MCPManager(cwd);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}

				const deferredMCPManager = mcpManager;
				startDeferredMCPDiscovery = liveSession => {
					void (async () => {
						try {
							const mcpResult = await logger.time("discoverAndConnect", () =>
								deferredMCPManager.discoverAndConnect(mcpDiscoverOptions),
							);
							// The session can be torn down while servers are still connecting.
							// Don't resurrect tools on a disposed session, and don't leak the
							// transports/subprocesses the connect just spawned.
							if (liveSession.isDisposed) {
								await deferredMCPManager.disconnectAll();
								return;
							}
							applyMCPEnvironment(mcpResult);
							logMCPLoadErrors(mcpResult.errors);
						} catch (error) {
							logger.error("MCP tool load failed", {
								path: ".mcp.json",
								error: error instanceof Error ? error.message : String(error),
							});
						}
					})();
				};
			} else {
				mcpManager = new MCPManager(cwd);
				mcpManager.setAuthStorage(authStorage);
				toolSession.mcpManager = mcpManager;

				const connectedMCPManager = mcpManager;
				const mcpResult = await logger.time("discoverAndConnect", () =>
					connectedMCPManager.discoverAndConnect(mcpDiscoverOptions),
				);

				if (settings.get("mcp.notifications")) {
					mcpManager.setNotificationsEnabled(true);
				}
				applyMCPEnvironment(mcpResult);

				logMCPLoadErrors(mcpResult.errors);

				// The manager retains server metadata for typed IPython MCP calls.
			}
		}
		// Only top-level sessions own the global MCPManager. Subagents already
		// receive the parent's manager via `options.mcpManager`, and reassigning
		// the singleton to the same value is a no-op — keep the gate explicit
		// to mirror the AsyncJobManager ownership rule.
		if (mcpManager && !options.parentTaskPrefix) MCPManager.setInstance(mcpManager);

		const inlineExtensions: ExtensionFactory[] = [...(options.extensions ?? []), createAutoresearchExtension];

		// Load extensions. Three paths:
		//   1. `preloadedExtensions` (CLI): caller already loaded — reuse the
		//      Extension instances. Shallow-clone `extensions` so the inline
		//      push below cannot mutate the caller's array. `runtime` is shared
		//      so flag values set pre-creation flow into the live session.
		//   2. `preloadedExtensionPaths` (subagent): caller resolved paths;
		//      skip the FS scan but always re-call `loadExtensions` here so
		//      each `Extension` binds to THIS session's `ExtensionAPI`
		//      (cwd, eventBus, runtime).
		//   3. No preload: run the full session discovery.
		// `disableExtensionDiscovery` is honored implicitly: a caller that set
		// the flag and pre-resolved the result already reflects that choice.
		let extensionPaths: string[];
		let extensionsResult: LoadExtensionsResult;
		if (options.preloadedExtensions) {
			extensionsResult = {
				...options.preloadedExtensions,
				extensions: [...options.preloadedExtensions.extensions],
			};
			// Capture paths for downstream forwarding; filter inline-factory
			// entries (`<inline-N>`) — those are per-session, not source paths.
			extensionPaths = extensionsResult.extensions
				.map(ext => ext.resolvedPath)
				.filter(p => !p.startsWith("<inline"));
		} else if (options.preloadedExtensionPaths) {
			extensionPaths = options.preloadedExtensionPaths;
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		} else {
			extensionPaths = await logger.time("discoverSessionExtensionPaths", () =>
				discoverSessionExtensionPaths(options, cwd, settings),
			);
			extensionsResult = await logger.time("loadExtensions", loadExtensions, extensionPaths, cwd, eventBus);
			for (const { path, error } of extensionsResult.errors) {
				logger.error("Failed to load extension", { path, error });
			}
		}
		// Forward the source-path list (NOT the loaded instances) so subagents
		// rebuild their own session-scoped extensions.
		toolSession.extensionPaths = extensionPaths;

		// Load inline extensions from factories
		if (inlineExtensions.length > 0) {
			for (let i = 0; i < inlineExtensions.length; i++) {
				const factory = inlineExtensions[i];
				const loaded = await loadExtensionFromFactory(
					factory,
					cwd,
					eventBus,
					extensionsResult.runtime,
					`<inline-${i}>`,
				);
				extensionsResult.extensions.push(loaded);
			}
		}

		// Process provider registrations queued during extension loading.
		// This must happen before the runner is created so that models registered by
		// extensions are available for model selection on session resume / fallback.
		const activeExtensionSources = extensionsResult.extensions.map(extension => extension.path);
		// A restricted child may receive a fully-resolved parent model without
		// loading extensions itself. Do not let that child reconcile the shared
		// registry and tear down the parent's runtime provider registrations.
		const preserveInheritedRuntimeProviders =
			options.model !== undefined &&
			options.extensions === undefined &&
			options.preloadedExtensions === undefined &&
			options.preloadedExtensionPaths === undefined &&
			activeExtensionSources.length === 0;
		if (!preserveInheritedRuntimeProviders) {
			modelRegistry.syncExtensionSources(activeExtensionSources);
			for (const sourceId of new Set(activeExtensionSources)) {
				modelRegistry.clearSourceRegistrations(sourceId);
			}
		}
		if (extensionsResult.runtime.pendingProviderRegistrations.length > 0) {
			for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
				modelRegistry.registerProvider(name, config, sourceId);
			}
			extensionsResult.runtime.pendingProviderRegistrations = [];
		}
		// Hydrate cached runtime (extension) provider catalogs before model
		// resolution. Dynamic-only providers have no synchronous registration side
		// effect, so a cold --model/provider resume must see the same fresh SQLite
		// cache that `omp models find` uses before the online refresh continues in
		// the background.
		await modelRegistry.refreshRuntimeProviders("offline");
		// Continue runtime discovery in the background (cache-aware) so startup is
		// only blocked on local cache reads, not provider network fetches. Stash
		// the promise so the deferred `--model` retry below can await it instead
		// of starting a second concurrent discovery pass (the unfiltered
		// `refresh()` also covers runtime model managers).
		const runtimeDiscoveryPromise = modelRegistry.refreshRuntimeProviders().catch(error => {
			logger.warn("runtime provider discovery failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// Retry session-model candidates now that extension providers are
		// registered. The initial restore runs before extensions load, so a role
		// model supplied by an extension would have either fallen back to the
		// saved default (`restoredSessionModelIndex > 0`) or failed entirely
		// (`restoredSessionModelIndex === -1`, with the settings default or
		// downstream fallback filling `model`). Reclaim it here so resume
		// honors the last active role in either case.
		const sessionRetryLimit = restoredSessionModelIndex >= 0 ? restoredSessionModelIndex : sessionModelStrings.length;
		if (!hasExplicitModel && sessionRetryLimit > 0) {
			for (let i = 0; i < sessionRetryLimit; i++) {
				const sessionModelStr = sessionModelStrings[i];
				const parsedModel = parseModelString(sessionModelStr, {
					allowMaxSuffix: true,
					allowAutoAlias: true,
					isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
				});
				if (!parsedModel) continue;
				const restoredModel = modelRegistry.find(parsedModel.provider, parsedModel.id);
				if (restoredModel && hasModelAuth(restoredModel)) {
					model = restoredModel;
					modelFallbackMessage = undefined;
					restoredSessionModelIndex = i;
					restoredSessionThinkingLevel = parsedModel.thinkingLevel;
					// Recompute thinking-level from scratch against the reclaimed
					// model: any value derived from the earlier fallback model's
					// `thinking.defaultLevel` must not become sticky.
					thinkingLevel = pickInitialThinkingLevel(restoredModel);
					autoThinking = thinkingLevel === AUTO_THINKING;
					effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
					effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
						autoThinking
							? resolveProvisionalAutoLevel(restoredModel)
							: resolveThinkingLevelForModel(restoredModel, effectiveThinkingLevel),
					);
					preconnectModelHost(restoredModel.baseUrl);
					break;
				}
			}
		}
		// Resolve deferred --model/subagent patterns now that extension models are
		// registered. Use the same CLI resolver as the immediate path so bare role
		// names, exact model names, and provider selectors keep one precedence rule.
		if (!model && deferredModelPatterns.length > 0) {
			// Deferred `--model` patterns almost always failed at the immediate
			// path (main.ts:881) precisely because discovery-backed providers
			// hadn't populated yet. Await the in-flight runtime discovery
			// already kicked off above (stash + reuse avoids a second concurrent
			// `#refreshRuntimeDiscoveries` pass for the same runtime model
			// managers; it resolves instantly when no runtime managers are
			// registered). `refreshRuntimeProviders()` only covers runtime model
			// managers, not config-discovery providers (e.g. user-configured
			// ollama); fall back to a full cache-aware refresh only when the
			// runtime pass didn't surface a match AND config-discovery providers
			// exist to fetch from. By then runtime managers short-circuit on the
			// fresh cache written by the awaited pass, closing the double-fetch
			// window.
			await logger.time("resolveModelDiscoveryDeferredRetry", () => runtimeDiscoveryPromise);
			const matchPreferences = getModelMatchPreferences(settings);
			const runtimeResolved = deferredModelPatterns.some(pattern =>
				pattern.split(",").some(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return false;
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					return Boolean(
						resolved.model || (resolved.configuredPatterns && resolved.configuredPatterns.length > 0),
					);
				}),
			);
			if (!runtimeResolved && modelRegistry.getDiscoverableProviders().length > 0) {
				await logger.time("resolveModelDiscoveryFallbackNonRuntime", () =>
					modelRegistry.refresh("online-if-uncached"),
				);
			}
			const allModels = modelRegistry.getAll();
			const availableModels = modelRegistry.getAvailable();
			const expandedModelPatterns = deferredModelPatterns.flatMap(pattern =>
				pattern.split(",").flatMap(selector => {
					const trimmedSelector = selector.trim();
					if (!trimmedSelector) return [];
					const resolved = resolveCliModel({
						cliModel: trimmedSelector,
						modelRegistry,
						settings,
						preferences: matchPreferences,
					});
					if (resolved.configuredPatterns && resolved.configuredPatterns.length > 0) {
						const primaryPatterns: Array<{
							pattern: string;
							retryFallback: InitialRetryFallbackState | undefined;
						}> = resolved.configuredPatterns.map(pattern => ({
							pattern,
							retryFallback: undefined,
						}));
						if (!resolved.configuredRole || !settings.get("retry.modelFallback")) {
							return primaryPatterns;
						}
						const fallbackContext: RetryFallbackResolutionContext = {
							chains: expandDefaultRetryFallbackChains(settings.get("retry.fallbackChains"), [
								...Object.keys(settings.getModelRoles()),
								resolved.configuredRole,
							]),
							getModelRole: role => settings.getModelRole(role),
							modelLookup: modelRegistry,
						};
						const originalSelector = resolved.configuredPatterns[0];
						const availableOriginal = parseModelPattern(originalSelector, availableModels, matchPreferences);
						const originalModel =
							availableOriginal.model ?? parseModelPattern(originalSelector, allModels, matchPreferences).model;
						const chainKey = resolveRetryFallbackChainKey(
							fallbackContext,
							originalSelector,
							originalModel,
							resolved.configuredRole,
						);
						if (!chainKey) return primaryPatterns;
						const parsedOriginal = parseModelString(originalSelector, {
							allowMaxSuffix: true,
							allowAutoAlias: true,
							isLiteralModelId: (provider, id) => modelRegistry.find(provider, id) !== undefined,
						});
						const retryFallback: InitialRetryFallbackState = {
							role: chainKey,
							originalSelector,
							originalThinkingLevel: parsedOriginal?.thinkingLevel,
						};
						return [
							...primaryPatterns,
							...findRetryFallbackCandidates(fallbackContext, chainKey, originalSelector, originalModel, {
								allowMissingPrimary: true,
							}).map(candidate => ({ pattern: candidate.raw, retryFallback })),
						];
					}
					if (resolved.model) {
						return [
							{
								pattern: formatModelSelectorValue(
									resolved.selector ?? formatModelStringWithRouting(resolved.model),
									resolved.thinkingLevel,
								),
								retryFallback: undefined,
							},
						];
					}
					return resolveConfiguredModelPatterns([trimmedSelector], settings).map(pattern => ({
						pattern,
						retryFallback: undefined,
					}));
				}),
			);
			const resolutionModels = expandedModelPatterns.some(
				({ pattern }) => parseModelPattern(pattern, availableModels, matchPreferences).model,
			)
				? availableModels
				: allModels;
			let usageFallbackTriggered = false;
			for (let patternIndex = 0; patternIndex < expandedModelPatterns.length; patternIndex += 1) {
				const { pattern, retryFallback } = expandedModelPatterns[patternIndex];
				const primary = parseModelPattern(pattern, resolutionModels, matchPreferences);
				if (!primary.model || (retryFallback && !hasModelAuth(primary.model))) continue;
				let hasUsageFallbackCandidate = false;
				for (
					let candidateIndex = patternIndex + 1;
					candidateIndex < expandedModelPatterns.length;
					candidateIndex += 1
				) {
					const candidate = parseModelPattern(
						expandedModelPatterns[candidateIndex].pattern,
						resolutionModels,
						matchPreferences,
					);
					if (candidate.model && hasModelAuth(candidate.model)) {
						hasUsageFallbackCandidate = true;
						break;
					}
				}
				const usageReservePolicy = settings.get("retry.usageReservePolicy");
				const modelFallbackEnabled = settings.get("retry.modelFallback");
				if (
					((modelFallbackEnabled && (hasUsageFallbackCandidate || usageFallbackTriggered)) ||
						usageReservePolicy === "fail-closed") &&
					settings.get("retry.usageAwareFallback")
				) {
					let usageHealth: ModelUsageHealth | undefined;
					try {
						usageHealth = await modelRegistry.authStorage.getModelUsageHealth(primary.model.provider, {
							modelId: primary.model.id,
							baseUrl: primary.model.baseUrl,
							reserveFraction: settings.get("retry.usageReservePct") / 100,
						});
					} catch (error) {
						logger.debug("Usage-aware model preflight failed open", {
							provider: primary.model.provider,
							model: primary.model.id,
							error: String(error),
						});
					}
					if (usageHealth?.state === "depleted") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage depleted for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (modelFallbackEnabled) {
							usageFallbackTriggered = true;
							continue;
						}
					}
					if (usageHealth?.state === "reserve") {
						if (usageReservePolicy === "fail-closed") {
							throw new Error(
								`Usage reserve reached for ${primary.model.provider}/${primary.model.id}; reserve policy is fail-closed.`,
							);
						}
						if (
							modelFallbackEnabled &&
							(usageReservePolicy === "auto" || (!options.hasUI && !options.deferUsageReserveConfirmation))
						) {
							usageFallbackTriggered = true;
							continue;
						}
					}
				}
				let selectedModel = primary.model;
				let selectedThinkingLevel = primary.thinkingLevel;
				let selectedExplicitThinkingLevel = primary.explicitThinkingLevel;
				// A chain entry without its own `:level` suffix inherits the
				// unavailable primary's configured thinking level, matching
				// runtime fallback-chain semantics.
				if (retryFallback && !selectedExplicitThinkingLevel && retryFallback.originalThinkingLevel !== undefined) {
					selectedThinkingLevel = retryFallback.originalThinkingLevel;
					selectedExplicitThinkingLevel = true;
				}
				let authFallbackUsed = false;
				if (options.modelPatternAuthFallback) {
					const primaryKey = await modelRegistry.getApiKey(primary.model);
					if (primaryKey !== kNoAuth && !isAuthenticated(primaryKey)) {
						const fallback = parseModelPattern(
							options.modelPatternAuthFallback,
							resolutionModels,
							matchPreferences,
						);
						if (fallback.model) {
							const fallbackKey = await modelRegistry.getApiKey(fallback.model);
							if (isAuthenticated(fallbackKey)) {
								selectedModel = fallback.model;
								selectedThinkingLevel = fallback.thinkingLevel;
								selectedExplicitThinkingLevel = fallback.explicitThinkingLevel;
								authFallbackUsed = true;
							}
						}
					}
				}
				if (!authFallbackUsed && options.modelPatternFallbackRole) {
					const primarySelector = formatModelSelectorValue(
						formatModelStringWithRouting(primary.model),
						primary.thinkingLevel,
					);
					const seenSelectors = new Set<string>([primarySelector]);
					const fallbackSelectors: string[] = [];
					for (const fallbackEntry of expandedModelPatterns.slice(patternIndex + 1)) {
						const fallback = parseModelPattern(fallbackEntry.pattern, resolutionModels, matchPreferences);
						if (!fallback.model) continue;
						const fallbackSelector = formatModelSelectorValue(
							formatModelStringWithRouting(fallback.model),
							fallback.thinkingLevel,
						);
						if (seenSelectors.has(fallbackSelector)) continue;
						seenSelectors.add(fallbackSelector);
						fallbackSelectors.push(fallbackSelector);
					}
					if (fallbackSelectors.length === 0) {
						for (const selector of options.modelPatternDefaultFallbackChain ?? []) {
							if (typeof selector !== "string" || seenSelectors.has(selector)) continue;
							seenSelectors.add(selector);
							fallbackSelectors.push(selector);
						}
					}
					if (fallbackSelectors.length > 0) {
						const modelRoles: Record<string, string> = {};
						const existingRoles = settings.getModelRoles();
						for (const role in existingRoles) {
							const selector = existingRoles[role];
							if (selector) {
								modelRoles[role] = selector;
							}
						}
						modelRoles[options.modelPatternFallbackRole] = primarySelector;
						settings.override("modelRoles", modelRoles);
						const fallbackChains: Record<string, string[]> = {
							[options.modelPatternFallbackRole]: fallbackSelectors,
						};
						const existingFallbackChains = settings.get("retry.fallbackChains");
						for (const role in existingFallbackChains) {
							if (role !== options.modelPatternFallbackRole) {
								fallbackChains[role] = existingFallbackChains[role];
							}
						}
						settings.override("retry.fallbackChains", fallbackChains);
					}
				}
				model = selectedModel;
				initialRetryFallback =
					retryFallback && usageFallbackTriggered ? { ...retryFallback, pinned: true } : retryFallback;
				modelFallbackMessage = undefined;
				if (selectedExplicitThinkingLevel) {
					restoredSessionThinkingLevel = selectedThinkingLevel;
				}
				thinkingLevel = pickInitialThinkingLevel(selectedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(selectedModel)
						: resolveThinkingLevelForModel(selectedModel, effectiveThinkingLevel),
				);
				preconnectModelHost(selectedModel.baseUrl);
				break;
			}
			if (!model) {
				const requested =
					deferredModelPatterns.length === 1
						? `"${deferredModelPatterns[0]}"`
						: `one of ${deferredModelPatterns.map(pattern => `"${pattern}"`).join(", ")}`;
				modelFallbackMessage = `Model ${requested} not found`;
			}
		}

		// Fall back to first available model with a valid API key, honoring the
		// path-scoped `enabledModels` allow-list when configured. Skip when the
		// user explicitly requested a model via --model that wasn't found.
		if (!model && deferredModelPatterns.length === 0) {
			// Retry the configured default role against the current catalog,
			// setting `model` (+ thinking level) when it resolves. Extension
			// factories register providers AFTER the early `defaultRoleSpec`
			// resolution, and configured discovery providers may still be
			// mid-discovery, so a role pointing at such a model (an openai-compat
			// plugin's `posthog/claude-opus-4-8`, a models.yml `openai-models-list`
			// endpoint) returned `undefined` there. Without this retry the
			// `pickDefaultAvailableModel` fallback below happily replaces the
			// user's configured default with a bundled provider's default whenever
			// a stray `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is in the environment.
			// (issues #3569, #6162)
			const tryResolveDefaultRole = async (): Promise<boolean> => {
				if (hasExplicitModel) return false;
				// Re-resolve the allowed set: extension factories and discovery
				// refreshes above may have registered models not visible earlier.
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				const reResolvedRoleSpec = resolveModelRoleValue(settings.getModelRole("default"), fallbackCandidates, {
					settings,
					matchPreferences: modelMatchPreferences,
				});
				if (!reResolvedRoleSpec.model) return false;
				defaultRoleSpec = reResolvedRoleSpec;
				const resolvedDefaultModel = reResolvedRoleSpec.model;
				model = resolvedDefaultModel;
				modelFallbackMessage = undefined;
				// Recompute the thinking level against the now-real model.
				// `pickInitialThinkingLevel` closes over `defaultRoleSpec`,
				// so the role's explicit selector (e.g. `:max`) now applies.
				thinkingLevel = pickInitialThinkingLevel(resolvedDefaultModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(resolvedDefaultModel)
						: resolveThinkingLevelForModel(resolvedDefaultModel, effectiveThinkingLevel),
				);
				preconnectModelHost(resolvedDefaultModel.baseUrl);
				return true;
			};

			await tryResolveDefaultRole();

			if (!model) {
				const fallbackCandidates = await resolveAllowedModels(modelRegistry, settings, modelMatchPreferences);
				let pick = pickDefaultAvailableModel(fallbackCandidates.filter(hasModelAuth));

				// Cold-cache discovery race (issues #6114, #6162): a discovery
				// provider (models.yml `openai-models-list`, LM Studio/Ollama/
				// llama.cpp, or an openai-compat proxy) ships no static models, so
				// the static+cached catalog resolved nothing above. Background
				// discovery in main.ts fires only AFTER createAgentSession returns,
				// so on a cache-cold boot the configured default stays unresolved
				// and `pick` silently degrades to an unrelated authed provider's
				// default (#6162) or "No models available" (#6114) — even though
				// `omp models` (which awaits discovery) lists the model. Await one
				// cache-aware discovery pass and retry when a default role is
				// configured (must win over `pick`) or nothing resolved at all.
				// The common path — role already resolved, or a `pick` with no
				// configured default — never pays for it.
				const defaultRoleConfigured = Boolean(settings.getModelRole("default"));
				if (
					!hasExplicitModel &&
					(defaultRoleConfigured || !pick) &&
					modelRegistry.getDiscoverableProviders().length > 0
				) {
					await logger.time("resolveModelDiscoveryFallback", () => modelRegistry.refresh("online-if-uncached"));
					if (!(await tryResolveDefaultRole()) && !model) {
						const refreshedCandidates = await resolveAllowedModels(
							modelRegistry,
							settings,
							modelMatchPreferences,
						);
						pick = pickDefaultAvailableModel(refreshedCandidates.filter(hasModelAuth));
					}
				}

				if (!model && pick) {
					model = pick;
				}
			}
			if (model) {
				if (modelFallbackMessage) {
					modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
				}
			} else {
				const patterns = settings.get("enabledModels");
				modelFallbackMessage =
					patterns && patterns.length > 0
						? `No model available matching enabledModels (${patterns.join(", ")}) with usable credentials. Configure auth for an allowed provider or adjust enabledModels.`
						: "No models available. Use /login or set an API key environment variable. Then use /model to select a model.";
			}
		}

		if (model) {
			const selectedModel = model;
			const refreshedModel = await logger.time("refreshInitialModelMetadata", () =>
				modelRegistry.refreshSelectedModelMetadata(selectedModel),
			);
			if (refreshedModel !== selectedModel) {
				model = refreshedModel;
				thinkingLevel = pickInitialThinkingLevel(refreshedModel);
				autoThinking = thinkingLevel === AUTO_THINKING;
				effectiveThinkingLevel = concreteThinkingLevel(thinkingLevel);
				effectiveThinkingLevel = logger.time("resolveThinkingLevelForModel", () =>
					autoThinking
						? resolveProvisionalAutoLevel(refreshedModel)
						: resolveThinkingLevelForModel(refreshedModel, effectiveThinkingLevel),
				);
			}
		}

		// A first-turn user tail has no assistant metadata to copy. Once startup
		// has selected its final model, use that model to terminate the
		// interrupted turn before the live agent consumes the restored context.
		if (model) {
			const selectedModelAbort = createInterruptedTurnAbortMessage(existingBranch, {
				api: model.api,
				provider: model.provider,
				model: model.id,
			});
			if (selectedModelAbort) {
				sessionManager.appendMessage(selectedModelAbort);
				existingBranch = logger.time("getRecoveredUserTailBranch", () => sessionManager.getBranch());
				existingSession = logger.time("loadRecoveredUserTailContext", () => sessionManager.buildSessionContext());
			}
		}

		const customCommandsResult: CustomCommandsLoadResult = options.disableExtensionDiscovery
			? { commands: [], errors: [] }
			: await logger.time("discoverCustomCommands", loadCustomCommandsInternal, { cwd, agentDir });
		if (!options.disableExtensionDiscovery) {
			for (const { path, error } of customCommandsResult.errors) {
				logger.error("Failed to load custom command", { path, error });
			}
		}

		// Keep one runner even when no extensions are loaded so runtime hooks can be
		// refreshed in place without rebuilding session state.
		const extensionRunner: ExtensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			cwd,
			sessionManager,
			modelRegistry,
			() => (hasSession ? createSessionMemoryRuntimeContext(session, agentDir, cwd) : undefined),
			settings,
			localProtocolOptions,
			() => (hasSession ? session.getAsyncJobSnapshot() : null),
		);

		const retainedPreloadedInlineExtensions =
			options.preloadedExtensions?.extensions.filter(extension => extension.resolvedPath.startsWith("<inline")) ??
			[];

		/**
		 * Re-evaluate source definitions against the already initialized session
		 * runtime. Provider registrations are deliberately never published by this
		 * path: live definition reload is for hooks/IPython/UI declarations, not
		 * provider roster mutation.
		 */
		const reloadExtensions = async (): Promise<Extension[]> => {
			const runtime = extensionsResult.runtime;
			const flagValues = new Map(runtime.flagValues);
			const pendingProviderRegistrations = [...runtime.pendingProviderRegistrations];
			try {
				const reloadPaths = options.preloadedExtensionPaths
					? options.preloadedExtensionPaths
					: options.preloadedExtensions
						? extensionPaths
						: await discoverSessionExtensionPaths(options, cwd, settings);
				const loaded = await loadExtensionsIntoRuntime(reloadPaths, cwd, eventBus, runtime);
				if (loaded.errors.length > 0) {
					throw new Error(loaded.errors.map(({ path, error }) => `${path}: ${error}`).join("\n"));
				}
				loaded.extensions.push(...retainedPreloadedInlineExtensions);
				for (let index = 0; index < inlineExtensions.length; index += 1) {
					const factory = inlineExtensions[index];
					if (!factory) continue;
					loaded.extensions.push(
						await loadExtensionFromFactory(factory, cwd, eventBus, runtime, `<inline-${index}>`),
					);
				}
				// Flags are parsed at process admission and are not a live-reload surface.
				// Candidate registration executes against the shared runtime, so restore
				// the admitted values before returning candidates to the package gate.
				runtime.flagValues.clear();
				for (const [name, value] of flagValues) runtime.flagValues.set(name, value);
				// Loading candidates may queue providers. Keep prior startup state but
				// discard every new request on success: reload cannot change providers.
				runtime.pendingProviderRegistrations.splice(pendingProviderRegistrations.length);
				return loaded.extensions;
			} catch (error) {
				runtime.flagValues.clear();
				for (const [name, value] of flagValues) runtime.flagValues.set(name, value);
				runtime.pendingProviderRegistrations = pendingProviderRegistrations;
				throw error;
			}
		};

		credentialDisabledTarget = extensionRunner;
		for (const event of startupCredentialDisabledEvents.splice(0)) {
			// Discard return: any handler error is routed through runner.onError listeners.
			void extensionRunner.emitCredentialDisabled(event);
		}

		const getSessionContext = () => ({
			sessionManager,
			modelRegistry,
			model: agent.state.model,
			isIdle: () => !session.isStreaming,
			hasQueuedMessages: () => session.queuedMessageCount > 0,
			abort: () => {
				session.abort({ reason: USER_INTERRUPT_LABEL });
			},
			settings,
			localProtocolOptions,
			autoApprove: options.autoApprove ?? false,
		});
		const toolContextStore = new ToolContextStore(getSessionContext);
		const taskAdmissionService = TaskService.create(toolSession);
		const agentFamilyService = new OmpAgentFamilyService({
			registry: agentRegistry,
			currentAgentId: () => resolvedAgentId,
			currentSessionId: () => sessionManager.getSessionId(),
			currentCwd: () => sessionManager.getCwd(),
			currentSessionFile: () => sessionManager.getSessionFile() ?? null,
			coordinationBackend: options.coordinationBackend,
		});

		const rebuildSystemPrompt = async (): Promise<BuildSystemPromptResult> => {
			const promptCwd = sessionManager.getCwd();
			if (hasSession && options.contextFiles === undefined) {
				contextFiles = await logger.time("discoverContextFiles", discoverContextFiles, promptCwd, agentDir, [
					...(settings.get("disabledExtensions") ?? []),
				]);
				toolSession.contextFiles = contextFiles;
				session.setAdvisorContextPrompt(formatAdvisorContextPrompt(contextFiles));
			}
			const defaultPrompt = await buildSystemPromptInternal({
				additionalWorkspaceRoots: sessionManager.getAdditionalDirectories(),
				alwaysApplyRules,
				contextFiles,
				cwd: promptCwd,
				recursiveDepth: options.taskDepth ?? 0,
				resolvedAppendSystemPrompt: options.appendSystemPrompt,
				resolvedCustomPrompt: options.customSystemPrompt,
				sessionLogLocation: sessionManager.getSessionFile() ?? "unavailable",
				sessionNotice: agentKind === "sub" ? "subagent" : "root",
			});

			if (options.requestProfile) return { systemPrompt: [...options.requestProfile.systemPrompt] };
			if (options.systemPrompt === undefined) {
				return defaultPrompt;
			}
			const customPrompt =
				typeof options.systemPrompt === "function"
					? options.systemPrompt(defaultPrompt.systemPrompt)
					: options.systemPrompt;
			return {
				systemPrompt: typeof customPrompt === "string" ? [customPrompt] : customPrompt,
			};
		};

		// Pre-register in the global agent registry BEFORE building the system prompt,
		// so that subagents launched in the same parallel batch can see each other in
		// their initial `# IRC Peers` block (rendered inside `rebuildSystemPrompt`).
		// The session reference is attached after construction below.
		const registrationInput = {
			id: resolvedAgentId,
			displayName: resolvedAgentDisplayName,
			kind: agentKind,
			parentId: options.parentAgentId,
			session: null,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "running" as const,
		};
		registeredAgentRef =
			options.expectedAgentRef === undefined
				? agentRegistry.register(registrationInput)
				: agentRegistry.registerIfAvailable(registrationInput, options.expectedAgentRef);
		if (!registeredAgentRef) {
			throw new Error(`Agent "${resolvedAgentId}" is already owned by another session generation.`);
		}
		// A reused parked ref remains parked until the new AgentSession is fully
		// constructed and attached. Startup failure therefore leaves it revivable.
		hasRegistered = options.expectedAgentRef === undefined || options.expectedAgentRef === null;

		const { systemPrompt } = await logger.time("buildSystemPrompt", rebuildSystemPrompt);
		const requestProfileOwner = options.requestProfile
			? new RequestProfileOwner(options.requestProfile)
			: RequestProfileOwner.primary(systemPrompt, ipythonTool);

		const promptTemplates = await promptTemplatesPromise;
		toolSession.promptTemplates = promptTemplates;

		const slashCommands = await slashCommandsPromise;

		// Keep image blocks off the wire when they'd be rejected: either the user
		// disabled images (`images.blockImages`) or the active model has no vision
		// support. The latter covers switching from a vision model to a text-only
		// one mid-session — historical image blocks would otherwise be replayed to
		// a provider that 400s on them (#5400). Read both dynamically so a `/model`
		// switch or setting change takes effect on the next turn.
		const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
			const converted = convertToLlm(messages);
			if (settings.get("images.blockImages")) {
				return replaceLlmImagesWithText(converted, "Image reading is disabled.");
			}
			const activeModel = agent?.state.model ?? model;
			if (activeModel && !activeModel.input.includes("image")) {
				return replaceLlmImagesWithText(
					converted,
					"[image omitted: the active model does not support image input]",
				);
			}
			return converted;
		};
		const convertToLlmFinal = (messages: AgentMessage[]): Message[] =>
			filterProviderReplayMessages(convertToLlmWithBlockImages(messages));

		const transformContext = async (messages: AgentMessage[], _signal?: AbortSignal) => {
			const withContext = await extensionRunner.emitContext(messages);
			return wrapSteeringForModel(withContext);
		};
		// Per-request provider-context transforms, then clamp images to the active provider budget.
		const snapcompactSystemPromptMode = settings.get("snapcompact.systemPrompt");
		const snapcompactInline =
			snapcompactSystemPromptMode !== "none" || settings.get("snapcompact.toolResults")
				? new SnapcompactInlineTransformer(
						{
							renderSystemPrompt: snapcompactSystemPromptMode,
							renderToolResults: settings.get("snapcompact.toolResults"),
							shape: settings.get("snapcompact.shape"),
						},
						// Journal the tokens each imaged tool result keeps off the wire
						// (frames never reach session.jsonl, so this is their only trace).
						createSnapcompactSavingsRecorder(() => sessionManager.getSessionFile() ?? null),
					)
				: undefined;
		const transformProviderContext = async (context: Context, transformModel: Model): Promise<Context> => {
			let transformed = context;
			if (snapcompactInline) transformed = await snapcompactInline.transform(transformed, transformModel);
			return clampProviderContextImages(transformed, transformModel);
		};
		const extensionOnPayload = async (payload: unknown, model?: Model) => {
			const toolSnapshot = snapshotIpythonProviderTools(payload);
			const replacement = await extensionRunner.emitBeforeProviderRequest(payload, model);
			return preserveIpythonProviderTools(toolSnapshot, replacement);
		};
		const onFinalPayload: SimpleStreamOptions["onFinalPayload"] = (payload, requestModel) => {
			requestProfileOwner.captureEffectiveRequest({
				provider: requestModel?.provider ?? "unknown",
				payload,
			});
		};
		const onResponse: SimpleStreamOptions["onResponse"] = async (response, model) => {
			await extensionRunner.emitAfterProviderResponse(response, model);
		};

		const setToolUIContext = (uiContext: ExtensionUIContext, hasUI: boolean) => {
			toolContextStore.setUIContext(uiContext, hasUI);
		};

		const initialTools: AgentTool[] = [...requestProfileOwner.request.tools];

		const openaiWebsocketSetting = settings.get("providers.openaiWebsockets") ?? "off";
		const preferOpenAICodexWebsockets =
			openaiWebsocketSetting === "on" ? true : openaiWebsocketSetting === "off" ? false : undefined;
		const configuredServiceTierByFamily = hasServiceTierEntry
			? (existingSession.serviceTier ?? {})
			: buildServiceTierByFamily(
					settings.get("tier.openai"),
					settings.get("tier.anthropic"),
					settings.get("tier.google"),
				);
		const initialServiceTierByFamily = { ...configuredServiceTierByFamily };
		if (options.openAIServiceTier === null) {
			delete initialServiceTierByFamily.openai;
		} else if (options.openAIServiceTier !== undefined) {
			initialServiceTierByFamily.openai = options.openAIServiceTier;
		}

		// One-shot launch-latency marker: fired the first time the loop dispatches
		// a chat request to the provider transport. See onFirstChatDispatch.
		let notifyFirstChatDispatch = options.onFirstChatDispatch;
		// Shared, settings-aware stream wrapper used by the main agent, advisor,
		// and side-channel requests (`/btw`, `/omfg`, IRC auto-replies, handoff).
		// Keeps OpenRouter sticky-routing variants, antigravity endpoint routing,
		// in-flight caps, and the loop guard consistent across every provider call
		// the session drives. Wrapped in a per-provider concurrency limiter so
		// each LLM HTTP request — not the whole subagent lifecycle — holds the
		// slot, preventing the nested-spawn deadlock from issue #3749.
		const settingsAwareStreamFn = wrapStreamFnWithProviderConcurrency(
			settings,
			createSettingsAwareStreamFn(settings),
		);
		const kimiApiFormatSetting = settings.get("providers.kimiApiFormat");
		const kimiApiFormat = kimiApiFormatSetting === "auto" ? undefined : kimiApiFormatSetting;
		agent = new Agent({
			initialState: {
				systemPrompt,
				model,
				thinkingLevel: toReasoningEffort(effectiveThinkingLevel),
				disableReasoning: shouldDisableReasoning(effectiveThinkingLevel),
				tools: initialTools,
			},
			cwd,
			// Live cwd: `/move` updates SessionManager (and process cwd) without
			// reconstructing the Agent, so a static cwd would strand GitLab Duo Agent
			// namespace/project discovery on the original repo's git remote. Re-read it
			// per turn from the SessionManager.
			cwdResolver: () => sessionManager.getCwd(),
			convertToLlm: convertToLlmFinal,
			onPayload: extensionOnPayload,
			onFinalPayload,
			onResponse,
			sessionId: providerSessionId,
			promptCacheKey: providerPromptCacheKey,
			deadline: options.deadline,
			transformContext,
			transformProviderContext,
			steeringMode: settings.get("steeringMode") ?? "one-at-a-time",
			followUpMode: settings.get("followUpMode") ?? "one-at-a-time",
			interruptMode: settings.get("interruptMode") ?? "immediate",
			thinkingBudgets: settings.getGroup("thinkingBudgets"),
			temperature: settings.get("temperature") >= 0 ? settings.get("temperature") : undefined,
			topP: settings.get("topP") >= 0 ? settings.get("topP") : undefined,
			topK: settings.get("topK") >= 0 ? settings.get("topK") : undefined,
			minP: settings.get("minP") >= 0 ? settings.get("minP") : undefined,
			presencePenalty: settings.get("presencePenalty") >= 0 ? settings.get("presencePenalty") : undefined,
			repetitionPenalty: settings.get("repetitionPenalty") >= 0 ? settings.get("repetitionPenalty") : undefined,
			hideThinkingSummary: settings.get("omitThinking"),
			kimiApiFormat,
			preferWebsockets: preferOpenAICodexWebsockets,
			getApiKey: options.getApiKey ?? (requestModel => modelRegistry.resolver(requestModel, agent.sessionId)),
			streamFn: (streamModel, context, streamOptions) => {
				if (notifyFirstChatDispatch) {
					const cb = notifyFirstChatDispatch;
					notifyFirstChatDispatch = undefined;
					try {
						cb();
					} catch (err) {
						logger.warn("onFirstChatDispatch hook threw", {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				}
				return settingsAwareStreamFn(streamModel, context, streamOptions);
			},
			abortOnFabricatedToolResult: settings.get("tools.abortOnFabricatedResult"),
			telemetry: options.telemetry,
			appendOnlyContext: model
				? shouldEnableAppendOnlyContext(settings.get("provider.appendOnlyContext"), model)
					? new AppendOnlyContextManager()
					: undefined
				: undefined,
		});

		// Restore messages if session has existing data
		if (hasExistingSession) {
			agent.replaceMessages(existingSession.messages);
			if (options.openAIServiceTier !== undefined) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		} else {
			// Save initial model, thinking level, and service tier for new sessions so they can be restored on resume.
			if (model) {
				sessionManager.appendModelChange(`${model.provider}/${model.id}`);
			}
			if (!autoThinking) {
				// Do not write the `auto` selector before the first turn resolves; auto
				// classification persists its concrete effort once a real user turn runs.
				sessionManager.appendThinkingLevelChange(effectiveThinkingLevel);
			}
			if (options.openAIServiceTier !== undefined || Object.keys(initialServiceTierByFamily).length > 0) {
				sessionManager.appendServiceTierChange(
					Object.keys(initialServiceTierByFamily).length > 0 ? initialServiceTierByFamily : null,
				);
			}
		}

		const advisorWatchdogPrompts = [...watchdogFiles];
		if (initialActiveRepoContext) {
			advisorWatchdogPrompts.push(formatActiveRepoWatchdogPrompt(initialActiveRepoContext));
		}
		const advisorWatchdogPrompt = advisorWatchdogPrompts.length > 0 ? advisorWatchdogPrompts.join("\n\n") : undefined;
		// Hand the advisor the same project context files (AGENTS.md, etc.) the
		// primary agent gets in its system prompt, so the read-only reviewer judges
		// against the user's standing project rules instead of advising blind.
		const advisorContextPrompt = formatAdvisorContextPrompt(contextFiles);
		// Owned only when this session created the manager; subagents receive a
		// parent's manager via `options.mcpManager` and MUST NOT disconnect it.
		const ownedMcpManager = options.mcpManager ? undefined : mcpManager;
		// A resumed session already has advisor turns on disk; without this the status
		// line would restart its `(adv)` total at zero for the rest of the session.
		const initialAdvisorCosts = await loadAdvisorTranscriptCosts(sessionManager.getSessionFile());
		session = new AgentSession({
			advisorWatchdogPrompt,
			advisorContextPrompt,
			advisorSharedInstructions: discoveredAdvisors.sharedInstructions,
			advisorConfigs: discoveredAdvisors.advisors,
			agent,
			requestProfileOwner,
			thinkingLevel: autoThinking ? AUTO_THINKING : effectiveThinkingLevel,
			thinkingLevelCeiling: options.thinkingLevelCeiling,
			initialRetryFallback,
			serviceTierByFamily: initialServiceTierByFamily,
			sessionManager,
			initialAdvisorCosts,
			settings,
			coordinationLifecycle: options.coordinationLifecycle,
			sendParentIrcReply: options.coordinationBackend
				? async message =>
						await options.coordinationBackend!.send({
							targetPeerId: message.to,
							message: {
								...message,
								id: Snowflake.next(),
								ts: Date.now(),
								source: "parent",
							},
						})
				: undefined,
			autoApprove: options.autoApprove,
			scoutAllowedBySpawnPolicy: isScoutSpawnable(undefined, options.spawns ?? "*"),
			// Defined only for top-level sessions (creation is gated above).
			// AgentSession uses this to decide whether it may dispose the global
			// AsyncJobManager on teardown; subagents inherit the parent's and
			// **MUST NOT** tear it down.
			ownedAsyncJobManager: asyncJobManager,
			asyncJobManager: scopedAsyncJobManager,
			scopedModels: options.scopedModels,
			promptTemplates,
			slashCommands,
			extensionRunner,
			reloadExtensions,
			customCommands: customCommandsResult.commands,
			skills,
			skillWarnings,
			pythonPackages: [...resolvedPythonPackages.packages],
			skillsReloadable: options.skills === undefined,
			skillsSettings: settings.getGroup("skills"),
			modelRegistry,
			ipythonTool,
			taskAdmissionService,
			agentFamilyService,
			memoryAgentDir: agentDir,
			memoryTaskDepth: taskDepth,

			createIpythonAskService: () =>
				new IpythonAskService({
					owner: () => createSessionAskOwner(toolSession, toolContextStore.getContext()),
				}),
			createIpythonAutoQaService: () =>
				new IpythonAutoQaService({
					owner: {
						reportIssue: async input =>
							await reportAutoQaIssue({
								settings: toolSession.settings,
								model: toolSession.getActiveModelString?.() ?? "unknown",
								...input,
							}),
					},
				}),
			createIpythonVibeService: () => new IpythonVibeService({ session: toolSession }),
			createIpythonCronService: () => new IpythonCronService({ owner: () => cronManager }),
			createIpythonGithubService: () => createIpythonGithubService(toolSession),
			createIpythonImageService: () =>
				createIpythonImageService(
					() => toolContextStore.getContext(),
					() => toolSession.getImageAttachments?.() ?? [],
				),
			createIpythonSecurityService: () =>
				new IpythonSecurityService({
					coordinator: request =>
						getSecurityCoordinator({
							cwd: request.cwd,
							settings: toolSession.settings,
							authStorage: modelRegistry.authStorage,
							modelRegistry,
							activeModel: toolSession.getActiveModel?.() ?? model,
							sessionId: request.sessionId,
							agentId: toolSession.getAgentId?.() ?? undefined,
							asyncJobManager: scopedAsyncJobManager,
						}),
					store: request => SecurityStore.openForCwd(request.cwd, { signal: request.signal }),
					publisher: options.securityPublisher,
				}),
			createIpythonBrowserService: () => createIpythonBrowserService(toolSession),
			createIpythonComputerService: () =>
				new IpythonComputerService({
					createController: async () => new ComputerSupervisor(),
					snapshot: async (readOnly, identity) => createComputerSessionSnapshot(toolSession, readOnly, identity),
					timeoutMs: async requested =>
						clampTimeout("computer", requested, toolSession.settings.get("tools.maxTimeout")) * 1_000,
				}),
			createIpythonWebService: () => createIpythonWebService(toolSession),
			transformContext,
			transformProviderContext,
			onPayload: extensionOnPayload,
			onResponse,
			sideStreamFn: settingsAwareStreamFn,
			advisorStreamFn: settingsAwareStreamFn,
			preferWebsockets: preferOpenAICodexWebsockets,
			convertToLlm: convertToLlmFinal,
			rebuildSystemPrompt,
			mcpManager,

			disconnectOwnedMcpManager: ownedMcpManager ? () => ownedMcpManager.disconnectAll() : undefined,
			ttsrManager,
			agentId: resolvedAgentId,
			agentKind,
			providerSessionId: options.providerSessionId,
			providerPromptCacheKeySource,
			titleSystemPrompt: options.titleSystemPrompt,
			onSessionTransition: () => cronManager.refresh(),
			beginSessionFork: () => cronManager.suspendForFork(),
			completeSessionFork: (result, isCurrent) => cronManager.completeFork(result, isCurrent),
		});
		session.subscribe(event => {
			if (event.type === "ipython_cell_end") recordIpythonCellTelemetry(event.presentation);
			else if (event.type === "act_event" && event.event === "terminal") recordActTelemetry(event);
		});
		hasSession = true;
		session.yieldQueue.register<McpNotificationEntry>("mcp-notification", {
			build: buildMcpNotificationBatchMessage,
		});
		void cronManager.prepare().catch(error => {
			logger.warn("Cron session load failed during startup", { error });
		});

		// Attach the live session to the pre-registered ref so peers can route IRC
		// messages here. Refresh sessionFile in case it was unavailable at pre-register
		// time. The dispose wrapper below unregisters on teardown (unless parked).
		if (
			!registeredAgentRef ||
			!agentRegistry.attachSession(
				resolvedAgentId,
				session,
				sessionManager.getSessionFile() ?? null,
				registeredAgentRef,
			) ||
			!agentRegistry.setStatus(resolvedAgentId, "running", registeredAgentRef)
		) {
			throw new Error(`Agent "${resolvedAgentId}" was replaced during session initialization.`);
		}
		hasRegistered = true;
		if (options.coordinationBackend && options.enableIrc !== false) {
			options.coordinationBackend.attachMailbox(resolvedAgentId, session);
		}
		// MCP notification bridge cleanup — assigned when the bridge is wired below,
		// invoked from the dispose wrapper AND registered as a postmortem so both
		// explicit-dispose (SDK embedders that reuse the process across sessions) and
		// process-exit paths tear the listener down. Nulled after use so the closure
		// graph (`extensionRunner`, `session`) can be GC'd instead of retained by the
		// process-global postmortem list.
		let unsubscribeMcpNotifications: (() => void) | undefined;
		let unregisterMcpPostmortem: (() => void) | undefined;

		{
			const originalDispose = session.dispose.bind(session);
			session.dispose = async () => {
				try {
					// Reject new session work (eval starts) the moment disposal
					// begins — the lifecycle await below opens an async gap before
					// AgentSession.dispose() would otherwise set its guards.
					session.beginDispose();
					// Stops scheduling synchronously, then drains an already accepted
					// delivery so its lease release and scheduled-task write finish
					// before teardown closes the storage backend underneath them.
					await cronManager.dispose();
					if (agentKind === "main") {
						// Top-level teardown owns the global agent lifecycle: park timers,
						// adopted subagent sessions, revivers. Tear it down while shared
						// resources (kernels, MCP, LSP) are still live. Subagent disposal
						// must NOT touch the global lifecycle.
						const vibeRegistry = VibeSessionRegistry.global();
						const vibeParentSession = {
							getAgentId: () => resolvedAgentId,
							getSessionId: () => sessionManager.getSessionId(),
							getSessionFile: () => sessionManager.getSessionFile() ?? null,
							sessionManager,
							asyncJobManager: scopedAsyncJobManager,
							settings,
							getActiveModelString,
						};
						await vibeRegistry.suspendScope(vibeRegistry.ownerScope(vibeParentSession), scopedAsyncJobManager);
						await AgentLifecycleManager.global().dispose();
					}
					await originalDispose();
				} finally {
					unregisterUnlessParked();
					unsubscribeCredentialDisabled?.();
					unsubscribeMcpNotifications?.();
					unregisterMcpPostmortem?.();
					for (const callback of disposeCallbacks) callback();
					disposeCallbacks.clear();
					// Drop refs so the process-global postmortem list doesn't retain
					// the bridge closure past explicit dispose.
					unsubscribeMcpNotifications = undefined;
					unregisterMcpPostmortem = undefined;
				}
			};
		}

		if (model?.api === "openai-codex-responses") {
			// `.api` equality doesn't narrow the generic; the guard makes this cast sound.
			const codexModel = model as Model<"openai-codex-responses">;
			const codexTransport = getOpenAICodexTransportDetails(codexModel, {
				sessionId: providerSessionId,
				baseUrl: codexModel.baseUrl,
				preferWebsockets: preferOpenAICodexWebsockets,
				providerSessionState: session.providerSessionState,
			});
			if (codexTransport.websocketPreferred) {
				void (async () => {
					try {
						const codexPrewarmApiKey = options.getApiKey
							? // `getApiKey` returns a value-or-promise union; unwrap the promise,
								// then resolve the result if it is itself an ApiKeyResolver.
								await resolveApiKeyOnce(await options.getApiKey(codexModel))
							: await modelRegistry.getApiKey(codexModel, providerSessionId);
						if (!codexPrewarmApiKey) return;
						await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, codexModel, {
							apiKey: codexPrewarmApiKey,
							sessionId: providerSessionId,
							preferWebsockets: preferOpenAICodexWebsockets,
							providerSessionState: session.providerSessionState,
						});
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.debug("Codex websocket prewarm failed", {
							error: errorMessage,
							provider: codexModel.provider,
							model: codexModel.id,
						});
					}
				})();
			}
		}

		// Broker-shared language servers: one server per project, multiplexed
		// across omp instances by the LSP mux daemon. Session-level because the
		// flag lives in module state consulted on every client cold-start.
		setSharedLspEnabled(enableLsp && settings.get("lsp.shared"));

		// Start LSP warmup in the background so startup does not block on language server initialization.
		// With `lsp.lazy` (the default) the warmup is skipped: recognized servers are still discovered and
		// surfaced in the UI as "available", but cold-start on first use — the LSP host service or a code edit
		// touching a matching file type — through `getOrCreateClient`.
		// Print/script invocations (`hasUI=false`) skip it regardless: they don't render the warmup status
		// indicator AND typically finish before LSP servers would have stabilized — warming them just spends
		// CPU parsing big `initialize` responses concurrently with the LLM stream consumer, jittering
		// perceived latency.
		let lspServers: CreateAgentSessionResult["lspServers"];
		if (enableLsp && options.hasUI && settings.get("lsp.lazy")) {
			lspServers = discoverStartupLspServers(cwd, "available");
		} else if (enableLsp && options.hasUI) {
			lspServers = discoverStartupLspServers(cwd);
			if (lspServers.length > 0) {
				void (async () => {
					try {
						const result = await logger.time("warmupLspServers", warmupLspServers, cwd);
						const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
						for (const server of lspServers ?? []) {
							const next = serversByName.get(server.name);
							if (!next) continue;
							server.status = next.status;
							server.fileTypes = next.fileTypes;
							server.error = next.error;
						}
						const event: LspStartupEvent = {
							type: "completed",
							servers: result.servers,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					} catch (error) {
						const errorMessage = error instanceof Error ? error.message : String(error);
						logger.warn("LSP server warmup failed", {
							cwd,
							error: errorMessage,
						});
						for (const server of lspServers ?? []) {
							server.status = "error";
							server.error = errorMessage;
						}
						const event: LspStartupEvent = {
							type: "failed",
							error: errorMessage,
						};
						if (!startupQuiet) eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
					}
				})();
			}
		}

		const startMemoryBackend = async () => {
			const memoryBackend = await resolveMemoryBackend(settings);
			await memoryBackend.start({
				session,
				settings,
				modelRegistry,
				agentDir,
				taskDepth,
				parentHindsightSessionState: options.parentHindsightSessionState,
				parentMnemopiSessionState: options.parentMnemopiSessionState,
			});
		};

		void logger.time("startMemoryStartupTask", startMemoryBackend);

		// MCP manager wiring has two ownership models:
		//   * Single-slot callbacks (tools/prompts/resources changed) — exactly one
		//     owner per manager. When reusing a parent's manager (subagent path,
		//     see task/executor.ts), the parent already owns these slots so we
		//     MUST NOT overwrite them. Guarded by `!options.mcpManager`.
		//   * Notification listener — multi-listener by design. Every session with
		//     an MCP manager (fresh OR reused) needs its own bridge to its own
		//     `extensionRunner` so extensions loaded in that session receive frames.
		//     Guarded only by `mcpManager` (see the second `if` below).
		if (mcpManager && !options.mcpManager) {
			// Wire prompt refresh → rebuild MCP prompt slash commands
			mcpManager.setOnPromptsChanged(serverName => {
				const promptCommands = buildMCPPromptCommands(mcpManager);
				session.setMCPPromptCommands(promptCommands);
				logger.debug("MCP prompt commands refreshed", {
					path: `mcp:${serverName}`,
				});
			});
			const notificationDebounceTimers = new Map<string, Timer>();
			const clearDebounceTimers = () => {
				for (const timer of notificationDebounceTimers.values()) clearTimeout(timer);
				notificationDebounceTimers.clear();
			};
			postmortem.register("mcp-notification-cleanup", clearDebounceTimers);
			mcpManager.setOnResourcesChanged((serverName, uri) => {
				logger.debug("MCP resources changed", {
					path: `mcp:${serverName}`,
					uri,
				});
				if (!settings.get("mcp.notifications")) return;
				const debounceMs = settings.get("mcp.notificationDebounceMs");
				const key = `${serverName}:${uri}`;
				const existing = notificationDebounceTimers.get(key);
				if (existing) clearTimeout(existing);
				notificationDebounceTimers.set(
					key,
					setTimeout(() => {
						notificationDebounceTimers.delete(key);
						// Re-check: user may have disabled notifications during the debounce window
						if (!settings.get("mcp.notifications")) return;
						session.yieldQueue.enqueue<McpNotificationEntry>("mcp-notification", { serverName, uri });
					}, debounceMs),
				);
			});
		}

		if (mcpManager) {
			// Bridge server-initiated notifications to this session's extension
			// handlers. Multi-listener registration: fresh-manager and reused-manager
			// sessions both install their own listener here, so a subagent's
			// extensions get frames even though the parent owns the single-slot
			// tool/prompt/resource callbacks above. MCPManager fires known
			// list/update refreshes internally, then invokes all registered
			// listeners with (server, method, params) for every frame (including
			// server-custom methods). Two-layer buffering protects the startup
			// race: MCPManager buffers frames received before the first
			// `addNotificationListener` subscriber (drains here); ExtensionRunner
			// buffers frames received before `initialize()` and drains them on
			// init. Both drop-oldest under pressure at cap 100.
			unsubscribeMcpNotifications = mcpManager.addNotificationListener((server, method, params) => {
				void extensionRunner.emitMcpNotification({ server, method, params });
			});
			// postmortem.register returns a cancel function; capture it so explicit
			// session.dispose can remove this from the global list (see finally above).
			unregisterMcpPostmortem = postmortem.register("mcp-notification-listener-cleanup", () =>
				unsubscribeMcpNotifications?.(),
			);
		}

		startDeferredMCPDiscovery?.(session);
		cronManager.start();

		return {
			session,
			extensionsResult,
			setToolUIContext,
			mcpManager,
			modelFallbackMessage,
			lspServers,
			eventBus,
		};
	} catch (error) {
		// Release the subscription if the throw happened after install but before the
		// dispose-wrap took ownership. Idempotent with dispose() — Set.delete is a no-op
		// for already-removed listeners.
		unsubscribeCredentialDisabled?.();
		// Drain here too: a throw before the dispose wrapper was installed leaves
		// no other owner for in-flight cron custody, and re-disposing is a no-op.
		await cronManager.dispose();
		try {
			if (hasSession) {
				await session.dispose();
				if (hasRegistered) unregisterUnlessParked();
			} else {
				if (hasRegistered) unregisterUnlessParked();
				if (asyncJobManager) {
					if (AsyncJobManager.instance() === asyncJobManager) {
						AsyncJobManager.setInstance(undefined);
					}
					await asyncJobManager.dispose({ timeoutMs: 3_000 });
				}
				if (ownsAuthStorage) authStorage.close();
			}
		} catch (cleanupError) {
			logger.warn("Failed to clean up createAgentSession resources after startup error", {
				error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
			});
		}
		throw error;
	}
}

/**
 * Best-effort preconnect to the model's API host. Bun's `fetch.preconnect`
 * primes DNS + TCP + TLS + H2 so the first real request reuses the warm
 * connection. Errors are swallowed: preconnect is an optimization, never a
 * hard dependency.
 */
function preconnectModelHost(baseUrl: string | undefined): void {
	if (!baseUrl) return;
	const preconnect = (globalThis.fetch as typeof fetch & { preconnect?: (url: string) => void }).preconnect;
	if (typeof preconnect !== "function") return;
	try {
		preconnect(baseUrl);
	} catch {
		// Best effort.
	}
}

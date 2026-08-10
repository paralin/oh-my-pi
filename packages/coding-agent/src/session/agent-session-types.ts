import type { Agent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Context,
	Effort,
	ImageContent,
	Message,
	MessageAttribution,
	Model,
	OAuthAccountSummary,
	ServiceTierByFamily,
	SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import type { postmortem } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig } from "../advisor";
import type { AsyncJob, AsyncJobDeliveryState, AsyncJobManager } from "../async";
import type { ModelRegistry } from "../config/model-registry";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";
import type { CoordinationLifecycle } from "../coordination/backend";
import type { RawSseDebugBuffer } from "../debug/raw-sse-buffer";
import type { TtsrManager } from "../export/ttsr";
import type { LoadedCustomCommand } from "../extensibility/custom-commands";
import type { Extension, ExtensionRunner } from "../extensibility/extensions";
import type { ContextUsage } from "../extensibility/extensions/types";
import type { Skill, SkillWarning } from "../extensibility/skills";
import type { FileSlashCommand } from "../extensibility/slash-commands";
import type { AgentFamilyService } from "../ipython/agent-family";
import type { IpythonAskService } from "../ipython/ask-service";
import type { IpythonAutoQaService } from "../ipython/autoqa-service";
import type { IpythonBrowserService } from "../ipython/browser-service";
import type { IpythonComputerService } from "../ipython/computer-service";
import type { IpythonCronService } from "../ipython/cron-service";
import type { IpythonGithubService } from "../ipython/github-service";
import type { IpythonImageService } from "../ipython/image-service";
import type { PythonSkillPackage } from "../ipython/python-packages";
import type { IpythonSecurityService } from "../ipython/security-service";
import type { IpythonVibeService } from "../ipython/vibe-service";
import type { IpythonWebService } from "../ipython/web-service";
import type { IrcDeliveryReceipt, IrcMessage } from "../irc/bus";
import type { MCPManager } from "../mcp/manager";
import type { TaskAdmissionService } from "../task/admission";
import type { ConfiguredThinkingLevel } from "../thinking";
import type { ActPrivateSession } from "./act-lane";
import type { CodexAutoRedeemCoordinator } from "./codex-auto-reset";
import type { IpythonSessionGenerationFactory } from "./ipython-session";
import type { SessionManager } from "./session-manager";
import type { EffectiveIdleThreshold } from "./session-metadata";

/** Maximum time the interactive shutdown path waits for Mnemopi consolidation. */
export const SHUTDOWN_CONSOLIDATE_BUDGET_MS = 1_500;

/** Options controlling session disposal. */
export interface AgentSessionDisposeOptions {
	mnemopiConsolidateTimeoutMs?: number;
	/**
	 * Postmortem reason that triggered this dispose (signal/fatal teardown
	 * paths). When set, the persisted `session_exit` diagnostic records it
	 * instead of the generic `"dispose"` used for normal programmatic disposal
	 * (`/quit`, test teardown, subagent completion).
	 */
	reason?: postmortem.Reason;
}

/** Listener notified when command metadata changes. */
export type CommandMetadataChangedListener = () => void | Promise<void>;
/** Public summary of an asynchronous job. */
export type AsyncJobSnapshotItem = Pick<AsyncJob, "id" | "type" | "status" | "label" | "startTime">;

/** Snapshot of running, recent, and pending-delivery asynchronous jobs. */
export interface AsyncJobSnapshot {
	running: AsyncJobSnapshotItem[];
	recent: AsyncJobSnapshotItem[];
	delivery: AsyncJobDeliveryState;
}

export type { ShakeMode, ShakeResult } from "./shake-types";

/** Details shown when confirming a usage-reserve-triggered model fallback. */
export interface UsageFallbackConfirmation {
	from: string;
	to: string;
	remainingPercent: number | undefined;
}

/**
 * Confirms whether a reserve-triggered model fallback may proceed.
 *
 * Interactive callers use the confirmation details to present the pending
 * route change; aborting `signal` cancels that pending confirmation.
 */
export type UsageFallbackConfirmer = (confirmation: UsageFallbackConfirmation, signal: AbortSignal) => Promise<boolean>;

/** Identifies a retry fallback chain already entered during startup model resolution. */
export interface InitialRetryFallbackState {
	/** Role whose configured primary was unavailable. */
	role: string;
	/** Configured primary selector retained for restoration when it becomes available. */
	originalSelector: string;
	/** Thinking selector configured for the unavailable primary. */
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	/** Prevent cooldown restoration when startup selected this fallback from live usage health. */
	pinned?: boolean;
}

/** Dependencies and initial state used to construct an AgentSession. */
export type ActPrivateSessionFactory = (options: {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	tool: AgentTool;
	sessionKey: string;
	signal: AbortSignal;
}) => Promise<ActPrivateSession>;

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	/** Awaited custody boundary for session and model identity changes. */
	coordinationLifecycle?: CoordinationLifecycle;
	/** Sends an auto-reply back through the durable backend that delivered its parent message. */
	sendParentIrcReply?: (message: Omit<IrcMessage, "id" | "source" | "ts">) => Promise<IrcDeliveryReceipt>;
	/** Whether the session spawn policy permits the read-only `scout` subagent. Defaults to true. */
	scoutAllowedBySpawnPolicy?: boolean;
	/** Whether the caller explicitly requested yolo/auto-approve behavior for this session. */
	autoApprove?: boolean;
	/** Models to cycle through with Ctrl+P (from --models flag). */
	scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
	/** Initial session thinking selector. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Hard ceiling on the session's thinking effort (e.g. a task spawn's `task.maxEffort`-capped hint); every later change, including retry-fallback recovery, is re-clamped to it. */
	thinkingLevelCeiling?: Effort;
	/** Retry chain ownership when startup selected one of its fallback entries. */
	initialRetryFallback?: InitialRetryFallbackState;
	/** Initial per-family service tiers for the live session. */
	serviceTierByFamily?: ServiceTierByFamily;
	/** Prompt templates for expansion. */
	promptTemplates?: PromptTemplate[];
	/** File-based slash commands for expansion. */
	slashCommands?: FileSlashCommand[];
	/** Extension runner created for this session. */
	extensionRunner?: ExtensionRunner;
	/** Rebuilds file and inline extension definitions into the existing runtime. */
	reloadExtensions?: () => Promise<Extension[]>;
	/** Loaded skills already discovered by the SDK. */
	skills?: Skill[];
	/** Skill loading warnings already captured by the SDK. */
	skillWarnings?: SkillWarning[];
	/** Validated Python skill packages accepted by the managed IPython runtime. */
	pythonPackages?: PythonSkillPackage[];
	/** Whether runtime reloads may rediscover disk-backed skills. */
	skillsReloadable?: boolean;
	/** Custom TypeScript slash commands. */
	customCommands?: LoadedCustomCommand[];
	skillsSettings?: SkillsSettings;
	/** Agent directory used when changing memory backends in a live session. */
	memoryAgentDir?: string;
	/** Recursion depth used to suppress live backend replacement in subagents. */
	memoryTaskDepth?: number;
	/** Binds structured questions to this session's interactive UI. */
	createIpythonAskService?: () => IpythonAskService;
	/** Binds typed Auto-QA reports to the host-owned consent and storage owner. */
	createIpythonAutoQaService?: () => IpythonAutoQaService;
	/** Binds typed Vibe worker operations to the task-backed session registry. */
	createIpythonVibeService?: () => IpythonVibeService;
	/** Binds web search and fetch owners to this session's tool context. */
	createIpythonWebService?: () => IpythonWebService;
	/** Binds scheduled prompts to this session's CronManager. */
	createIpythonCronService?: () => IpythonCronService;
	/** Binds GitHub command and cache owners to this session's tool context. */
	createIpythonGithubService?: () => IpythonGithubService;
	/** Binds image providers and attachment metadata to this session. */
	createIpythonImageService?: () => IpythonImageService;
	/** Binds native security coordination and public provenance to this session. */
	createIpythonSecurityService?: () => IpythonSecurityService;
	/** Binds browser supervisor and tab registry to this session. */
	createIpythonBrowserService?: () => IpythonBrowserService;
	/** Binds computer supervisor and desktop session to this session. */
	createIpythonComputerService?: () => IpythonComputerService;
	/** Model registry for API key resolution and model discovery. */
	modelRegistry: ModelRegistry;
	/** The sole provider-facing IPython tool for this session. */
	ipythonTool?: AgentTool;
	/** Refreshes session-bound services after a logical session transition. */
	onSessionTransition?: () => void;
	/** Suspends session-bound services before a fork changes the live session path. */
	beginSessionFork?: () => Promise<void>;
	/** Copies backend artifacts and resumes services after a fork, or only resumes when the fork failed. */
	completeSessionFork?: (
		result: { oldSessionFile: string; newSessionFile: string } | undefined,
		isCurrent?: () => boolean,
	) => Promise<void>;
	/** Current session pre-LLM message transform pipeline. */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Provider request transform applied after message conversion. */
	transformProviderContext?: (context: Context, model: Model) => Context | Promise<Context>;
	/** Stream wrapper for side-channel requests. */
	sideStreamFn?: StreamFn;
	/** Stream wrapper for advisor requests. */
	advisorStreamFn?: StreamFn;
	/** Advisor spend already recorded for the session being opened, restored on resume. */
	initialAdvisorCosts?: ReadonlyMap<string, number>;
	/** Prefer websocket transport for OpenAI Codex requests when supported. */
	preferWebsockets?: boolean;
	/** Codex saved-reset coordinator; defaults to the process-wide singleton so concurrent sessions can't double-spend. Inject a fresh one in tests. */
	codexResetCoordinator?: CodexAutoRedeemCoordinator;
	/** Provider payload hook used by the active session request path. */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** Provider response hook used by the active session request path. */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** Raw SSE hook used by the active session request path. */
	onSseEvent?: SimpleStreamOptions["onSseEvent"];
	/** Per-session raw SSE diagnostic buffer. */
	rawSseDebugBuffer?: RawSseDebugBuffer;
	/** Current session message-to-LLM conversion pipeline. */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Builds the fixed IPython provider prompt. */
	rebuildSystemPrompt?: () => Promise<{ systemPrompt: string[] }>;
	/** Local calendar date provider used by prompt-cache invalidation. */
	getLocalCalendarDate?: () => string;
	/** Host-owned MCP transport, credential, resource, prompt, and tool service. */
	mcpManager?: MCPManager;
	/** Time-traveling stream-rule manager. */
	ttsrManager?: TtsrManager;
	/** Test and embedding seam for the session-owned IPython process generation. */
	createIpythonSessionGeneration?: IpythonSessionGenerationFactory;
	/** Existing Task lifecycle owner exposed to the Python RLM admission bridge. */
	taskAdmissionService?: TaskAdmissionService;
	/** Test-only override for constructing the retained private Act actor. */
	createActPrivateSession?: ActPrivateSessionFactory;
	/** Existing registry, IRC, transcript, and observer services exposed to focused Python skills. */
	agentFamilyService?: AgentFamilyService;
	/** Async job manager owned and disposed by this session. */
	ownedAsyncJobManager?: AsyncJobManager;
	/** Async job manager visible to this session. */
	asyncJobManager?: AsyncJobManager;
	/** Registry identity used for IRC routing. */
	agentId?: string;
	/** Whether this is a top-level or subagent session. */
	agentKind?: "main" | "sub";
	/** Current session scratch handoff file, if scratch handoff is enabled. */
	scratchHandoffDisplayPath?: string;
	/** Base directory for relative scratch handoff paths inherited by child sessions. */
	scratchHandoffRootCwd?: string;
	/** Parent scratch handoff file linked from this session's scratch file. */
	parentScratchHandoffDisplayPath?: string;
	/** Provider-facing session ID override. */
	providerSessionId?: string;
	/** Whether the provider prompt-cache key was explicit or fork-inherited. */
	providerPromptCacheKeySource?: "explicit" | "fork";
	/** Preloaded watchdog prompt content for the advisor. */
	advisorWatchdogPrompt?: string;
	/** Shared advisor instructions loaded from WATCHDOG.yml. */
	advisorSharedInstructions?: string;
	/** Project context rendered for advisor sessions. */
	advisorContextPrompt?: string;
	/** Advisors discovered from WATCHDOG.yml. */
	advisorConfigs?: AdvisorConfig[];
	/** Disconnect the MCP manager owned by this session during disposal. */
	disconnectOwnedMcpManager?: () => Promise<void>;
	/** System prompt used by automatic session-title generation. */
	titleSystemPrompt?: string;
}

/** Options for AgentSession.prompt(). */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Image attachments. */
	images?: ImageContent[];
	/** Queue behavior while streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Send as a developer/system message instead of user. */
	synthetic?: boolean;
	/** Whether this prompt is a deliberate user action. */
	userInitiated?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
	/** Skip pre-send compaction checks for this prompt. */
	skipCompactionCheck?: boolean;
}

/** Options for AgentSession.followUp(). */
export interface FollowUpOptions {
	/** Enqueue as a hidden developer message instead of a user follow-up. */
	synthetic?: boolean;
	/** Whether to expand file-based prompt templates (default: true). */
	expandPromptTemplates?: boolean;
	/** Explicit billing/initiator attribution. */
	attribution?: MessageAttribution;
}

/** Result from a handoff operation. */
export interface HandoffResult {
	document: string;
	savedPath?: string;
}

/** Options controlling handoff generation. */
export interface SessionHandoffOptions {
	autoTriggered?: boolean;
	signal?: AbortSignal;
	onSwitchCancelled?: () => void;
	metadataCompactionStrategy?: SettingValue<"compaction.strategy">;
	/** Idle threshold policy to report when the idle timer triggered this handoff. */
	metadataIdleThreshold?: EffectiveIdleThreshold;
}

/** Result from cycleModel(). */
export interface ModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	/** Whether cycling through scoped models or all available models. */
	isScoped: boolean;
}

/** Result from cycleRoleModels(). */
export interface RoleModelCycleResult {
	model: Model;
	thinkingLevel: ThinkingLevel | undefined;
	role: string;
}

/** A configured role resolved to a concrete model. */
export interface ResolvedRoleModel {
	role: string;
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
	explicitThinkingLevel: boolean;
}

/** Resolvable role models and the currently active index. */
export interface RoleModelCycle {
	models: ResolvedRoleModel[];
	currentIndex: number;
}

/** Token breakdown for the current provider context. */
export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for the `/session` command. */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

/** Stored OAuth accounts available to the current model provider. */
export interface SessionOAuthAccountList {
	provider: string;
	accounts: OAuthAccountSummary[];
}

/** IDs for a newly created session and the session it replaced. */
export interface FreshSessionResult {
	previousSessionId: string;
	sessionId: string;
	closedProviderSessions: number;
}

/** Outcome of an in-place `/clear` conversation-context reset. */
export interface ResetSessionContextResult {
	/** Number of live messages dropped from the model's context. */
	droppedCount: number;
}

/** Queued user content restored to the editor. */
export type RestoredQueuedMessage = { text: string; images?: ImageContent[] };

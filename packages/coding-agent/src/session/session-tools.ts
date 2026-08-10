import type { Agent, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { reset as resetCapabilities } from "../capability";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings, SkillsSettings } from "../config/settings";
import type { ExtensionRunner } from "../extensibility/extensions";
import { loadSkills, type Skill, type SkillWarning, setActiveSkills } from "../extensibility/skills";
import type { LocalProtocolOptions } from "../internal-urls";
import { resolveMemoryBackend } from "../memory-backend/resolve";
import type { MemoryBackendStartOptions } from "../memory-backend/types";
import { ToolError } from "../tools/tool-errors";
import { IPYTHON_PERMISSION_CACHE_KEY, requestClientBridgePermission } from "./acp-permission-gate";
import type { ClientBridge } from "./client-bridge";
import type { SessionManager } from "./session-manager";

/** Capabilities borrowed from the owning AgentSession. */
export interface SessionToolsHost {
	agent: Agent;
	sessionManager: SessionManager;
	settings: Settings;
	modelRegistry: ModelRegistry;
	extensionRunner(): ExtensionRunner | undefined;
	clientBridge(): ClientBridge | undefined;
	agentKind(): "main" | "sub";
	isDisposed(): boolean;
	isStreaming(): boolean;
	queuedMessageCount(): number;
	model(): Model | undefined;
	memoryBackendSession(): MemoryBackendStartOptions["session"];
	clearInheritedProviderPromptCacheKey(): void;
	clearMemoryPromotionSnapshot(): void;
	captureMemoryPromotionSnapshot(prompt: string[]): void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	notifyCommandMetadataChanged(): void;
	localProtocolOptions(): LocalProtocolOptions;
	refreshPythonPackages?: (skills: readonly Skill[]) => Promise<readonly SkillWarning[]>;
}
interface SessionToolsOptions {
	autoApprove?: boolean;
	ipythonTool: AgentTool;
	rebuildSystemPrompt?: () => Promise<{ systemPrompt: string[] }>;
	baseSystemPrompt: string[];
	skills?: Skill[];
	skillWarnings?: SkillWarning[];
	skillsSettings?: SkillsSettings;
	skillsReloadable?: boolean;
}

/** Owns the fixed IPython tool, prompt rebuilding, skills, and permissions. */
export class SessionTools {
	readonly #host: SessionToolsHost;
	#autoApprove: boolean;
	#ipythonTool: AgentTool;
	#baseSystemPrompt: string[];
	#rebuildSystemPrompt: SessionToolsOptions["rebuildSystemPrompt"];
	#skills: Skill[];
	#skillWarnings: SkillWarning[];
	#skillsSettings: SkillsSettings | undefined;
	#skillsReloadable: boolean;
	#acpPermissionDecisions = new Map<string, "allow_always" | "reject_always">();

	constructor(host: SessionToolsHost, options: SessionToolsOptions) {
		this.#host = host;
		this.#autoApprove = options.autoApprove === true;
		this.#ipythonTool = options.ipythonTool;
		this.#rebuildSystemPrompt = options.rebuildSystemPrompt;
		this.#baseSystemPrompt = options.baseSystemPrompt;
		this.#skills = options.skills ?? [];
		this.#skillWarnings = options.skillWarnings ?? [];
		this.#skillsSettings = options.skillsSettings;
		this.#skillsReloadable = options.skillsReloadable ?? true;
	}

	/** Current stable base system prompt. */
	get baseSystemPrompt(): string[] {
		return this.#baseSystemPrompt;
	}

	/** Replaces the controller-owned base prompt without applying it to the agent. */
	setBaseSystemPrompt(prompt: string[]): void {
		this.#baseSystemPrompt = prompt;
	}

	/** Skills currently rendered into the system prompt. */
	get skills(): Skill[] {
		return this.#skills;
	}

	/** Diagnostics produced while loading the current skills. */
	get skillWarnings(): SkillWarning[] {
		return this.#skillWarnings;
	}

	/** Settings snapshot used for the current skill discovery. */
	get skillsSettings(): SkillsSettings | undefined {
		return this.#skillsSettings;
	}

	/** Drops cached per-session ACP `allow_always`/`reject_always` decisions. */
	clearAcpPermissionDecisions(): void {
		// Replace the map so an in-flight request from the previous session or
		// client can only update its captured, retired decision cache.
		this.#acpPermissionDecisions = new Map();
	}

	/** Drops cached ACP decisions and restores the sole provider tool after the client changes. */
	refreshAcpPermissionGates(): void {
		this.clearAcpPermissionDecisions();
		this.#host.agent.setTools([this.#ipythonTool]);
	}

	/**
	 * Request one ACP exec-level permission for a synthetic ipython cell run
	 * before the cell reaches kernel admission. The whole cell is a single
	 * `execute` request; OMP never adds per-Python-operation checks. Reuses the
	 * tool permission decision cache so allow-always / reject-always for ipython
	 * persists across cells until the client changes. Returns false when an
	 * explicit yolo or auto-approve mode already authorizes the cell. Throws when
	 * the client rejects, cancels, or has no ACP permission channel.
	 */
	async requestIpythonPermission(
		code: string,
		signal: AbortSignal | undefined,
		decisionId: string,
		approvalRequired: boolean,
	): Promise<boolean> {
		if (!approvalRequired && this.#isExplicitAutoApproveMode()) return false;
		const bridge = this.#host.clientBridge();
		if (!bridge?.capabilities.requestPermission || !bridge.requestPermission) {
			throw new ToolError("IPython cell requires approval but no ACP permission channel is available.");
		}
		await requestClientBridgePermission(
			{
				bridge,
				toolCall: {
					toolCallId: decisionId,
					toolName: "ipython",
					title: "Execute IPython cell",
					kind: "execute",
				},
				rawInput: { code },
				content: [{ type: "content", content: { type: "text", text: code } }],
				locations: [],
				signal,
				toolName: "ipython",
			},
			this.#acpPermissionDecisions,
			IPYTHON_PERMISSION_CACHE_KEY,
		);
		return true;
	}

	#isExplicitAutoApproveMode(): boolean {
		return (
			this.#autoApprove ||
			(this.#host.settings.isConfigured("tools.approvalMode") &&
				this.#host.settings.get("tools.approvalMode") === "yolo")
		);
	}

	/** Rediscovers reloadable skills and refreshes prompt metadata. */
	async refreshSkills(): Promise<void> {
		resetCapabilities();
		if (this.#skillsReloadable) {
			const skillsSettings = this.#host.settings.getGroup("skills");
			const discovered = await loadSkills({
				...skillsSettings,
				cwd: this.#host.sessionManager.getCwd(),
				disabledExtensions: this.#host.settings.get("disabledExtensions") ?? [],
			});
			const pythonWarnings = this.#host.refreshPythonPackages
				? await this.#host.refreshPythonPackages(discovered.skills)
				: [];
			this.#skills = discovered.skills;
			this.#skillWarnings = [...discovered.warnings, ...pythonWarnings];
			this.#skillsSettings = skillsSettings;

			if (this.#host.agentKind() === "main") {
				setActiveSkills(this.#skills);
			}
		}
		await this.refreshBaseSystemPrompt();
		this.#host.notifyCommandMetadataChanged();
	}

	/** Rebuilds the stable prompt for the fixed IPython provider. */
	async refreshBaseSystemPrompt(): Promise<void> {
		if (this.#host.isDisposed() || !this.#rebuildSystemPrompt) return;
		const built = await this.#rebuildSystemPrompt();
		if (this.#host.isDisposed()) return;
		const previousBaseSystemPrompt = this.#baseSystemPrompt;
		this.#baseSystemPrompt = built.systemPrompt;
		this.#host.clearMemoryPromotionSnapshot();
		if (
			previousBaseSystemPrompt.length !== this.#baseSystemPrompt.length ||
			previousBaseSystemPrompt.some((part, index) => part !== this.#baseSystemPrompt[index])
		) {
			this.#host.clearInheritedProviderPromptCacheKey();
		}
		this.#host.agent.setSystemPrompt(this.#baseSystemPrompt);
	}

	/** Applies one-turn memory prompt injection before an agent run. */
	async buildSystemPromptForAgentStart(promptText: string): Promise<string[]> {
		const backend = await resolveMemoryBackend(this.#host.settings);
		if (!backend.beforeAgentStartPrompt) return this.#baseSystemPrompt;

		try {
			const injected = await backend.beforeAgentStartPrompt(this.#host.memoryBackendSession(), promptText);
			if (!injected) return this.#baseSystemPrompt;

			const previousBaseSystemPrompt = this.#baseSystemPrompt;
			try {
				await this.refreshBaseSystemPrompt();
			} catch (refreshErr) {
				logger.debug("Memory backend prompt refresh after beforeAgentStartPrompt failed", {
					backend: backend.id,
					error: String(refreshErr),
				});
			}

			if (
				this.#baseSystemPrompt.length !== previousBaseSystemPrompt.length ||
				this.#baseSystemPrompt.some((part, index) => part !== previousBaseSystemPrompt[index])
			) {
				return this.#baseSystemPrompt;
			}

			this.#host.captureMemoryPromotionSnapshot(previousBaseSystemPrompt);
			const stablePrompt = [...previousBaseSystemPrompt, injected];
			this.#baseSystemPrompt = stablePrompt;
			this.#host.agent.setSystemPrompt(stablePrompt);
			return stablePrompt;
		} catch (err) {
			logger.debug("Memory backend beforeAgentStartPrompt failed", {
				backend: backend.id,
				error: String(err),
			});
			return this.#baseSystemPrompt;
		}
	}
}

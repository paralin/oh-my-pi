import * as fs from "node:fs/promises";

import { AsyncJobManager } from "../async";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelRoleAlias } from "../config/model-roles";
import type { Settings } from "../config/settings";
import { MCPManager } from "../mcp/manager";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { sessionSidecarDir } from "../session/session-paths";
import type { EventBus } from "../utils/event-bus";
import { createClaudeCodePeerReviver } from "./claude-code-runtime";
import type { StartClaudeCodeQuery } from "./claude-code-sdk";
import { attachIrcWakeTurnMonitor, createSubagentSettings } from "./executor";
import type { AgentDefinition } from "./types";

/**
 * Ambient context the reviver needs at revive time. The top-level session is
 * kept LIVE (cwd / artifact manager read on demand) so a later `/new` or cwd
 * move is followed rather than snapshotted; auth/models/settings are
 * process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
	/**
	 * Shared event bus feeding RPC/collab subagent subscriptions. Passed through
	 * to the wake-turn monitor so an IRC send to a cold-revived subagent emits
	 * the same lifecycle/progress frames a live run does.
	 */
	eventBus?: EventBus;
	/** Injection seam for deterministic Claude Code revival tests. */
	startClaudeCodeQuery?: StartClaudeCodeQuery;
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (Agent Hub scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP manager inheritance, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// Files without a persisted contract remain transcript-only.
		if (!peek?.init) return undefined;
		const init = peek.init;
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		if (init.runtime?.kind === "claude-code") {
			const spawns: AgentDefinition["spawns"] =
				init.spawns === "*"
					? "*"
					: (init.spawns
							?.split(",")
							.map(name => name.trim())
							.filter(Boolean) ?? []);
			const wakeAgent: AgentDefinition = {
				name: ref.displayName,
				description: "",
				systemPrompt: init.systemPrompt,
				tools: init.tools,
				spawns,
				source: "user",
			};
			return createClaudeCodePeerReviver({
				options: {
					cwd: init.runtime.cwd,
					agent: wakeAgent,
					task: init.task,
					assignment: init.task,
					index: 0,
					id: ref.id,
					parentAgentId: ref.parentId ?? undefined,
					taskDepth,
					modelOverride: `claude-code/${init.runtime.model}${init.runtime.effort ? `:${init.runtime.effort}` : ""}`,
					outputSchema: init.outputSchema,
					outputSchemaMode: init.outputSchemaMode,
					restrictToolNames: init.restrictToolNames,
					enableIrc: true,
					enableLsp: ctx.enableLsp,
					enableMCP: true,
					sessionFile,
					persistArtifacts: true,
					artifactsDir: sessionFile.slice(0, -6),
					eventBus: ctx.eventBus,
					authStorage: ctx.authStorage,
					modelRegistry: ctx.modelRegistry,
					settings: ctx.settings,
					asyncJobManager: AsyncJobManager.instance(),
					mcpManager: MCPManager.instance(),
					parentArtifactManager: ctx.session.sessionManager.getArtifactManager() ?? undefined,
					keepAlive: true,
				},
				nativeSession: init.runtime,
				appendSystemPrompt: init.systemPrompt,
				effort: init.runtime.effort,
				startQuery: ctx.startClaudeCodeQuery,
			});
		}
		// Native Pi sessions still revive from the OMP JSONL writer.
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		const subagentSettings = createSubagentSettings(ctx.settings);
		const persistedModelPattern =
			init.modelRole && init.modelRole !== "default"
				? [formatModelRoleAlias(init.modelRole), ...(init.resolvedModel ? [init.resolvedModel] : [])]
				: init.resolvedModel;
		return async expectedRef => {
			// Re-open fresh on every revive: park closes the writer, so this takes
			// the single-writer lock cleanly and restores the full message history.
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				suppressBreadcrumb: true,
			});
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);
			const mcpManager = MCPManager.instance();
			const { session } = await createAgentSession({
				cwd: ctx.session.sessionManager.getCwd(),
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				...(persistedModelPattern ? { modelPattern: persistedModelPattern } : {}),
				modelPatternAuthFallback: init.resolvedModel,
				settings: subagentSettings,
				sessionManager: reopened,
				agentId: ref.id,
				agentDisplayName: ref.displayName,
				parentTaskPrefix: ref.id,
				parentAgentId: ref.parentId,
				expectedAgentRef: expectedRef,
				taskDepth,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				systemPrompt: () => [init.systemPrompt],
				// Old files predate persisted spawns: deny re-spawning rather than let
				// createAgentSession default to wildcard ("*").
				spawns: init.spawns ?? "",
				hasUI: false,
				enableLsp: ctx.enableLsp,
				enableMCP: !mcpManager,
				mcpManager,
			});

			// Cold revives must drive registry status themselves — createAgentSession
			// doesn't wire this generically (the live path does it in the executor).
			// Without it the idle-TTL timer never clears on a turn and the lifecycle
			// could park the agent mid-run.
			session.subscribe(event => {
				if (event.type === "agent_start") registry.setStatus(ref.id, "running", session);
				else if (event.type === "agent_end") registry.setStatus(ref.id, "idle", session);
			});
			// Persisted files predate an agent-source field, so cold-revived frames
			// report the runtime-neutral `user` source; name comes from the ref.
			const wakeAgent: AgentDefinition = {
				name: ref.displayName,
				description: "",
				systemPrompt: init.systemPrompt,
				source: "user",
			};
			attachIrcWakeTurnMonitor(session, {
				id: ref.id,
				agent: wakeAgent,
				eventBus: ctx.eventBus,
				sessionFile,
				outputSchema: init.outputSchema,
				outputSchemaMode: init.outputSchemaMode,
				artifactsDir: ctx.session.sessionFile ? sessionSidecarDir(ctx.session.sessionFile) : undefined,
			});
			return session;
		};
	};
}

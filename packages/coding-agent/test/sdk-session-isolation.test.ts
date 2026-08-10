import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { getSessionsDir, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function createTtsrRule(name: string): Rule {
	return {
		name,
		path: `/tmp/${name}.md`,
		content: "Avoid forbidden output",
		condition: ["forbidden"],
		scope: ["text"],
		_source: {
			provider: "test",
			providerName: "test",
			path: `/tmp/${name}.md`,
			level: "project",
		},
	};
}

describe("createAgentSession session storage isolation", () => {
	const tempDirs: string[] = [];
	// One shared, fully-populated (bundled models load synchronously in the
	// constructor) registry for every case. Passing it via options skips the
	// per-call discoverAuthStorage() SQLite open and the refreshInBackground()
	// network model probe inside createAgentSession — the two real wall-clock
	// sinks here. None of these cases assert on model discovery, so an
	// ambient-credential-free in-memory auth store keeps them deterministic.
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		LocalProtocolHandler.resetOverrideForTests();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("uses the provided agentDir for the default persistent session root", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-session-isolation-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const sessionFile = session.sessionFile;
			if (!sessionFile) {
				throw new Error("Expected session file path");
			}

			expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
			expect(sessionFile.startsWith(getSessionsDir())).toBe(false);
		} finally {
			await session.dispose();
		}
	});
	it("keeps subagent local:// mappings from replacing the process-global override", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-local-override-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const globalOptions = {
			getArtifactsDir: () => path.join(tempDir, "active-artifacts"),
			getSessionId: () => "active-session",
		};
		const subagentOptions = {
			getArtifactsDir: () => path.join(tempDir, "parent-artifacts"),
			getSessionId: () => "parent-session",
		};
		LocalProtocolHandler.setOverride(globalOptions);

		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			agentRegistry: new AgentRegistry(),
			agentId: "Tan-local-override-test",
			agentDisplayName: "tan",
			parentTaskPrefix: "Tan-local-override-test",
			parentAgentId: "Main",
			localProtocolOptions: subagentOptions,
		});

		try {
			expect(LocalProtocolHandler.resolveOptions()).toBe(globalOptions);
		} finally {
			await session.dispose();
		}
	});

	it("does not replace a newer registry generation when creation expected the id to be absent", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-cas-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const registry = new AgentRegistry();
		const replacement = registry.register({
			id: "shared-worker",
			displayName: "replacement B",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});

		await expect(
			createAgentSession({
				cwd,
				agentDir: path.join(tempDir, "agent"),
				modelRegistry: sharedModelRegistry,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				agentRegistry: registry,
				agentId: "shared-worker",
				agentDisplayName: "late A",
				parentTaskPrefix: "shared-worker",
				parentAgentId: "Main",
				taskDepth: 1,
				expectedAgentRef: null,
			}),
		).rejects.toThrow("already owned by another session generation");
		expect(registry.get("shared-worker")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: null });
	});

	it("reuses the exact parked ref authorized for revival", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-generation-revive-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, tempDir);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected persisted worker session file");
		const registry = new AgentRegistry();
		const parked = registry.register({
			id: "revived-worker",
			displayName: "revived worker",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});

		const { session } = await createAgentSession({
			cwd,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			sessionManager,
			agentRegistry: registry,
			agentId: "revived-worker",
			agentDisplayName: "revived worker",
			parentTaskPrefix: "revived-worker",
			parentAgentId: "Main",
			taskDepth: 1,
			expectedAgentRef: parked,
		});
		try {
			expect(registry.get("revived-worker")).toBe(parked);
			expect(parked).toMatchObject({ status: "running", session, sessionFile });
		} finally {
			await session.dispose();
		}
		expect(registry.get("revived-worker")).toBeUndefined();
	});

	it("suspends the exact Vibe owner scope before global lifecycle teardown", async () => {
		VibeSessionRegistry.resetGlobalForTests();
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-vibe-dispose-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		const vibeRegistry = VibeSessionRegistry.global();
		const suspend = vi.spyOn(vibeRegistry, "suspendScope");
		const lifecycleDispose = vi.spyOn(AgentLifecycleManager.global(), "dispose");
		const parentSessionId = session.sessionManager.getSessionId();
		const parentSessionFile = session.sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected persisted parent session file");

		await session.dispose();

		expect(suspend).toHaveBeenCalledWith(
			{ ownerId: "Main", parentSessionId, parentSessionFile },
			session.asyncJobManager,
		);
		expect(suspend.mock.invocationCallOrder[0]).toBeLessThan(lifecycleDispose.mock.invocationCallOrder[0]);
	});

	it("wires the discovered TTSR manager into the created session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-ttsr-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		const agentDir = path.join(tempDir, "agent");
		const rule = createTtsrRule("sdk-ttsr-rule");
		fs.mkdirSync(cwd, { recursive: true });

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			rules: [rule],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(session.ttsrManager).toBeDefined();
			expect(session.ttsrManager?.checkDelta("forbidden", { source: "text" }).map(match => match.name)).toEqual([
				rule.name,
			]);
		} finally {
			await session.dispose();
		}
	});
});

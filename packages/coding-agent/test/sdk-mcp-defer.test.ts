import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Interactive sessions defer MCP discovery off the first-paint path. Discovery
// timing never changes the exclusive provider roster: configured servers remain
// available through the typed MCP service after they connect.
describe("createAgentSession MCP deferral (B1)", () => {
	let registryDir: string;
	let tempDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	const PENDING_MCP_TOOL = "mcp__pending_connectingtool";

	const baseOptions = () => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({}),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		// No .mcp.json in tempDir, so no real MCP server can ever back this name.
		enableMCP: true,
	});

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-defer-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		if (registryDir && fs.existsSync(registryDir)) {
			removeSyncWithRetries(registryDir);
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-defer-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not reserve a provider schema while UI mode defers MCP discovery", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: true });
		try {
			// Discovery may be deferred, but it never mutates the provider roster.
			expect(session.agent.state.tools.map(tool => tool.name)).not.toContain(PENDING_MCP_TOOL);
			expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["ipython"]);
		} finally {
			await session.dispose();
		}
	});

	it("does not fabricate the MCP tool in non-UI mode (no deferral, no backing server)", async () => {
		const { session } = await createAgentSession({ ...baseOptions(), hasUI: false });
		try {
			// Without deferral there is no placeholder; the name has no real
			// server backing, so it is simply not a registered tool.
			expect(session.agent.state.tools.map(tool => tool.name)).not.toContain(PENDING_MCP_TOOL);
			// A normal builtin is unaffected.
			expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["ipython"]);
		} finally {
			await session.dispose();
		}
	});
});

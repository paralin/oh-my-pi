import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("IPython provider roster", () => {
	let root: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		root = path.join(os.tmpdir(), `omp-ipython-provider-roster-${Snowflake.next()}`);
		fs.mkdirSync(root, { recursive: true });
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		removeSyncWithRetries(root);
	});

	test("registers one fixed exclusive IPython tool", async () => {
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"autolearn.enabled": false,
				"goal.enabled": false,
				"memory.backend": "disabled",
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableLsp: false,
			enableMCP: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		sessions.push(session);

		expect(session.agent.state.tools.map(tool => tool.name)).toEqual(["ipython"]);
		expect(session.agent.state.tools[0]?.concurrency).toBe("exclusive");

		expect(session.systemPrompt.join("\n")).toContain("The only provider tool is exclusive `ipython`.");
	});
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type Message } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { exportSessionToHtml } from "@oh-my-pi/pi-coding-agent/export/html";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { hasLegacyProviderToolCalls, LEGACY_SESSION_ERROR } from "@oh-my-pi/pi-coding-agent/session/legacy-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function legacyMessages(): Message[] {
	return [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Earlier work" },
				{ type: "toolCall", id: "legacy-call", name: "read", arguments: { path: "<old>&file" } },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage,
			stopReason: "toolUse",
			timestamp: 100,
		},
		{
			role: "toolResult",
			toolCallId: "legacy-call",
			toolName: "read",
			content: [{ type: "text", text: "<script>unsafe</script>\nold result" }],
			isError: false,
			timestamp: 101,
		},
	];
}

describe("legacy provider sessions", () => {
	let root: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		root = path.join(os.tmpdir(), `omp-legacy-session-${Snowflake.next()}`);
		fs.mkdirSync(root, { recursive: true });
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		removeSyncWithRetries(root);
	});

	test("classifies only non-IPython provider history", () => {
		expect(hasLegacyProviderToolCalls(legacyMessages())).toBe(true);
		expect(
			hasLegacyProviderToolCalls([
				{
					role: "toolResult",
					toolCallId: "ipython-call",
					toolName: "ipython",
					content: [{ type: "text", text: "42" }],
					isError: false,
					timestamp: 1,
				},
			]),
		).toBe(false);
	});

	test("opens and exports legacy history but blocks every provider turn without mutation", async () => {
		const sessionDir = path.join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir);
		for (const message of legacyMessages()) manager.appendMessage(message);
		const originalPath = manager.getSessionFile();
		expect(originalPath).toBeTruthy();

		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRegistry,
			sessionManager: manager,
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
		let providerCalls = 0;
		session.agent.streamFn = (() => {
			providerCalls++;
			throw new Error("provider must not run");
		}) as typeof session.agent.streamFn;

		const messagesBefore = JSON.stringify(session.agent.state.messages);
		const entriesBefore = manager.getEntries().length;
		await expect(session.prompt("continue old work")).rejects.toThrow(LEGACY_SESSION_ERROR);
		expect(JSON.stringify(session.agent.state.messages)).toBe(messagesBefore);
		expect(manager.getEntries()).toHaveLength(entriesBefore);
		await session.agent.continue();
		expect(JSON.stringify(session.agent.state.messages)).toBe(messagesBefore);
		expect(manager.getEntries()).toHaveLength(entriesBefore);
		expect(providerCalls).toBe(0);

		const plain = session.formatSessionAsText();
		expect(plain).toContain("read");
		expect(plain).toContain("old result");
		const htmlPath = path.join(root, "legacy.html");
		await exportSessionToHtml(manager, session.agent.state, { outputPath: htmlPath, includeSubSessions: false });
		const html = fs.readFileSync(htmlPath, "utf8");
		expect(html).toContain("Removed tool:");
		expect(html).not.toContain("<omp-tool-view");
		expect(html).not.toContain("<script>unsafe</script>");

		const movedCwd = path.join(root, "moved-project");
		const movedDir = path.join(root, "moved-sessions");
		fs.mkdirSync(movedCwd, { recursive: true });
		await manager.moveTo(movedCwd, movedDir);
		const movedPath = manager.getSessionFile();
		expect(movedPath).toBeTruthy();
		expect(fs.existsSync(movedPath!)).toBe(true);
		expect(fs.existsSync(originalPath!)).toBe(false);
		await manager.dropSession(movedPath!);
		expect(fs.existsSync(movedPath!)).toBe(false);
	});
});

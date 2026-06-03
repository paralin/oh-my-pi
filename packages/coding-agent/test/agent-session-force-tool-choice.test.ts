import { afterEach, beforeEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";

let tempDir: TempDir;
let authStorage: AuthStorage | undefined;
let session: AgentSession;

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-agent-session-force-tool-");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

	authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({ "compaction.enabled": false });
	const sessionManager = SessionManager.inMemory(tempDir.path());

	const bashTool: AgentTool = {
		name: "bash",
		label: "Bash",
		description: "Mock bash tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
	const writeTool: AgentTool = {
		name: "write",
		label: "Write",
		description: "Mock write tool",
		parameters: z.object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [bashTool, writeTool],
			messages: [],
		},
		convertToLlm,
		streamFn: () => new AssistantMessageEventStream(),
	});

	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry,
		toolRegistry: new Map([
			[bashTool.name, bashTool],
			[writeTool.name, writeTool],
		]),
	});
});

afterEach(async () => {
	await session.dispose();
	authStorage?.close();
	authStorage = undefined;
	tempDir.removeSync();
});

it("forces specific tool, then transitions to none, then clears", () => {
	session.setForcedToolChoice("write");

	const first = session.nextToolChoice();
	const second = session.nextToolChoice();
	const third = session.nextToolChoice();

	expect(first).toEqual({ type: "tool", name: "write" });
	// After the forced call, "none" prevents the loop from making more tool calls
	expect(second).toBe("none");
	// After "none" is consumed, override clears entirely
	expect(third).toBeUndefined();
});

it("throws when forcing a non-active tool", () => {
	expect(() => session.setForcedToolChoice("read")).toThrow('Tool "read" is not currently active.');
});

it("rejects (and lets the directive requeue) a queued named choice whose tool is filtered out of active state.tools", () => {
	// Regression for #1707 review: queue lifecycle must NOT advance a forced choice
	// the model never saw. AgentSession's `/force` pushes a [forced, "none"] sequence
	// with `onRejected: () => "requeue"`. If the forced tool is filtered out of
	// `agent.state.tools` mid-flight (MCP-scoped / subagent / restricted-toolset
	// turn), `nextToolChoice` must reject the head yield so the directive replays —
	// not return it (would cause a self-inconsistent wire body, #1701) and not
	// silently resolve it on turn_end (would discard the directive).
	session.setForcedToolChoice("write");
	// Filter `write` out of the active per-turn tool set BEFORE nextToolChoice runs.
	session.agent.setTools(session.agent.state.tools.filter(tool => tool.name !== "write"));

	const first = session.nextToolChoice();
	expect(first).toBeUndefined();
	expect(session.toolChoiceQueue.hasInFlight).toBe(false);

	// Restore `write` to the active set — the directive's onRejected: "requeue" must
	// have replayed the lost yield, so the next call serves the forced choice.
	session.agent.setTools([
		...session.agent.state.tools,
		{
			name: "write",
			label: "Write",
			description: "Mock write tool",
			parameters: z.object({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		},
	]);
	const second = session.nextToolChoice();
	expect(second).toEqual({ type: "tool", name: "write" });
});

it("drops a queued named choice whose directive policy is 'drop' when its tool is filtered out", () => {
	// Eager-todo pushes with default reject policy (drop). When `todo_write` is
	// filtered out of active tools by the time nextToolChoice runs, the directive
	// must be discarded — no requeue, no resolve — and the queue must drain so
	// subsequent turns do not see a stale in-flight entry.
	session.toolChoiceQueue.pushOnce({ type: "tool", name: "todo_write" }, { label: "eager-todo" });
	expect(session.nextToolChoice()).toBeUndefined();
	expect(session.toolChoiceQueue.hasInFlight).toBe(false);
	expect(session.nextToolChoice()).toBeUndefined();
});

it("passes through string-mode tool choices unchanged regardless of active tools", () => {
	// "none" / "auto" / "any" / "required" are not named, so the active-tool gate
	// must not touch them. Otherwise a `/btw`-style `"none"` directive would be
	// silently dropped whenever the per-turn tool set is filtered.
	session.toolChoiceQueue.pushOnce("none", { label: "btw" });
	expect(session.nextToolChoice()).toBe("none");
});

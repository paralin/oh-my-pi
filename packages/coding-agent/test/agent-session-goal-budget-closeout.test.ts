import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

// A budget-limited goal whose token budget (1000) is far below the tool turn's
// usage (50_000), so accounting flips it to budget-limited after the first tool
// completes and queues the goal-budget-limit steer.
function budgetGoalState(): GoalModeState {
	const now = Date.now();
	return {
		enabled: true,
		mode: "active",
		goal: {
			id: "goal-budget-closeout",
			objective: "Ship the migration",
			status: "active",
			tokenBudget: 1000,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: now,
			updatedAt: now,
		},
	};
}

function usage(input: number) {
	return {
		input,
		output: 100,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

const INCOMPLETE_PHASES = [
	{
		name: "Migration",
		tasks: [
			{ content: "convert remaining callers", status: "pending" as const },
			{ content: "update tests", status: "in_progress" as const },
		],
	},
];

describe("AgentSession goal budget-limited scratch closeout", () => {
	let tempDir: TempDir;
	const cleanups: Array<() => Promise<void>> = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-agent-goal-budget-closeout-");
		cleanups.length = 0;
	});

	afterEach(async () => {
		for (const cleanup of cleanups) await cleanup();
		cleanups.length = 0;
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createHarness(settingsOverride: Record<string, unknown> = {}): Promise<{
		session: AgentSession;
		events: AgentSessionEvent[];
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), `testauth-${cleanups.length}.db`));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), `models-${cleanups.length}.yml`));
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.autoContinue": false,
			"compaction.midTurnEnabled": false,
			"compaction.thresholdTokens": 100_000_000,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
			// Reminders on so the model-facing todo nag would fire if the runtime
			// budget closeout failed to pre-empt it.
			"todo.enabled": true,
			"todo.reminders": true,
			...settingsOverride,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());

		// A goal-accounted tool (anything but "goal") whose result records the
		// still-incomplete todo phases into the session branch.
		const todoTool: AgentTool = {
			name: "todo",
			label: "Todo",
			description: "Mock todo tool",
			parameters: type({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: "" }],
				details: { phases: INCOMPLETE_PHASES },
			}),
		};

		let call = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [todoTool], messages: [] },
			convertToLlm,
			streamFn: (_model, _context) => {
				const index = call++;
				const stream = new AssistantMessageEventStream();
				const message =
					index === 0
						? {
								role: "assistant" as const,
								content: [{ type: "toolCall" as const, id: "tc-0", name: "todo", arguments: {} }],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: "claude-sonnet-4-5",
								usage: usage(50_000),
								stopReason: "toolUse" as const,
								timestamp: Date.now(),
							}
						: {
								role: "assistant" as const,
								content: [{ type: "text" as const, text: "Progress summarized; remaining work is parked." }],
								api: "anthropic-messages" as const,
								provider: "anthropic" as const,
								model: "claude-sonnet-4-5",
								usage: usage(200),
								stopReason: "stop" as const,
								timestamp: Date.now(),
							};
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason, message });
				});
				return stream;
			},
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[todoTool.name, todoTool]]),
			scratchHandoffDisplayPath: "agent/current.org",
		});

		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
		});

		cleanups.push(async () => {
			await session.dispose();
			authStorage.close();
		});
		return { session, events };
	}

	it("parks the budget-limited terminal and preserves todos instead of nagging the model", async () => {
		const { session, events } = await createHarness();
		session.setGoalModeState(budgetGoalState());

		await session.prompt("work on the migration");
		await session.waitForIdle();

		// Runtime owns the terminal: a parked notice naming the scratch continuity
		// file, with the incomplete todos explicitly preserved.
		const parkedNotice = events.find(event => event.type === "notice" && event.message.includes("Work parked"));
		expect(parkedNotice).toBeDefined();
		if (parkedNotice?.type === "notice") {
			expect(parkedNotice.message).toContain("agent/current.org");
			expect(parkedNotice.message).toContain("unfinished todo item(s) preserved");
		}

		// The model-facing todo reminder (the path that previously pressured the
		// model into dropping todos to stop the turn) must not fire.
		expect(events.some(event => event.type === "todo_reminder")).toBe(false);

		// Goal stays budget-limited; the runtime never closed it as complete.
		expect(session.getGoalModeState()?.goal.status).toBe("budget-limited");
	});

	it("fires the budget closeout once per budget-limited episode", async () => {
		const { session, events } = await createHarness();
		session.setGoalModeState(budgetGoalState());

		await session.prompt("work on the migration");
		await session.waitForIdle();

		const parkedNotices = events.filter(event => event.type === "notice" && event.message.includes("Work parked"));
		expect(parkedNotices).toHaveLength(1);
	});
});

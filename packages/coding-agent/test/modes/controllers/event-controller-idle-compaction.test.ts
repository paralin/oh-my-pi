import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createContext(
	options: {
		editorText?: string;
		goalObjective?: string;
		isCompacting?: boolean;
		isStreaming?: boolean;
		runIdleCompaction?: () => void;
		runEphemeralTurn?: (args: {
			promptText: string;
			signal?: AbortSignal;
		}) => Promise<{ replyText: string; assistantMessage: AssistantMessage }>;
		sessionName?: string;
		showStatus?: (message: string, options?: { dim?: boolean }) => void;
		todoPhases?: InteractiveModeContext["todoPhases"];
	} = {},
): InteractiveModeContext {
	const runIdleCompaction = options.runIdleCompaction ?? (() => {});
	const runEphemeralTurn =
		options.runEphemeralTurn ?? (async () => ({ replyText: "", assistantMessage: createAssistantMessage() }));
	const goalState = options.goalObjective
		? {
				enabled: true,
				mode: "active",
				goal: {
					id: "goal-test",
					objective: options.goalObjective,
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				},
			}
		: undefined;
	const context = {
		isInitialized: true,
		loadingAnimation: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		flushPendingModelSwitch: async () => {},
		flushPendingCommandOutput: () => {},
		ui: { requestRender: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		statusContainer: { clear: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		editor: { getText: () => options.editorText ?? "" },
		sessionManager: { getSessionName: () => options.sessionName },
		todoPhases: options.todoPhases ?? [],
		showStatus: options.showStatus ?? (() => {}),
		session: {
			isCompacting: options.isCompacting ?? false,
			isStreaming: options.isStreaming ?? false,
			runIdleCompaction,
			runEphemeralTurn,
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			messages: [createAssistantMessage()],
			getContextUsage: () => ({ tokens: 210 }),
			getGoalModeState: () => goalState,
			agent: { state: { messages: [createAssistantMessage()] } },
		},
		get viewSession() {
			return (this as typeof context).session;
		},
		clearTransientSessionUi: () => {},
	} as unknown as InteractiveModeContext;
	return context;
}

describe("EventController idle compaction teardown", () => {
	beforeEach(async () => {
		await initTheme();
		resetSettingsForTest();
		await Settings.init({
			inMemory: true,
			overrides: {
				"compaction.idleEnabled": true,
				"compaction.idleThresholdTokens": 100,
				"compaction.idleTimeoutSeconds": 60,
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("cancels scheduled idle compaction when disposed", async () => {
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		controller.dispose();
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
	});

	it("skips idle compaction when the idle gate is disabled while the timer is pending", async () => {
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		// `override`, not `set`: this suite seeds the gate through `Settings.init({
		// overrides })`, and `#rebuildMerged` applies that override layer last, so a
		// `set` (which writes the global layer) stays shadowed and the effective
		// value would never move.
		settings.override("compaction.idleEnabled", false);
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("skips idle compaction when the threshold is raised past usage while the timer is pending", async () => {
		const runIdleCompaction = vi.fn();
		// Fixture usage is 210 tokens, which armed the timer against the 100 default.
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		settings.override("compaction.idleThresholdTokens", 500);
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("carries the threshold in force at fire time, not the one that armed the timer", async () => {
		const runIdleCompaction = vi.fn();
		const context = createContext({ runIdleCompaction });

		const controller = new EventController(context);
		await controller.handleEvent({ type: "agent_end", messages: [createAssistantMessage()] });
		// Still under the 210-token fixture usage, so the run is authorized — but by
		// 200, not the 100 that armed the timer. The request must report what fired.
		settings.override("compaction.idleThresholdTokens", 200);
		vi.advanceTimersByTime(60_000);

		expect(runIdleCompaction).toHaveBeenCalledWith({
			idleThreshold: { enabled: true, thresholdTokens: 200 },
		});
		controller.dispose();
	});
});

import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ChatBlock } from "@oh-my-pi/pi-coding-agent/modes/components/chat-block";
import { MaintenanceTraceCard } from "@oh-my-pi/pi-coding-agent/modes/components/maintenance-trace-card";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeWorkingLoader {
	stop: Mock<() => void>;
	kind: "working";
}

/**
 * Faithful model of the shared `statusContainer` + working-loader invariant that
 * InteractiveMode owns:
 *  - `agent_start` → `ensureLoadingAnimation()` only creates+attaches the loader
 *    when `loadingAnimation` is unset (the real `if (!this.loadingAnimation)`
 *    guard), so a stale, still-referenced loader makes it a no-op.
 *  - A transient overlay (auto-compaction / auto-retry) takes over the container.
 *
 * The regression: the overlay handlers cleared the container (detaching the
 * working loader) but left `loadingAnimation` set, so the resumed turn's
 * `agent_start` skipped re-attaching it — "Working…" vanished while the agent
 * kept streaming. The fix tears the working loader down (stop + dereference) so
 * the next `agent_start` recreates and re-attaches it.
 */
function createContext(
	options: { terminalProgress?: boolean; maintenanceTrace?: "loader" | "assistant" | "debug" } = {},
) {
	const streamState = { isStreaming: false };
	const children: unknown[] = [];
	const chatChildren: unknown[] = [];
	const statusContainer = {
		children,
		clear() {
			children.length = 0;
		},
		addChild(child: unknown) {
			children.push(child);
		},
		removeChild(child: unknown) {
			const index = children.indexOf(child);
			if (index !== -1) children.splice(index, 1);
		},
	};
	const chatContainer = {
		children: chatChildren,
		clear() {
			chatChildren.length = 0;
		},
		addChild(child: unknown) {
			chatChildren.push(child);
		},
		removeChild(child: unknown) {
			const index = chatChildren.indexOf(child);
			if (index !== -1) chatChildren.splice(index, 1);
		},
		isWithinLiveRegion: () => true,
	};
	const workingLoaders: FakeWorkingLoader[] = [];
	const setProgress = vi.fn();
	const ctx = {
		isInitialized: true,
		settings: {
			get: (path: string) => {
				if (path === "terminal.showProgress") return options.terminalProgress === true;
				if (path === "compaction.maintenanceTrace") return options.maintenanceTrace ?? "assistant";
				return undefined;
			},
		},
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		pendingTools: new Map<string, unknown>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		statusContainer,
		chatContainer,
		present: vi.fn((content: unknown) => {
			const items = Array.isArray(content) ? content : [content];
			for (const item of items) {
				chatContainer.addChild(item);
				if (item instanceof ChatBlock) item.mount({ requestRender: ctx.ui.requestRender });
			}
			ctx.ui.requestRender();
		}),
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushCompactionQueue: vi.fn(async () => {}),
		rebuildChatFromMessages: vi.fn(),
		reloadTodos: vi.fn(async () => {}),
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { setProgress } },
		viewSession: {
			isCompacting: false,
			getLastAssistantMessage: () => undefined,
			get isStreaming() {
				return streamState.isStreaming;
			},
		},
		session: {
			get isStreaming() {
				return streamState.isStreaming;
			},
			getToolByName: () => undefined,
		},
	} as unknown as InteractiveModeContext;
	ctx.ensureLoadingAnimation = vi.fn(() => {
		if (ctx.loadingAnimation) return;
		statusContainer.clear();
		const working: FakeWorkingLoader = { stop: vi.fn(), kind: "working" };
		workingLoaders.push(working);
		ctx.loadingAnimation = working as unknown as typeof ctx.loadingAnimation;
		statusContainer.addChild(ctx.loadingAnimation);
	});
	return { ctx, streamState, statusContainer, workingLoaders, setProgress };
}

type AgentStartEvent = Extract<AgentSessionEvent, { type: "agent_start" }>;
type AgentEndEvent = Extract<AgentSessionEvent, { type: "agent_end" }>;
type AutoCompactionStartEvent = Extract<AgentSessionEvent, { type: "auto_compaction_start" }>;
type AutoCompactionEndEvent = Extract<AgentSessionEvent, { type: "auto_compaction_end" }>;
type MaintenanceTraceStartEvent = Extract<AgentSessionEvent, { type: "maintenance_trace_start" }>;
type MaintenanceTracePhaseEvent = Extract<AgentSessionEvent, { type: "maintenance_trace_phase" }>;
type MaintenanceTraceDeltaEvent = Extract<AgentSessionEvent, { type: "maintenance_trace_delta" }>;
type MaintenanceTraceEndEvent = Extract<AgentSessionEvent, { type: "maintenance_trace_end" }>;

const AGENT_START: AgentStartEvent = { type: "agent_start" };
const AGENT_END: AgentEndEvent = { type: "agent_end", messages: [] };
const COMPACTION_START: AutoCompactionStartEvent = {
	type: "auto_compaction_start",
	reason: "overflow",
	action: "context-full",
};
const COMPACTION_END: AutoCompactionEndEvent = {
	type: "auto_compaction_end",
	action: "context-full",
	result: { summary: "s", shortSummary: "s", tokensBefore: 10, details: {}, firstKeptEntryId: "entry-1" },
	aborted: false,
	willRetry: true,
};
const RETRY_START: Extract<AgentSessionEvent, { type: "auto_retry_start" }> = {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 1000,
	errorMessage: "overloaded",
};
const TASK_TOOL_EXECUTION_END: Extract<AgentSessionEvent, { type: "tool_execution_end" }> = {
	type: "tool_execution_end",
	toolCallId: "call-task-1",
	toolName: "task",
	result: { content: [], details: {} },
	isError: false,
};
const SCRATCH_HANDOFF_START: AutoCompactionStartEvent = {
	type: "auto_compaction_start",
	reason: "threshold",
	action: "scratch-handoff",
};
const SCRATCH_HANDOFF_END: AutoCompactionEndEvent = {
	type: "auto_compaction_end",
	action: "scratch-handoff",
	result: undefined,
	aborted: false,
	willRetry: false,
};
const SCRATCH_HANDOFF_TRACE_TARGET: MaintenanceTracePhaseEvent = {
	type: "maintenance_trace_phase",
	traceId: "session:maintenance:1",
	reason: "threshold",
	action: "scratch-handoff",
	visibility: "ui-only",
	phase: "scratch-target-resolved",
	targetPath: "agent/current.org",
};
const SCRATCH_HANDOFF_TRACE_READ: MaintenanceTracePhaseEvent = {
	...SCRATCH_HANDOFF_TRACE_TARGET,
	phase: "scratch-read-injected",
};
const HANDOFF_TRACE_START: MaintenanceTraceStartEvent = {
	type: "maintenance_trace_start",
	traceId: "session:maintenance:2",
	reason: "threshold",
	action: "handoff",
	visibility: "ui-only",
	phase: "start",
};
const HANDOFF_TRACE_DELTA: MaintenanceTraceDeltaEvent = {
	...HANDOFF_TRACE_START,
	type: "maintenance_trace_delta",
	phase: "stream",
	content: "assistant_text",
	delta: "Preparing a compact handoff.",
};
const HANDOFF_TRACE_ACTIVITY: MaintenanceTraceDeltaEvent = {
	...HANDOFF_TRACE_START,
	type: "maintenance_trace_delta",
	phase: "stream",
	content: "activity",
	delta: "LLM request: anthropic/claude-sonnet-4-5.",
};
const HANDOFF_TRACE_END: MaintenanceTraceEndEvent = {
	...HANDOFF_TRACE_START,
	type: "maintenance_trace_end",
	phase: "terminal",
	terminalResult: "done",
	willRetry: false,
};
const HANDOFF_TRACE_DEBUG_END: MaintenanceTraceEndEvent = {
	...HANDOFF_TRACE_END,
	debugArtifactId: "7",
	debugLogRef: "artifact://7",
};

describe("EventController loader recovery after overflow maintenance", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("re-shows the Working… loader after auto-compaction recovers and streams a new turn", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		// Turn 1 begins: the working loader is created and attached.
		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(firstWorking).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);

		// Overflow recovery hands the status container to the auto-compaction loader.
		// The original turn's agent_end is held while the prompt is in flight, so the
		// session keeps reporting streaming throughout.
		streamState.isStreaming = true;
		await controller.handleEvent(COMPACTION_START);

		// The working loader must be fully torn down — not detached-but-referenced —
		// so the upcoming agent_start can recreate it.
		expect(firstWorking?.stop).toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(statusContainer.children).not.toContain(firstWorking);

		await controller.handleEvent(COMPACTION_END);

		// The retry continuation starts a fresh turn: the loader must reappear in the
		// status container so streaming shows "Working…" again (issue: it stayed gone).
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
		expect(workingLoaders).toHaveLength(2);
	});

	it("re-shows the Working… loader after an auto-retry resumes the turn", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(statusContainer.children).toContain(ctx.loadingAnimation);

		// A transient error: the retry loader takes over the status container.
		streamState.isStreaming = true;
		await controller.handleEvent(RETRY_START);
		expect(firstWorking?.stop).toHaveBeenCalled();
		expect(ctx.loadingAnimation).toBeUndefined();

		// The retry attempt re-enters the agent loop, emitting a fresh agent_start.
		await controller.handleEvent(AGENT_START);
		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
	});

	it("re-shows the Working… loader after a subagent task completes while the session keeps streaming", async () => {
		const { ctx, streamState, statusContainer, workingLoaders } = createContext();
		const controller = new EventController(ctx);

		// Turn begins: the working loader is created and attached.
		await controller.handleEvent(AGENT_START);
		const firstWorking = workingLoaders[0];
		expect(firstWorking).toBeDefined();

		// A transient overlay (auto-retry / auto-compaction) tore the loader down
		// mid-tool; the session is still streaming when the subagent's task
		// completes. Before the fix, `tool_execution_end` (unlike `_update`) did
		// not re-arm the loader, so the UI looked idle while the agent kept going.
		streamState.isStreaming = true;
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
		statusContainer.clear();

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		expect(ctx.loadingAnimation).toBeDefined();
		expect(statusContainer.children).toContain(ctx.loadingAnimation);
		expect(workingLoaders).toHaveLength(2);
	});

	it("does not re-arm the Working… loader on tool_execution_end once the session has stopped streaming", async () => {
		const { ctx, streamState, statusContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		ctx.loadingAnimation?.stop();
		ctx.loadingAnimation = undefined;
		statusContainer.clear();
		streamState.isStreaming = false;

		await controller.handleEvent(TASK_TOOL_EXECUTION_END);

		// No streaming → reconciler must stay a no-op; the spinner is not the
		// post-turn idle state.
		expect(ctx.loadingAnimation).toBeUndefined();
		expect(statusContainer.children).toHaveLength(0);
	});

	it("shows hidden Boss scratch handoff as transient maintenance, not chat", async () => {
		const { ctx, statusContainer } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(SCRATCH_HANDOFF_START);

		expect(statusContainer.children).toHaveLength(1);
		const loader = statusContainer.children[0] as { render(width: number): readonly string[] };
		const rendered = Bun.stripANSI(loader.render(80).join("\n"));
		expect(rendered).toContain("Context pressure: syncing scratch");
		expect(rendered).toContain("esc to cancel");
		expect(ctx.showStatus).not.toHaveBeenCalled();

		await controller.handleEvent(SCRATCH_HANDOFF_TRACE_TARGET);
		const targetRendered = Bun.stripANSI(loader.render(120).join("\n"));
		expect(targetRendered).toContain("Context pressure: scratch target resolved");
		expect(targetRendered).toContain("agent/current.org");
		expect(targetRendered).toContain("esc to cancel");

		await controller.handleEvent(SCRATCH_HANDOFF_TRACE_READ);
		const readRendered = Bun.stripANSI(loader.render(80).join("\n"));
		expect(readRendered).toContain("Context pressure: scratch state loaded");
		expect(readRendered).toContain("agent/current.org");

		await controller.handleEvent(SCRATCH_HANDOFF_END);

		expect(statusContainer.children).toHaveLength(0);
		expect(ctx.showStatus).not.toHaveBeenCalled();
		expect(ctx.showWarning).not.toHaveBeenCalled();
		expect(ctx.statusLine.invalidate).toHaveBeenCalled();
		expect(ctx.updateEditorTopBorder).toHaveBeenCalled();
	});

	it("mounts a UI-only maintenance card for handoff trace deltas", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(HANDOFF_TRACE_START);

		expect(ctx.present).toHaveBeenCalledTimes(1);
		expect(ctx.chatContainer.children).toHaveLength(1);
		const card = ctx.chatContainer.children[0];
		expect(card).toBeInstanceOf(MaintenanceTraceCard);
		if (!(card instanceof MaintenanceTraceCard)) throw new Error("Expected maintenance trace card");
		const started = Bun.stripANSI(card.render(100).join("\n"));
		expect(started).toContain("Maintenance model: auto-handoff");
		expect(started).toContain("UI-only");
		expect(started).toContain("Esc cancels this maintenance run");

		await controller.handleEvent(HANDOFF_TRACE_ACTIVITY);
		await controller.handleEvent(HANDOFF_TRACE_DELTA);
		const streamed = Bun.stripANSI(card.render(100).join("\n"));
		expect(streamed).toContain("Process:");
		expect(streamed).toContain("LLM request: anthropic/claude-sonnet-4-5.");
		expect(streamed).toContain("LLM output:");
		expect(streamed).toContain("Preparing a compact handoff.");
		expect(streamed).not.toContain("Shows selected context-maintenance progress");

		ctx.chatContainer.clear();
		await controller.handleEvent(HANDOFF_TRACE_END);
		const terminal = Bun.stripANSI(card.render(100).join("\n"));
		expect(ctx.chatContainer.children).toContain(card);
		expect(terminal).toContain("Done.");
	});

	it("preserves loader-only visibility without mounting a maintenance card", async () => {
		const { ctx } = createContext({ maintenanceTrace: "loader" });
		const controller = new EventController(ctx);

		await controller.handleEvent(HANDOFF_TRACE_START);
		await controller.handleEvent(HANDOFF_TRACE_DELTA);
		await controller.handleEvent(HANDOFF_TRACE_END);

		expect(ctx.present).not.toHaveBeenCalled();
		expect(ctx.chatContainer.children).toHaveLength(0);
	});

	it("renders debug artifact references without inline raw provider frames", async () => {
		const { ctx } = createContext({ maintenanceTrace: "debug" });
		const controller = new EventController(ctx);

		await controller.handleEvent(HANDOFF_TRACE_START);
		const card = ctx.chatContainer.children[0];
		expect(card).toBeInstanceOf(MaintenanceTraceCard);
		if (!(card instanceof MaintenanceTraceCard)) throw new Error("Expected maintenance trace card");
		await controller.handleEvent(HANDOFF_TRACE_DELTA);
		await controller.handleEvent(HANDOFF_TRACE_DEBUG_END);
		const rendered = Bun.stripANSI(card.render(120).join("\n"));

		expect(rendered).toContain("Preparing a compact handoff.");
		expect(rendered).toContain("Debug raw provider frames: artifact://7");
		expect(rendered).not.toContain("event: message");
		expect(rendered).not.toContain("raw provider payload");
	});

	it("renders scratch trace phases in the maintenance card without assistant output", async () => {
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent({
			type: "maintenance_trace_start",
			traceId: SCRATCH_HANDOFF_TRACE_TARGET.traceId,
			reason: "threshold",
			action: "scratch-handoff",
			visibility: "ui-only",
			phase: "start",
			targetPath: "agent/current.org",
		});
		const card = ctx.chatContainer.children[0];
		expect(card).toBeInstanceOf(MaintenanceTraceCard);
		if (!(card instanceof MaintenanceTraceCard)) throw new Error("Expected maintenance trace card");

		await controller.handleEvent(SCRATCH_HANDOFF_TRACE_TARGET);
		await controller.handleEvent(SCRATCH_HANDOFF_TRACE_READ);
		const rendered = Bun.stripANSI(card.render(100).join("\n"));

		expect(rendered).toContain("Maintenance: scratch continuity");
		expect(rendered).toContain("agent/current.org");
		expect(rendered).toContain("Scratch continuity:");
		expect(rendered).toContain("target resolved");
		expect(rendered).toContain("scratch read injected");
		expect(rendered).not.toContain("LLM output:");
	});

	it("mirrors agent and auto-compaction activity to OSC 9;4 when enabled", async () => {
		const { ctx, setProgress } = createContext({ terminalProgress: true });
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		expect(setProgress).toHaveBeenCalledTimes(1);
		expect(setProgress).toHaveBeenLastCalledWith(true);

		await controller.handleEvent(COMPACTION_START);
		expect(setProgress).toHaveBeenCalledTimes(1);

		await controller.handleEvent(COMPACTION_END);
		expect(setProgress).toHaveBeenCalledTimes(2);
		expect(setProgress).toHaveBeenLastCalledWith(false);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent(AGENT_END);
		expect(setProgress.mock.calls.map(call => call[0])).toEqual([true, false, true, false]);
	});
});

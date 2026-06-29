/**
 * Regression: print-mode must not write SILENT_ABORT_MARKER to stderr.
 *
 * Codex review flagged that `print-mode.ts` renders `errorMessage` verbatim
 * when stopReason is "aborted", which would surface the sentinel to stderr
 * (and exit with code 1). This test verifies the guard skips silent-abort.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";

function makeAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "draft" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
		...overrides,
	};
}

/** Minimal mock of AgentSession for print-mode text output path */
function createMockSession(
	messages: AssistantMessage[],
	options: {
		maintenanceTrace?: "loader" | "assistant" | "debug";
		onPrompt?: (emit: (event: AgentSessionEvent) => void) => void | Promise<void>;
	} = {},
): AgentSession {
	const subscription: { callback?: (event: AgentSessionEvent) => void } = {};
	return {
		state: { messages },
		sessionManager: {
			getHeader: () => undefined,
		},
		extensionRunner: undefined,
		settings: Settings.isolated({
			"compaction.maintenanceTrace": options.maintenanceTrace ?? "assistant",
		}),
		subscribe: (callback: (event: AgentSessionEvent) => void) => {
			subscription.callback = callback;
			return () => {
				subscription.callback = undefined;
			};
		},
		prompt: async () => {
			await options.onPrompt?.(event => subscription.callback?.(event));
		},
		dispose: async () => {},
	} as unknown as AgentSession;
}

function parseJsonEventType(line: string): string {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
		throw new Error("Expected JSON event with string type");
	}
	return parsed.type;
}

describe("Print-mode silent-abort regression", () => {
	let exitSpy: Mock<typeof process.exit>;
	let stderrOutput: string[];
	let stdoutOutput: string[];

	beforeEach(() => {
		stderrOutput = [];
		stdoutOutput = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			// Invoke callback if present (runPrintMode flushes stdout before returning)
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not write silent-abort marker to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorMessage: SILENT_ABORT_MARKER,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		// The silent-abort marker MUST NOT appear in stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).not.toContain(SILENT_ABORT_MARKER);
		// process.exit MUST NOT have been called (clean termination)
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("does not write bit-classified silent aborts to stderr or exit non-zero", async () => {
		const silentAbortMsg = makeAssistantMessage({
			stopReason: "aborted",
			errorId: AIError.create(AIError.Flag.SilentAbort),
			errorMessage: undefined,
			content: [],
		});

		const session = createMockSession([silentAbortMsg]);
		await runPrintMode(session, { mode: "text" });

		expect(stderrOutput.join("")).toBe("");
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("writes real error messages to stderr and exits non-zero", async () => {
		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Rate limit exceeded",
			content: [],
		});

		const session = createMockSession([errorMsg]);
		await runPrintMode(session, { mode: "text" });

		// A real error SHOULD be written to stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Rate limit exceeded");
		// process.exit(1) SHOULD have been called
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("prints thinking blocks only when printThoughts is enabled", async () => {
		const message = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: "inspect hidden branch" },
				{ type: "text", text: "final answer" },
			],
		});

		await runPrintMode(createMockSession([message]), { mode: "text" });
		expect(stdoutOutput.join("")).toBe("final answer\n");

		stdoutOutput = [];
		await runPrintMode(createMockSession([message]), { mode: "text", printThoughts: true });
		expect(stdoutOutput.join("")).toBe("inspect hidden branch\nfinal answer\n");
	});

	it("defaults maintenance traces to assistant visibility", () => {
		expect(getDefault("compaction.maintenanceTrace")).toBe("assistant");
		expect(Settings.isolated().get("compaction.maintenanceTrace")).toBe("assistant");
	});

	it("filters maintenance trace JSON events only in loader visibility", async () => {
		const traceEvents: AgentSessionEvent[] = [
			{
				type: "maintenance_trace_start",
				traceId: "trace-1",
				reason: "threshold",
				action: "handoff",
				visibility: "ui-only",
				phase: "start",
			},
			{ type: "auto_compaction_start", reason: "threshold", action: "handoff" },
			{
				type: "maintenance_trace_delta",
				traceId: "trace-1",
				reason: "threshold",
				action: "handoff",
				visibility: "ui-only",
				phase: "stream",
				content: "assistant_text",
				delta: "visible maintenance text",
			},
			{
				type: "maintenance_trace_end",
				traceId: "trace-1",
				reason: "threshold",
				action: "handoff",
				visibility: "ui-only",
				phase: "terminal",
				terminalResult: "done",
				willRetry: false,
			},
		];
		const emitTraceEvents = (emit: (event: AgentSessionEvent) => void) => {
			for (const event of traceEvents) emit(event);
		};

		await runPrintMode(createMockSession([], { maintenanceTrace: "loader", onPrompt: emitTraceEvents }), {
			mode: "json",
			initialMessage: "go",
		});
		const loaderLines = stdoutOutput.join("").split("\n").filter(Boolean).map(parseJsonEventType);
		expect(loaderLines).toEqual(["auto_compaction_start"]);

		stdoutOutput = [];
		await runPrintMode(createMockSession([], { maintenanceTrace: "assistant", onPrompt: emitTraceEvents }), {
			mode: "json",
			initialMessage: "go",
		});
		const assistantLines = stdoutOutput.join("").split("\n").filter(Boolean).map(parseJsonEventType);
		expect(assistantLines).toEqual([
			"maintenance_trace_start",
			"auto_compaction_start",
			"maintenance_trace_delta",
			"maintenance_trace_end",
		]);
	});
});

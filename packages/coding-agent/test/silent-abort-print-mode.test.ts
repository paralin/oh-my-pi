/**
 * Regression: print-mode must not write SILENT_ABORT_MARKER to stderr.
 *
 * Codex review flagged that `print-mode.ts` renders `errorMessage` verbatim
 * when stopReason is "aborted", which would surface the sentinel to stderr
 * (and exit with code 1). This test verifies the guard skips silent-abort.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getDefault } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getPrintModeExitCode, runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import {
	type AgentSession,
	type AgentSessionDisposeOptions,
	type AgentSessionEvent,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
	optionsOrDispose:
		| {
				maintenanceTrace?: "loader" | "assistant" | "debug";
				onPrompt?: (emit: (event: AgentSessionEvent) => void) => void | Promise<void>;
				cwd?: string;
				contextUsage?: { tokens: number; contextWindow: number; percent?: number };
				onBudgetStopCloseout?: () => Promise<boolean>;
		  }
		| ((options?: AgentSessionDisposeOptions) => Promise<void>) = {},
): AgentSession {
	const options = typeof optionsOrDispose === "function" ? {} : optionsOrDispose;
	const dispose = typeof optionsOrDispose === "function" ? optionsOrDispose : async () => {};
	const subscription: { callback?: (event: AgentSessionEvent) => void } = {};
	return {
		state: { messages },
		getLastAssistantMessage: () => messages.findLast(message => message.role === "assistant"),
		sessionManager: {
			getHeader: () => undefined,
			getCwd: () => options.cwd ?? process.cwd(),
			buildSessionContext: () => ({ messages: [] }),
			getEntries: () => [],
		},
		settings: Settings.isolated({
			"compaction.maintenanceTrace": options.maintenanceTrace ?? "assistant",
		}),
		getContextUsage: () => options.contextUsage,
		requestScratchHandoffCloseoutForBudgetStop: async () => options.onBudgetStopCloseout?.() ?? false,
		subscribe: (callback: (event: AgentSessionEvent) => void) => {
			subscription.callback = callback;
			return () => {
				subscription.callback = undefined;
			};
		},
		prompt: async () => {
			await options.onPrompt?.(event => subscription.callback?.(event));
		},
		waitForIdle: async () => {},
		extensionRunner: undefined,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		dispose,
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
	let stdoutSpy: Mock<typeof process.stdout.write>;
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
		stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
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

	it("bounds final memory consolidation so print mode can exit", async () => {
		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const session = createMockSession([makeAssistantMessage()], async options => {
			disposeOptions = options;
		});

		await runPrintMode(session, { mode: "text" });

		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
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

		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const session = createMockSession([errorMsg], async options => {
			disposeOptions = options;
		});
		await runPrintMode(session, { mode: "text" });

		// A real error SHOULD be written to stderr
		const stderrText = stderrOutput.join("");
		expect(stderrText).toContain("Rate limit exceeded");
		// process.exit(1) SHOULD have been called
		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});

	it("maps a JSON-mode provider error to a non-zero process status", () => {
		const errorMsg = makeAssistantMessage({
			stopReason: "error",
			errorMessage: "Unable to connect",
			content: [],
		});

		expect(getPrintModeExitCode(createMockSession([errorMsg]))).toBe(1);
		expect(getPrintModeExitCode(createMockSession([makeAssistantMessage()]))).toBe(0);
	});

	it("runs one bounded scratch closeout before naming it in the budget-stop event", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omp-print-mode-"));
		const scratchPath = join(cwd, "scratch.org");
		await writeFile(scratchPath, "#+TITLE: Current agent work\n* TODO Current work\n");
		let closeoutCalls = 0;
		try {
			const session = createMockSession([], {
				cwd,
				contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
				onBudgetStopCloseout: async () => {
					closeoutCalls++;
					await writeFile(
						scratchPath,
						[
							"#+TITLE: Current agent work",
							"* TODO Current work",
							"- Objective: preserve the handoff",
							"- Verification: focused test",
						].join("\n"),
					);
					return true;
				},
			});
			await runPrintMode(session, {
				mode: "json",
				initialMessage: "stop now",
				contextBudgetStop: { stopAtTokens: 1, scratchHandoffFile: scratchPath },
			});
			const stopEvent = stdoutOutput
				.map(line => JSON.parse(line) as { type?: string; scratchHandoffFile?: string })
				.find(event => event.type === "context_budget_stop");
			expect(closeoutCalls).toBe(1);
			expect(await readFile(scratchPath, "utf8")).toContain("- Objective: preserve the handoff");
			expect(stopEvent?.scratchHandoffFile).toBe(scratchPath);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("omits an unfilled scratch template when no closeout headroom remains", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "omp-print-mode-"));
		const scratchPath = join(cwd, "scratch.org");
		await writeFile(
			scratchPath,
			[
				"#+TITLE: Current agent work",
				"",
				"* TODO Current work",
				"- Objective: ",
				"- Skill stack: ",
				"- Work completed: ",
				"- Files changed: ",
				"- Verification: ",
				"- Blockers or risks: ",
				"- Next action: ",
				"- Source refs: ",
				"",
			].join("\n"),
		);
		try {
			const session = createMockSession([], {
				cwd,
				contextUsage: { tokens: 10, contextWindow: 100, percent: 10 },
				onBudgetStopCloseout: async () => false,
			});
			await runPrintMode(session, {
				mode: "json",
				initialMessage: "stop now",
				contextBudgetStop: { stopAtTokens: 1, scratchHandoffFile: scratchPath },
			});
			const stopEvent = stdoutOutput
				.map(line => JSON.parse(line) as { type?: string; scratchHandoffFile?: string })
				.find(event => event.type === "context_budget_stop");
			expect(stopEvent).toBeDefined();
			expect(stopEvent?.scratchHandoffFile).toBeUndefined();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("queues and settles an initial prompt when resume startup is already busy", async () => {
		const session = createMockSession([]);
		let busy = true;
		let streamingBehavior: unknown;
		session.prompt = async (_text, options) => {
			streamingBehavior = options?.streamingBehavior;
			if (busy && streamingBehavior !== "steer") {
				throw new Error("Agent is already processing");
			}
			return true;
		};
		session.waitForIdle = async () => {
			busy = false;
		};

		await expect(
			runPrintMode(session, { mode: "text", initialMessage: "status: reply with one line" }),
		).resolves.toBe(undefined);
		expect(streamingBehavior).toBe("steer");
		expect(busy).toBe(false);
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

	it("contains a closed JSON output pipe and aborts the active turn", async () => {
		const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		let writes = 0;
		stdoutSpy.mockImplementation(() => {
			writes++;
			throw brokenPipe;
		});
		const session = createMockSession([], {
			onPrompt: emit => {
				emit({ type: "turn_start" });
				emit({ type: "turn_end", message: makeAssistantMessage(), toolResults: [] });
			},
		});
		const abort = vi.fn(async () => {});
		session.abort = abort;
		const dispose = vi.fn(async () => {});
		session.dispose = dispose;

		await expect(runPrintMode(session, { mode: "json", initialMessage: "go" })).resolves.toBeUndefined();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(writes).toBe(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("contains a closed output pipe while writing final text", async () => {
		const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		let writes = 0;
		stdoutSpy.mockImplementation(() => {
			writes++;
			throw brokenPipe;
		});
		const message = makeAssistantMessage({
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "final answer" },
			],
		});
		const session = createMockSession([message]);
		const abort = vi.fn(async () => {});
		session.abort = abort;
		const dispose = vi.fn(async () => {});
		session.dispose = dispose;

		await expect(runPrintMode(session, { mode: "text", printThoughts: true })).resolves.toBeUndefined();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(writes).toBe(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("contains an asynchronous EPIPE emitted by the JSON output stream", async () => {
		const brokenPipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
		const listenersBefore = process.stdout.listenerCount("error");
		const session = createMockSession([], {
			onPrompt: emit => {
				emit({ type: "turn_start" });
				process.stdout.emit("error", brokenPipe);
				emit({ type: "turn_end", message: makeAssistantMessage(), toolResults: [] });
			},
		});
		const abort = vi.fn(async () => {});
		session.abort = abort;
		const dispose = vi.fn(async () => {});
		session.dispose = dispose;

		await expect(runPrintMode(session, { mode: "json", initialMessage: "go" })).resolves.toBeUndefined();
		expect(abort).toHaveBeenCalledTimes(1);
		expect(stdoutOutput).toHaveLength(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(process.stdout.listenerCount("error")).toBe(listenersBefore);
	});

	it("preserves failures from unrelated stdout errors", async () => {
		const outputError = Object.assign(new Error("output failed"), { code: "EIO" });
		const listenersBefore = process.stdout.listenerCount("error");
		const session = createMockSession([], {
			onPrompt: () => {
				process.stdout.emit("error", outputError);
			},
		});

		await expect(runPrintMode(session, { mode: "json", initialMessage: "go" })).rejects.toBe(outputError);
		expect(process.stdout.listenerCount("error")).toBe(listenersBefore);
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

/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { type AgentSession, type AgentSessionEvent, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE } from "../session/scratch-handoff";
import { flushTelemetryExport } from "../telemetry-export";
import { resolveToCwd } from "../tools/path-utils";
import { initializeExtensions } from "./runtime-init";

function scratchHandoffHasContent(text: string): boolean {
	const fieldPattern =
		/^-\s+(?:Objective|Skill stack|Work completed|Files changed|Verification|Blockers or risks|Next action|Source refs):[ \t]*(\S.*)$/gm;
	return fieldPattern.test(text);
}

async function scratchHandoffFileIfWritten(
	session: AgentSession,
	scratchPath: string | undefined,
): Promise<string | undefined> {
	if (!scratchPath) return undefined;
	let absolutePath: string;
	try {
		absolutePath = resolveToCwd(scratchPath, session.sessionManager.getCwd());
	} catch {
		return undefined;
	}
	let text: string;
	try {
		text = await readFile(absolutePath, "utf8");
	} catch {
		return undefined;
	}
	return scratchHandoffHasContent(text) ? scratchPath : undefined;
}

export interface ContextBudgetStopOptions {
	/** Stop when context usage reaches this percent of the selected model window. */
	stopAtPercent?: number;
	/** Stop when context usage reaches this token count. */
	stopAtTokens?: number;
	/** Scratch handoff document the agent has been instructed to keep current before stopping. */
	scratchHandoffFile?: string;
}

interface ContextBudgetStop {
	tokens: number;
	contextWindow: number;
	percent: number;
	limitTokens: number;
	scratchHandoffFile?: string;
}

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
	/** Optional headless goal objective. When set, print mode keeps continuing until the goal settles. */
	goal?: {
		objective: string;
		tokenBudget?: number;
	};
	/** Optional headless guard that stops before the context window is exhausted. */
	contextBudgetStop?: ContextBudgetStopOptions;
}

function resolveContextBudgetStop(
	session: AgentSession,
	options: ContextBudgetStopOptions | undefined,
): ContextBudgetStop | undefined {
	if (!options || (options.stopAtPercent === undefined && options.stopAtTokens === undefined)) return undefined;
	const usage = session.getContextUsage();
	if (!usage) return undefined;

	const limits: number[] = [];
	if (options.stopAtTokens !== undefined) {
		limits.push(options.stopAtTokens);
	}
	if (options.stopAtPercent !== undefined && usage.contextWindow > 0) {
		limits.push(Math.floor((usage.contextWindow * options.stopAtPercent) / 100));
	}
	if (limits.length === 0) return undefined;

	const limitTokens = Math.min(...limits.filter(limit => Number.isFinite(limit) && limit > 0));
	if (!Number.isFinite(limitTokens) || limitTokens <= 0 || usage.tokens < limitTokens) return undefined;

	return {
		tokens: usage.tokens,
		contextWindow: usage.contextWindow,
		percent: usage.percent,
		limitTokens,
		scratchHandoffFile: options.scratchHandoffFile,
	};
}

async function writeFinalAssistantText(
	session: AgentSession,
	printThoughts: boolean | undefined,
	writeStdout: (data: string) => void,
): Promise<void> {
	const assistantMsg = session.getLastAssistantMessage();
	if (!assistantMsg) return;

	if ((assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") && !isSilentAbort(assistantMsg)) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		await session.waitForAdvisorCatchup(PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS);
		await flushTelemetryExport();
		await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
		const flushed = process.stderr.write(`${errorLine}\n`);
		if (flushed) {
			process.exit(1);
		} else {
			process.stderr.once("drain", () => process.exit(1));
		}
	}

	if (assistantMsg.errorMessage && assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
		process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
	}

	for (const content of assistantMsg.content) {
		if (content.type === "text") {
			writeStdout(`${sanitizeText(content.text)}\n`);
		} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
			writeStdout(`${sanitizeText(content.thinking)}\n`);
		}
	}
}

/**
 * getPrintModeExitCode returns a non-zero status when the final assistant turn
 * reports a provider error, including JSON mode where output is streamed before
 * the process exits.
 */
export function getPrintModeExitCode(session: AgentSession): number {
	const lastMessage = session.getLastAssistantMessage();
	return lastMessage?.stopReason === "error" ? 1 : 0;
}

function isMaintenanceTraceEvent(event: AgentSessionEvent): boolean {
	return (
		event.type === "maintenance_trace_start" ||
		event.type === "maintenance_trace_phase" ||
		event.type === "maintenance_trace_delta" ||
		event.type === "maintenance_trace_end"
	);
}

function shouldPrintJsonEvent(session: AgentSession, event: AgentSessionEvent): boolean {
	if (!isMaintenanceTraceEvent(event)) return true;
	return session.settings.get("compaction.maintenanceTrace") !== "loader";
}

function isBrokenPipeError(err: unknown): boolean {
	return err instanceof Error && "code" in err && err.code === "EPIPE";
}

/** Matches the longest built-in provider request deadline while bounding tool-loop stalls. */
export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Error exits cannot hold automation for the full normal drain budget. */
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

/** Drop the provider-opaque replay payload (e.g. encrypted reasoning items) before printing. */
function stripProviderPayload<T extends AgentMessage>(message: T): T {
	if (!("providerPayload" in message) || message.providerPayload === undefined) return message;
	const { providerPayload: _providerPayload, ...rest } = message;
	return rest as T;
}

/**
 * Shape an event for `--mode json` output.
 *
 * Removes two classes of bloat so transcripts grow linearly with conversation
 * size instead of quadratically (a single long turn used to re-serialize its
 * whole in-progress message on every streamed delta, producing multi-GB logs):
 * - `message_update` snapshots (`message`, `assistantMessageEvent.partial`,
 *   and the `done`/`error` payloads) are dropped; only the incremental delta
 *   is printed. The authoritative message follows in `message_end`.
 * - `providerPayload` is transport-native replay state, opaque and useless
 *   outside this process.
 */
export function printableEvent(event: AgentSessionEvent): unknown {
	switch (event.type) {
		case "message_update": {
			const streamEvent = event.assistantMessageEvent;
			if (streamEvent.type === "done" || streamEvent.type === "error") {
				return {
					type: "message_update",
					assistantMessageEvent: { type: streamEvent.type, reason: streamEvent.reason },
				};
			}
			const { partial: _partial, ...rest } = streamEvent;
			return { type: "message_update", assistantMessageEvent: rest };
		}
		case "message_start":
		case "message_end":
			return { ...event, message: stripProviderPayload(event.message) };
		case "turn_end":
			return {
				...event,
				message: stripProviderPayload(event.message),
				toolResults: event.toolResults.map(stripProviderPayload),
			};
		case "agent_end":
			return { ...event, messages: event.messages.map(stripProviderPayload) };
		default:
			return event;
	}
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, goal, contextBudgetStop } = options;
	let textOutputWritten = false;
	let outputClosed = false;
	let outputAbort: Promise<void> | undefined;
	const closeOutput = (): void => {
		if (outputClosed) return;
		outputClosed = true;
		outputAbort = session.abort({ reason: "print output closed" }).catch(err => {
			logger.warn("Print-mode output-close abort failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	};
	const writeStdout = (data: string): void => {
		if (outputClosed) return;
		try {
			process.stdout.write(data);
		} catch (err) {
			if (!isBrokenPipeError(err)) throw err;
			closeOutput();
		}
	};
	const writeJsonOutput = (value: unknown): void => {
		writeStdout(`${JSON.stringify(value)}\n`);
	};
	const handleStdoutError = (err: Error): void => {
		if (!isBrokenPipeError(err)) throw err;
		closeOutput();
	};
	process.stdout.on("error", handleStdoutError);
	using _stdoutErrorListener = {
		[Symbol.dispose]: () => process.stdout.off("error", handleStdoutError),
	};

	const stopIfOutputClosed = async (): Promise<boolean> => {
		if (!outputClosed) return false;
		await outputAbort;
		await session.dispose();
		return true;
	};

	const stopIfBudgetReached = async (): Promise<boolean> => {
		const stop = resolveContextBudgetStop(session, contextBudgetStop);
		if (!stop) return false;
		if (mode === "text" && !textOutputWritten) {
			await writeFinalAssistantText(session, printThoughts, writeStdout);
			textOutputWritten = true;
		}
		const configuredScratchPath = stop.scratchHandoffFile?.trim() || undefined;
		let closeoutRan = false;
		if (configuredScratchPath && typeof session.requestScratchHandoffCloseoutForBudgetStop === "function") {
			closeoutRan = await session.requestScratchHandoffCloseoutForBudgetStop(stop.tokens);
			if (closeoutRan) await session.waitForIdle();
		}
		const scratchPath = closeoutRan ? await scratchHandoffFileIfWritten(session, configuredScratchPath) : undefined;
		const event = {
			type: "context_budget_stop",
			contextUsage: {
				tokens: stop.tokens,
				contextWindow: stop.contextWindow,
				percent: stop.percent,
			},
			limitTokens: stop.limitTokens,
			scratchHandoffFile: scratchPath,
		};
		if (mode === "json") {
			writeJsonOutput(event);
		} else if (scratchPath) {
			process.stderr.write(`Context budget stop: using scratch handoff at ${scratchPath}\n`);
		} else {
			process.stderr.write("Context budget stop: no scratch handoff file configured\n");
		}
		return true;
	};
	const removeContextBudgetStop =
		contextBudgetStop && typeof session.agent?.addBeforeModelCall === "function"
			? session.agent.addBeforeModelCall(context => {
					const lastMessage = context.messages.at(-1);
					if (lastMessage?.role === "custom" && lastMessage.customType === SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE) {
						return undefined;
					}
					if (!resolveContextBudgetStop(session, contextBudgetStop)) return undefined;
					return { stop: true, reason: "context-budget" };
				})
			: undefined;
	using _contextBudgetStop = {
		[Symbol.dispose]: () => removeContextBudgetStop?.(),
	};

	await session.sessionManager.ensureOnDisk?.();

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeJsonOutput(header);
		}
	}
	if (await stopIfOutputClosed()) return;
	// Set up extensions for print mode (no UI, no command context)
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json" && shouldPrintJsonEvent(session, event)) {
			writeJsonOutput(printableEvent(event));
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	if (goal) {
		await session.goalRuntime.createGoal({
			objective: goal.objective,
			tokenBudget: goal.tokenBudget,
		});
		const activeTools = session.getActiveToolNames();
		if (!activeTools.includes("goal")) {
			await session.setActiveToolsByName([...activeTools, "goal"]);
		}
	}

	// Constructor-owned work such as unread session steering may already be
	// streaming on resume. Queue the explicit print prompt into that turn instead
	// of racing it, then wait until the requested work fully settles.
	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		await logger.time("print:prompt:initial", () =>
			session.prompt(initialMessage, { images: initialImages, streamingBehavior: "steer" }),
		);
		await session.waitForIdle();
		if (await stopIfOutputClosed()) return;
		if (await stopIfBudgetReached()) {
			if (await stopIfOutputClosed()) return;
			await session.dispose();
			return;
		}
	}

	// Send remaining messages
	for (const message of messages) {
		writeTextWorkingIndicator();
		await logger.time("print:prompt:next", () => session.prompt(message, { streamingBehavior: "steer" }));
		await session.waitForIdle();
		if (await stopIfOutputClosed()) return;
		if (await stopIfBudgetReached()) {
			if (await stopIfOutputClosed()) return;
			await session.dispose();
			return;
		}
	}

	while (goal) {
		const state = session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") break;
		const continuation = session.goalRuntime.buildContinuationPrompt();
		if (!continuation) break;
		await logger.time("print:prompt:goal-continuation", () =>
			session.promptCustomMessage({
				customType: "goal-continuation",
				content: continuation,
				display: false,
			}),
		);
		if (await stopIfOutputClosed()) return;
		if (await stopIfBudgetReached()) {
			if (await stopIfOutputClosed()) return;
			await session.dispose();
			return;
		}
	}

	// From this point onward a late blocker must be recorded without starting a
	// primary turn whose response print mode would never emit.
	session.prepareForHeadlessAdvisorDrain();

	// In text mode, output final response.
	if (mode === "text" && !textOutputWritten) {
		await writeFinalAssistantText(session, printThoughts, writeStdout);
		if (await stopIfOutputClosed()) return;
	}

	await session.waitForAdvisorCatchup(PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS);

	// Ensure stdout, including late JSON advisor events, is fully flushed before returning.
	// This prevents race conditions where the process exits before all output is written.
	await new Promise<void>((resolve, reject) => {
		try {
			process.stdout.write("", err => {
				if (!err) {
					resolve();
				} else if (isBrokenPipeError(err)) {
					closeOutput();
					resolve();
				} else {
					reject(err);
				}
			});
		} catch (err) {
			if (!isBrokenPipeError(err)) {
				reject(err);
				return;
			}
			closeOutput();
			resolve();
		}
	});
	await outputAbort;
	await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
}

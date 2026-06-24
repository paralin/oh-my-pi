/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `omp -p "prompt"` - text output
 * - `omp --mode json "prompt"` - JSON event stream
 */
import type { AssistantMessage, ImageContent } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import scratchHandoffStopTemplate from "../prompts/system/scratch-handoff-stop.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

export interface ContextBudgetStopOptions {
	/** Stop when context usage reaches this percent of the selected model window. */
	stopAtPercent?: number;
	/** Stop when context usage reaches this token count. */
	stopAtTokens?: number;
	/** Write a generated handoff document here before stopping. */
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
	/** Optional headless guard that stops before the context window is exhausted. */
	contextBudgetStop?: ContextBudgetStopOptions;
}

function renderScratchHandoffStopPrompt(stop: ContextBudgetStop): string {
	const values: Record<string, string> = {
		contextTokens: String(stop.tokens),
		contextWindow: String(stop.contextWindow),
		limitTokens: String(stop.limitTokens),
		scratchHandoffFile: stop.scratchHandoffFile ?? "(not configured)",
	};
	return scratchHandoffStopTemplate.replaceAll(/{{([a-zA-Z0-9_]+)}}/g, (_match, key: string) => values[key] ?? "");
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

async function writeScratchHandoff(session: AgentSession, stop: ContextBudgetStop): Promise<string | undefined> {
	if (!stop.scratchHandoffFile) return undefined;
	const result = await session.handoff(renderScratchHandoffStopPrompt(stop));
	if (!result?.document) return undefined;
	await Bun.write(stop.scratchHandoffFile, `${result.document.trimEnd()}\n`, { createPath: true });
	return stop.scratchHandoffFile;
}

async function writeFinalAssistantText(session: AgentSession, printThoughts: boolean | undefined): Promise<void> {
	const state = session.state;
	const lastMessage = state.messages[state.messages.length - 1];

	if (lastMessage?.role !== "assistant") return;
	const assistantMsg = lastMessage as AssistantMessage;

	if ((assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") && !isSilentAbort(assistantMsg)) {
		const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
		await flushTelemetryExport();
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
			process.stdout.write(`${sanitizeText(content.text)}\n`);
		} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
			process.stdout.write(`${sanitizeText(content.thinking)}\n`);
		}
	}
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, contextBudgetStop } = options;
	let textOutputWritten = false;

	const stopIfBudgetReached = async (): Promise<boolean> => {
		const stop = resolveContextBudgetStop(session, contextBudgetStop);
		if (!stop) return false;
		if (mode === "text" && !textOutputWritten) {
			await writeFinalAssistantText(session, printThoughts);
			textOutputWritten = true;
		}
		const scratchPath = await writeScratchHandoff(session, stop);
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
			process.stdout.write(`${JSON.stringify(event)}\n`);
		} else if (scratchPath) {
			process.stderr.write(`Context budget stop: wrote scratch handoff to ${scratchPath}\n`);
		} else {
			process.stderr.write("Context budget stop: no scratch handoff file configured\n");
		}
		return true;
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			process.stdout.write(`${JSON.stringify(header)}\n`);
		}
	}
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
		if (mode === "json") {
			process.stdout.write(`${JSON.stringify(event)}\n`);
		}
	});

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
		if (await stopIfBudgetReached()) {
			await session.dispose();
			return;
		}
	}

	// Send remaining messages
	for (const message of messages) {
		await logger.time("print:prompt:next", () => session.prompt(message));
		if (await stopIfBudgetReached()) {
			await session.dispose();
			return;
		}
	}

	// In text mode, output final response
	if (mode === "text" && !textOutputWritten) {
		await writeFinalAssistantText(session, printThoughts);
	}

	// Ensure stdout is fully flushed before returning
	// This prevents race conditions where the process exits before all output is written
	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", err => {
			if (err) reject(err);
			else resolve();
		});
	});

	await session.dispose();
}

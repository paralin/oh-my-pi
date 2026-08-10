import type { Usage } from "@oh-my-pi/pi-ai";
import type { ActCancellationCapability } from "./act-cancellation";

export const ACT_EVENT_PROMPT_MAX_CHARS = 16_384;
export const ACT_EVENT_CELL_TEXT_MAX_CHARS = 65_536;
export const ACT_EVENT_ERROR_MAX_CHARS = 4096;

export interface ActEventModel {
	provider: string;
	id: string;
	name?: string;
}
interface ActEventBase {
	type: "act_event";
	actId: string;
	outerToolCallId: string;
	sequence: number;
}
export interface ActStartEvent extends ActEventBase {
	event: "start";
	prompt: string;
	promptTruncated: boolean;
	model: ActEventModel;
	thinkingLevel?: string;
	cancellationCapability: ActCancellationCapability;
}
export interface ActAssistantDeltaEvent extends ActEventBase {
	event: "assistant_delta";
	stream: "thinking" | "text";
	text: string;
	textTruncated: boolean;
}
export interface ActCellStartEvent extends ActEventBase {
	event: "cell_start";
	cellId: string;
	code: string;
	codeTruncated: boolean;
}
export interface ActCellTerminalEvent extends ActEventBase {
	event: "cell_terminal";
	cellId: string;
	durationMs?: number;
	status: "ok" | "error" | "cancelled";
	stdout: string;
	stdoutTruncated: boolean;
	stderr: string;
	stderrTruncated: boolean;
	result?: string;
	resultTruncated: boolean;
	error?: string;
	errorTruncated: boolean;
}
export interface ActTerminalEvent extends ActEventBase {
	event: "terminal";
	status: "done" | "cancelled" | "error";
	prompt: string;
	promptTruncated: boolean;
	model: ActEventModel;
	thinkingLevel?: string;
	cancellationCapability: ActCancellationCapability;
	usage: Usage;
	error?: string;
	errorTruncated: boolean;
}
export type ActProjectionEvent =
	| ActStartEvent
	| ActAssistantDeltaEvent
	| ActCellStartEvent
	| ActCellTerminalEvent
	| ActTerminalEvent;
export function truncateActEventText(text: string, maxChars: number): { text: string; truncated: boolean } {
	return text.length <= maxChars ? { text, truncated: false } : { text: text.slice(0, maxChars), truncated: true };
}

/** Compute a non-negative usage delta without mutating either snapshot. */
export function actUsageDelta(baseline: Usage, current: Usage): Usage {
	return {
		input: Math.max(0, current.input - baseline.input),
		output: Math.max(0, current.output - baseline.output),
		cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
		cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
		totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
		cost: {
			input: Math.max(0, current.cost.input - baseline.cost.input),
			output: Math.max(0, current.cost.output - baseline.cost.output),
			cacheRead: Math.max(0, current.cost.cacheRead - baseline.cost.cacheRead),
			cacheWrite: Math.max(0, current.cost.cacheWrite - baseline.cost.cacheWrite),
			total: Math.max(0, current.cost.total - baseline.cost.total),
		},
	};
}

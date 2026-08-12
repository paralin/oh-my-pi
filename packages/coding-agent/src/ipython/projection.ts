import { sanitizeText } from "@oh-my-pi/pi-utils";
import { truncateTailBytes } from "../session/streaming-output";
import { DEFAULT_MAX_BYTES, truncateHeadBytes } from "../session/streaming-output-constants";
import type {
	IpythonArtifactReference,
	IpythonCellOrigin,
	IpythonCellResult,
	IpythonCellText,
	IpythonCellUpdate,
} from "./cell";
import type { IpythonErrorEvent, IpythonExecutionEvent, IpythonHostOperationSummary } from "./controller";
import type { IpythonCellJournalDetail } from "./journal";
import type { IpythonStartupProgress } from "./provisioner";

function lineCount(text: string): number {
	if (!text) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) if (character === "\n") lines += 1;
	return lines;
}

function omittedLineCount(text: string, headBytes: number, tailBytes: number): number {
	const bytes = Buffer.from(text, "utf-8");
	let lines = 0;
	for (const byte of bytes.subarray(headBytes, bytes.length - tailBytes)) if (byte === 0x0a) lines += 1;
	return lines;
}

function truncationHeader(
	path: string,
	totalLines: number,
	totalBytes: number,
	omittedLines: number,
	omittedBytes: number,
): string {
	return `[Full IPython output: ${sanitizeText(path)}; ${totalLines} lines, ${totalBytes} bytes total; ${omittedLines} lines, ${omittedBytes} bytes omitted]\n`;
}

const PREVIEW_GAP = "\n[... IPython preview gap ...]\n";
const MIN_IPYTHON_PRESENTATION_BYTES = 32;

export type IpythonCellPresentationStatus = "running" | "ok" | "error" | "aborted";

/** One presentation-safe progress snapshot published by a nested host operation. */
export interface IpythonHostOperationProgress {
	readonly at: number;
	readonly message: string;
	readonly summary: IpythonHostOperationSummary | undefined;
}

/**
 * One nested host operation of a cell, folded from its ordered lifecycle
 * records. `progress` retains every published snapshot for journal and replay
 * diagnosis; `message` and `summary` remain the latest compact snapshot.
 */
export interface IpythonHostOperationPresentation {
	readonly operationId: string;
	readonly operation: string;
	readonly status: IpythonCellPresentationStatus;
	readonly startedAt: number;
	readonly durationMs: number | undefined;
	readonly progress: readonly IpythonHostOperationProgress[];
	readonly message: string | undefined;
	readonly summary: IpythonHostOperationSummary | undefined;
}

interface IpythonCellPresentationBase {
	readonly kind: "cell";
	readonly origin: IpythonCellOrigin;
	readonly code: string;
	readonly events: readonly IpythonExecutionEvent[];
	readonly errors: readonly IpythonErrorEvent[];
	readonly updates: readonly IpythonCellUpdate[];
	readonly startupProgress: readonly IpythonStartupProgress[];
	readonly operations: readonly IpythonHostOperationPresentation[];
	readonly safeText: IpythonCellText;
	readonly artifacts: readonly IpythonArtifactReference[];
}

export interface IpythonCompletedCellPresentation extends IpythonCellPresentationBase {
	readonly phase: "complete";
	readonly cellId: string;
	readonly executionId: string | undefined;
	readonly sequence: number;
	readonly authority: "trusted-cell";
	readonly status: "ok" | "error" | "aborted";
	readonly requestedAt: number;
	readonly startedAt: number | undefined;
	readonly finishedAt: number;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string | undefined;
}

export interface IpythonLiveCellPresentation extends IpythonCellPresentationBase {
	readonly phase: "live";
	readonly cellId: string | undefined;
	readonly status: "running";
}

export type IpythonCellPresentation = IpythonCompletedCellPresentation | IpythonLiveCellPresentation;

export interface IpythonLiveCellPresentationSource {
	readonly code: string;
	readonly origin: IpythonCellOrigin;
	readonly updates: readonly IpythonCellUpdate[];
}

function safeResultText(data: Readonly<Record<string, unknown>>): string {
	const plain = data["text/plain"];
	if (typeof plain === "string") return sanitizeText(plain);
	const mimeTypes = Object.keys(data).sort();
	return mimeTypes.length > 0 ? `[result MIME types: ${mimeTypes.join(", ")}]` : "[result data]";
}

function appendRecord(current: string, record: string): string {
	if (!record) return current;
	const separator = current && !current.endsWith("\n") ? "\n" : "";
	return `${current}${separator}${record}${record.endsWith("\n") ? "" : "\n"}`;
}

function renderIpythonExecutionEventText(event: IpythonExecutionEvent): string {
	if (event.kind === "stream") return sanitizeText(event.text);
	if (event.kind === "result") return safeResultText(event.data);
	if (event.kind === "display") return sanitizeText(event.text);
	// Sessions written before the nested lifecycle keep their flattened text.
	if (event.kind === "host_progress") return sanitizeText(`[${event.operation}] ${event.message}`);
	if (event.kind === "host_operation") return "";
	return sanitizeText(event.traceback.length > 0 ? event.traceback.join("\n") : `${event.ename}: ${event.evalue}`);
}

function executionSafeText(
	events: readonly IpythonExecutionEvent[],
	errors: readonly IpythonErrorEvent[],
	status: IpythonCellPresentationStatus,
): string {
	let text = "";
	let sawError = false;
	for (const event of events) {
		// Nested operations render as their own records, never as cell output.
		if (event.kind === "host_operation") continue;
		if (event.kind === "stream") {
			text += renderIpythonExecutionEventText(event);
			continue;
		}
		text = appendRecord(text, renderIpythonExecutionEventText(event));
		if (event.kind === "error") sawError = true;
	}
	if (!sawError) {
		for (const error of errors) text = appendRecord(text, renderIpythonExecutionEventText(error));
	}
	if (!text && status === "aborted") return "IPython cell aborted.\n";
	return text;
}

export function validateIpythonCellTextBudget(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= MIN_IPYTHON_PRESENTATION_BYTES) {
		throw new RangeError("IPython presentation-text budget is too small");
	}
}

export function createIpythonCellText(
	events: readonly IpythonExecutionEvent[],
	errors: readonly IpythonErrorEvent[],
	status: IpythonCellPresentationStatus,
	maxBytes = DEFAULT_MAX_BYTES,
	fullResultPath?: string,
): IpythonCellText {
	validateIpythonCellTextBudget(maxBytes);
	const text = executionSafeText(events, errors, status);
	const totalBytes = Buffer.byteLength(text, "utf-8");
	const totalLines = lineCount(text);
	if (totalBytes <= maxBytes) return { text, truncated: false, totalLines, totalBytes, outputBytes: totalBytes };
	if (!fullResultPath) {
		const head = truncateHeadBytes(text, Math.ceil((maxBytes - Buffer.byteLength(PREVIEW_GAP)) / 2));
		const tail = truncateTailBytes(text, Math.floor((maxBytes - Buffer.byteLength(PREVIEW_GAP)) / 2));
		return {
			text: `${head.text}${PREVIEW_GAP}${tail.text}`,
			truncated: true,
			totalLines,
			totalBytes,
			omittedLines: omittedLineCount(text, head.bytes, tail.bytes),
			omittedBytes: totalBytes - head.bytes - tail.bytes,
			outputBytes: head.bytes + Buffer.byteLength(PREVIEW_GAP) + tail.bytes,
		};
	}

	let omittedBytes = totalBytes;
	let omittedLines = totalLines;
	for (let attempt = 0; attempt < 5; attempt++) {
		const header = truncationHeader(fullResultPath, totalLines, totalBytes, omittedLines, omittedBytes);
		const fixedBytes = Buffer.byteLength(header) + Buffer.byteLength(PREVIEW_GAP);
		if (fixedBytes >= maxBytes) throw new RangeError("IPython presentation-text budget cannot fit the artifact path");
		const contentBytes = maxBytes - fixedBytes;
		const head = truncateHeadBytes(text, Math.ceil(contentBytes / 2));
		const tail = truncateTailBytes(text, Math.floor(contentBytes / 2));
		const nextOmittedBytes = totalBytes - head.bytes - tail.bytes;
		const nextOmittedLines = omittedLineCount(text, head.bytes, tail.bytes);
		if (nextOmittedBytes !== omittedBytes || nextOmittedLines !== omittedLines) {
			omittedBytes = nextOmittedBytes;
			omittedLines = nextOmittedLines;
			continue;
		}
		const output = `${header}${head.text}${PREVIEW_GAP}${tail.text}`;
		return {
			text: output,
			truncated: true,
			totalLines,
			totalBytes,
			omittedLines,
			omittedBytes,
			outputBytes: Buffer.byteLength(output),
		};
	}
	throw new Error("IPython output truncation did not converge");
}

/** Builds a bounded projection from incrementally retained presentation bytes. */
export function createIpythonCellTextFromBounds(
	headText: string,
	tailText: string,
	totalBytes: number,
	totalLines: number,
	totalNewlines: number,
	maxBytes: number,
	fullResultPath?: string,
): IpythonCellText {
	validateIpythonCellTextBudget(maxBytes);
	if (totalBytes <= maxBytes) {
		const text = truncateHeadBytes(headText, totalBytes).text;
		return { text, truncated: false, totalLines, totalBytes, outputBytes: totalBytes };
	}
	let omittedBytes = totalBytes;
	let omittedLines = totalNewlines;
	for (let attempt = 0; attempt < 5; attempt++) {
		const header = fullResultPath
			? truncationHeader(fullResultPath, totalLines, totalBytes, omittedLines, omittedBytes)
			: "";
		const fixedBytes = Buffer.byteLength(header) + Buffer.byteLength(PREVIEW_GAP);
		if (fixedBytes >= maxBytes) throw new RangeError("IPython presentation-text budget cannot fit the artifact path");
		const contentBytes = maxBytes - fixedBytes;
		const head = truncateHeadBytes(headText, Math.ceil(contentBytes / 2));
		const tail = truncateTailBytes(tailText, Math.floor(contentBytes / 2));
		const nextOmittedBytes = totalBytes - head.bytes - tail.bytes;
		const retainedNewlines = (head.text.match(/\n/g)?.length ?? 0) + (tail.text.match(/\n/g)?.length ?? 0);
		const nextOmittedLines = Math.max(0, totalNewlines - retainedNewlines);
		if (nextOmittedBytes !== omittedBytes || nextOmittedLines !== omittedLines) {
			omittedBytes = nextOmittedBytes;
			omittedLines = nextOmittedLines;
			continue;
		}
		const text = `${header}${head.text}${PREVIEW_GAP}${tail.text}`;
		return {
			text,
			truncated: true,
			totalLines,
			totalBytes,
			omittedLines,
			omittedBytes,
			outputBytes: Buffer.byteLength(text, "utf8"),
		};
	}
	throw new Error("IPython output truncation did not converge");
}

function startupProgress(updates: readonly IpythonCellUpdate[]): IpythonStartupProgress[] {
	return updates.flatMap(update => (update.kind === "startup" ? [update.progress] : []));
}

function sanitizeSummary(summary: IpythonHostOperationSummary): IpythonHostOperationSummary {
	return {
		...summary,
		...(summary.path === undefined ? {} : { path: sanitizeText(summary.path) }),
		...(summary.unit === undefined ? {} : { unit: sanitizeText(summary.unit) }),
	};
}

/**
 * Folds the ordered lifecycle records into one entry per host request, in the
 * order the requests started. Concurrent operations stay separate because each
 * record carries its own request identity.
 */
export function collectIpythonHostOperations(
	events: readonly IpythonExecutionEvent[],
): IpythonHostOperationPresentation[] {
	const byOperationId = new Map<string, { presentation: IpythonHostOperationPresentation; terminal: boolean }>();
	for (const event of events) {
		if (event.kind !== "host_operation") continue;
		const existing = byOperationId.get(event.operationId);
		// A replay truncated before terminal stays live; the first terminal is final.
		if ((event.phase === "start" && existing) || existing?.terminal) continue;
		const current = existing?.presentation ?? {
			operationId: event.operationId,
			operation: sanitizeText(event.operation),
			status: "running" as const,
			startedAt: event.at,
			durationMs: undefined,
			progress: [],
			message: undefined,
			summary: undefined,
		};
		const progress =
			event.phase === "progress" && event.message !== undefined
				? [
						...current.progress,
						{
							at: event.at,
							message: sanitizeText(event.message),
							summary: event.summary === undefined ? undefined : sanitizeSummary(event.summary),
						},
					]
				: current.progress;
		const presentation =
			event.phase === "progress"
				? {
						...current,
						progress,
						...(event.message === undefined ? {} : { message: sanitizeText(event.message) }),
						...(event.summary === undefined
							? {}
							: { summary: { ...current.summary, ...sanitizeSummary(event.summary) } }),
					}
				: event.phase === "terminal"
					? { ...current, status: event.status ?? "error", durationMs: event.durationMs }
					: current;
		byOperationId.set(event.operationId, { presentation, terminal: event.phase === "terminal" });
	}
	return [...byOperationId.values()].map(entry => entry.presentation);
}

/**
 * Orders the presentation-safe detail parts of one nested operation. Terminal
 * surfaces pass `displayPath` to shorten the recorded path for their width.
 */
export function ipythonHostOperationDetails(
	operation: Pick<IpythonHostOperationPresentation, "summary">,
	displayPath = operation.summary?.path,
): string[] {
	const details: string[] = [];
	const summary = operation.summary;
	if (displayPath) details.push(displayPath);
	if (summary?.count !== undefined) {
		details.push(summary.unit ? `${summary.count} ${summary.unit}` : String(summary.count));
	}
	if (summary?.dryRun !== undefined) details.push(summary.dryRun ? "dry run" : "applied");
	return details;
}

/** Formats one operation's safe semantic record for plain-text consumers. */
export function renderIpythonHostOperationText(operation: IpythonHostOperationPresentation): string {
	const details = ipythonHostOperationDetails(operation);
	const duration = operation.durationMs === undefined ? "" : ` (${operation.durationMs}ms)`;
	return `${operation.operation} · ${operation.status}${details.map(detail => ` · ${detail}`).join("")}${duration}`;
}

function completedText(source: IpythonCellResult | IpythonCellJournalDetail): IpythonCellText {
	if ("modelText" in source) return source.modelText;
	const text = sanitizeText(source.safeText);
	return {
		text,
		truncated: source.safeTextTruncated,
		totalLines: source.totalOutputLines ?? lineCount(text),
		totalBytes: source.totalOutputBytes,
		...(source.omittedOutputLines === undefined ? {} : { omittedLines: source.omittedOutputLines }),
		...(source.omittedOutputBytes === undefined ? {} : { omittedBytes: source.omittedOutputBytes }),
		outputBytes: Buffer.byteLength(text, "utf-8"),
	};
}

/** Projects a completed cell result or stored journal detail into one presentation record. */
export function projectIpythonCellPresentation(
	source: IpythonCellResult | IpythonCellJournalDetail,
): IpythonCompletedCellPresentation {
	return {
		kind: "cell",
		phase: "complete",
		cellId: source.cellId,
		executionId: source.executionId,
		sequence: source.sequence,
		origin: source.origin,
		authority: source.authority,
		code: source.code,
		status: source.status,
		requestedAt: source.requestedAt,
		startedAt: source.startedAt,
		finishedAt: source.finishedAt,
		durationMs: source.durationMs,
		stdout: source.stdout,
		stderr: source.stderr,
		result: source.result,
		events: source.events,
		errors: source.errors,
		updates: source.updates,
		startupProgress: startupProgress(source.updates),
		operations: collectIpythonHostOperations(source.events),
		safeText: completedText(source),
		artifacts: source.artifacts,
	};
}

/** Projects partial updates through the same event and safe-text rules as completed cells. */
export function projectIpythonLiveCellPresentation(
	source: IpythonLiveCellPresentationSource,
	maxBytes = DEFAULT_MAX_BYTES,
): IpythonLiveCellPresentation {
	const events = source.updates.flatMap(update => (update.kind === "execution" ? [update.event] : []));
	const errors = events.filter((event): event is IpythonErrorEvent => event.kind === "error");
	const artifacts = source.updates.flatMap(update => (update.kind === "artifact" ? [update.artifact] : []));
	const output = source.updates.findLast(update => update.kind === "output");
	const safeText = output?.modelText ?? createIpythonCellText(events, errors, "running", maxBytes);
	return {
		kind: "cell",
		phase: "live",
		cellId: source.updates[0]?.cellId,
		origin: source.origin,
		code: source.code,
		status: "running",
		events,
		errors,
		updates: source.updates,
		startupProgress: startupProgress(source.updates),
		operations: collectIpythonHostOperations(events),
		safeText,
		artifacts: safeText.truncated ? artifacts : [],
	};
}

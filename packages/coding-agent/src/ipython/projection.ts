import { sanitizeText } from "@oh-my-pi/pi-utils";
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

const TRUNCATION_MARKER = "\n[IPython output truncated]";
const MIN_IPYTHON_PRESENTATION_BYTES = Buffer.byteLength(TRUNCATION_MARKER, "utf-8");

export type IpythonCellPresentationStatus = "running" | "ok" | "error" | "aborted";

/**
 * One nested host operation of a cell, folded from its ordered lifecycle
 * records. Carries only operation identity, status, duration, and the
 * presentation-safe message and summary its handler published.
 */
export interface IpythonHostOperationPresentation {
	readonly operationId: string;
	readonly operation: string;
	readonly status: IpythonCellPresentationStatus;
	readonly startedAt: number;
	readonly durationMs: number | undefined;
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
): IpythonCellText {
	validateIpythonCellTextBudget(maxBytes);
	const text = executionSafeText(events, errors, status);
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes <= maxBytes) return { text, truncated: false, totalBytes, outputBytes: totalBytes };
	const head = truncateHeadBytes(text, maxBytes - MIN_IPYTHON_PRESENTATION_BYTES);
	const output = `${head.text}${TRUNCATION_MARKER}`;
	return {
		text: output,
		truncated: true,
		totalBytes,
		outputBytes: Buffer.byteLength(output, "utf-8"),
	};
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
			message: undefined,
			summary: undefined,
		};
		const presentation =
			event.phase === "progress"
				? {
						...current,
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
	operation: IpythonHostOperationPresentation,
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
		totalBytes: source.totalOutputBytes,
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
		safeText: createIpythonCellText(events, errors, "running", maxBytes),
		artifacts: [],
	};
}

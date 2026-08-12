import type { IpythonArtifactReference, IpythonCellNamespaceDelta, IpythonCellResult, IpythonCellUpdate } from "./cell";

export type { IpythonArtifactReference } from "./cell";

import type { IpythonErrorEvent, IpythonExecutionEvent, IpythonProcessIds } from "./controller";
import {
	type IpythonCompletedCellPresentation,
	projectIpythonCellPresentation,
	renderIpythonHostOperationText,
} from "./projection";

export const IPYTHON_JOURNAL_MESSAGE_TYPE = "ipython-cell";
export const IPYTHON_JOURNAL_VERSION = 1;

export interface IpythonCellJournalDetail {
	readonly version: typeof IPYTHON_JOURNAL_VERSION;
	readonly kind: "cell";
	readonly cellId: string;
	readonly executionId: string | undefined;
	readonly sequence: number;
	readonly origin: "model" | "direct";
	readonly authority: "trusted-cell";
	readonly code: string;
	readonly status: "ok" | "error" | "aborted";
	readonly requestedAt: number;
	readonly startedAt: number | undefined;
	readonly finishedAt: number;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly result: string | undefined;
	readonly events: readonly IpythonExecutionEvent[];
	readonly errors: readonly IpythonErrorEvent[];
	readonly updates: readonly IpythonCellUpdate[];
	readonly safeText: string;
	readonly safeTextTruncated: boolean;
	readonly totalOutputLines?: number;
	readonly totalOutputBytes: number;
	readonly omittedOutputLines?: number;
	readonly omittedOutputBytes?: number;
	readonly artifacts: readonly IpythonArtifactReference[];
	readonly namespaceDelta?: IpythonCellNamespaceDelta;
}

export interface IpythonLifecycleJournalDetail {
	readonly version: typeof IPYTHON_JOURNAL_VERSION;
	readonly kind: "lifecycle";
	readonly event: "startup" | "restart" | "restore" | "snapshot" | "artifact" | "history" | "control";
	readonly level: "info" | "warning";
	readonly message: string;
	readonly timestamp: number;
	readonly processIds?: IpythonProcessIds;
}

export type IpythonJournalDetail = IpythonCellJournalDetail | IpythonLifecycleJournalDetail;

export function createIpythonCellJournalDetail(
	result: IpythonCellResult | IpythonCompletedCellPresentation,
	artifacts: readonly IpythonArtifactReference[] = result.artifacts,
): IpythonCellJournalDetail {
	const safeText = "modelText" in result ? result.modelText : result.safeText;
	return {
		version: IPYTHON_JOURNAL_VERSION,
		kind: "cell",
		cellId: result.cellId,
		executionId: result.executionId,
		sequence: result.sequence,
		origin: result.origin,
		authority: result.authority,
		code: result.code,
		status: result.status,
		requestedAt: result.requestedAt,
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		durationMs: result.durationMs,
		stdout: result.stdout,
		stderr: result.stderr,
		result: result.result,
		events: [...result.events],
		errors: [...result.errors],
		updates: [...result.updates],
		safeText: safeText.text,
		safeTextTruncated: safeText.truncated,
		totalOutputLines: safeText.totalLines,
		totalOutputBytes: safeText.totalBytes,
		...(safeText.omittedLines === undefined ? {} : { omittedOutputLines: safeText.omittedLines }),
		...(safeText.omittedBytes === undefined ? {} : { omittedOutputBytes: safeText.omittedBytes }),
		artifacts: [...artifacts],
		...("namespaceDelta" in result && result.namespaceDelta ? { namespaceDelta: result.namespaceDelta } : {}),
	};
}

export function createIpythonLifecycleJournalDetail(
	event: IpythonLifecycleJournalDetail["event"],
	level: IpythonLifecycleJournalDetail["level"],
	message: string,
	processIds?: IpythonProcessIds,
): IpythonLifecycleJournalDetail {
	return {
		version: IPYTHON_JOURNAL_VERSION,
		kind: "lifecycle",
		event,
		level,
		message,
		timestamp: Date.now(),
		...(processIds ? { processIds } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isErrorEvent(value: unknown): value is IpythonErrorEvent {
	return (
		isRecord(value) &&
		value.kind === "error" &&
		typeof value.ename === "string" &&
		typeof value.evalue === "string" &&
		isStringArray(value.traceback)
	);
}

function isHostOperationSummary(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value);
	return (
		keys.length > 0 &&
		keys.every(key => ["path", "count", "unit", "dryRun"].includes(key)) &&
		(value.path === undefined || (typeof value.path === "string" && value.path.length <= 200)) &&
		(value.count === undefined ||
			(typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count >= 0)) &&
		(value.unit === undefined || (typeof value.unit === "string" && value.unit.length <= 32)) &&
		(value.dryRun === undefined || typeof value.dryRun === "boolean")
	);
}

function isHostOperationEvent(value: Record<string, unknown>): boolean {
	const phase = value.phase;
	if (
		!Object.keys(value).every(key =>
			["kind", "operationId", "operation", "phase", "at", "status", "durationMs", "message", "summary"].includes(
				key,
			),
		) ||
		typeof value.operationId !== "string" ||
		value.operationId.length === 0 ||
		value.operationId.length > 200 ||
		typeof value.operation !== "string" ||
		value.operation.length === 0 ||
		value.operation.length > 200 ||
		(phase !== "start" && phase !== "progress" && phase !== "terminal") ||
		!Number.isSafeInteger(value.at)
	) {
		return false;
	}
	if (phase === "start") {
		return (
			value.status === undefined &&
			value.durationMs === undefined &&
			value.message === undefined &&
			value.summary === undefined
		);
	}
	if (phase === "progress") {
		return (
			value.status === undefined &&
			value.durationMs === undefined &&
			typeof value.message === "string" &&
			value.message.length > 0 &&
			value.message.length <= 4_000 &&
			(value.summary === undefined || isHostOperationSummary(value.summary))
		);
	}
	return (
		(value.status === "ok" || value.status === "error" || value.status === "aborted") &&
		typeof value.durationMs === "number" &&
		Number.isSafeInteger(value.durationMs) &&
		value.durationMs >= 0 &&
		value.message === undefined &&
		value.summary === undefined
	);
}

function isExecutionEvent(value: unknown): value is IpythonExecutionEvent {
	if (!isRecord(value)) return false;
	if (value.kind === "stream") {
		return (value.name === "stdout" || value.name === "stderr") && typeof value.text === "string";
	}
	if (value.kind === "result") return isRecord(value.data);
	if (value.kind === "display") {
		return (
			isRecord(value.data) &&
			isRecord(value.metadata) &&
			isRecord(value.transient) &&
			typeof value.update === "boolean" &&
			typeof value.text === "string"
		);
	}
	if (value.kind === "host_progress") {
		return typeof value.operation === "string" && typeof value.message === "string" && isRecord(value.data);
	}
	if (value.kind === "host_operation") return isHostOperationEvent(value);
	return isErrorEvent(value);
}

function isStoredUpdate(value: unknown): boolean {
	if (
		!isRecord(value) ||
		typeof value.cellId !== "string" ||
		(value.origin !== "model" && value.origin !== "direct")
	) {
		return false;
	}
	if (value.kind === "startup") {
		return (
			isRecord(value.progress) &&
			["gate", "runtime", "controller", "restore", "bootstrap", "ready"].includes(String(value.progress.stage)) &&
			typeof value.progress.message === "string"
		);
	}
	if (value.kind === "artifact") return isArtifactReference(value.artifact);
	if (value.kind === "output") {
		const modelText = value.modelText;
		return (
			isRecord(modelText) &&
			typeof modelText.text === "string" &&
			typeof modelText.truncated === "boolean" &&
			Number.isSafeInteger(modelText.totalBytes) &&
			Number.isSafeInteger(modelText.outputBytes) &&
			(modelText.totalLines === undefined || Number.isSafeInteger(modelText.totalLines)) &&
			(modelText.omittedLines === undefined || Number.isSafeInteger(modelText.omittedLines)) &&
			(modelText.omittedBytes === undefined || Number.isSafeInteger(modelText.omittedBytes))
		);
	}
	return value.kind === "execution" && isExecutionEvent(value.event);
}

function isArtifactReference(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.id === undefined || typeof value.id === "string") &&
		typeof value.path === "string" &&
		(value.mimeType === undefined || typeof value.mimeType === "string") &&
		(value.bytes === undefined || typeof value.bytes === "number") &&
		(value.label === undefined || typeof value.label === "string")
	);
}

function isNamespaceEntry(value: unknown): boolean {
	return isRecord(value) && typeof value.name === "string" && typeof value.type === "string";
}

function isNamespaceDelta(value: unknown): boolean {
	if (!isRecord(value) || (value.origin !== "model" && value.origin !== "direct")) return false;
	if (!Number.isSafeInteger(value.executionCount)) return false;
	if (
		![value.added, value.rebound, value.deleted].every(items => Array.isArray(items) && items.every(isNamespaceEntry))
	)
		return false;
	if (!isRecord(value.omitted)) return false;
	return [value.omitted.added, value.omitted.rebound, value.omitted.deleted].every(
		count => typeof count === "number" && Number.isSafeInteger(count) && count >= 0,
	);
}

export function isIpythonJournalDetail(value: unknown): value is IpythonJournalDetail {
	if (!isRecord(value) || value.version !== IPYTHON_JOURNAL_VERSION) return false;
	if (value.kind === "lifecycle") {
		return (
			["startup", "restart", "restore", "snapshot", "artifact", "history", "control"].includes(
				String(value.event),
			) &&
			(value.level === "info" || value.level === "warning") &&
			typeof value.message === "string" &&
			typeof value.timestamp === "number" &&
			(value.processIds === undefined ||
				(isRecord(value.processIds) &&
					typeof value.processIds.controllerPid === "number" &&
					typeof value.processIds.kernelPid === "number"))
		);
	}
	return (
		value.kind === "cell" &&
		typeof value.cellId === "string" &&
		(value.executionId === undefined || typeof value.executionId === "string") &&
		typeof value.sequence === "number" &&
		(value.origin === "model" || value.origin === "direct") &&
		value.authority === "trusted-cell" &&
		typeof value.code === "string" &&
		(value.status === "ok" || value.status === "error" || value.status === "aborted") &&
		typeof value.requestedAt === "number" &&
		(value.startedAt === undefined || typeof value.startedAt === "number") &&
		typeof value.finishedAt === "number" &&
		typeof value.durationMs === "number" &&
		typeof value.stdout === "string" &&
		typeof value.stderr === "string" &&
		(value.result === undefined || typeof value.result === "string") &&
		typeof value.safeText === "string" &&
		typeof value.safeTextTruncated === "boolean" &&
		(value.totalOutputLines === undefined ||
			(typeof value.totalOutputLines === "number" &&
				Number.isSafeInteger(value.totalOutputLines) &&
				value.totalOutputLines >= 0)) &&
		(value.omittedOutputLines === undefined ||
			(typeof value.omittedOutputLines === "number" &&
				Number.isSafeInteger(value.omittedOutputLines) &&
				value.omittedOutputLines >= 0)) &&
		typeof value.totalOutputBytes === "number" &&
		(value.omittedOutputBytes === undefined ||
			(typeof value.omittedOutputBytes === "number" &&
				Number.isSafeInteger(value.omittedOutputBytes) &&
				value.omittedOutputBytes >= 0 &&
				value.omittedOutputBytes <= value.totalOutputBytes)) &&
		Array.isArray(value.events) &&
		value.events.every(isExecutionEvent) &&
		Array.isArray(value.errors) &&
		value.errors.every(isErrorEvent) &&
		Array.isArray(value.updates) &&
		value.updates.every(isStoredUpdate) &&
		Array.isArray(value.artifacts) &&
		value.artifacts.every(isArtifactReference) &&
		(value.namespaceDelta === undefined || isNamespaceDelta(value.namespaceDelta))
	);
}

export function renderIpythonJournalText(detail: IpythonJournalDetail): string {
	if (detail.kind === "lifecycle") return `IPython ${detail.event}: ${detail.message}`;
	const presentation = projectIpythonCellPresentation(detail);
	const lines = [
		`IPython cell ${presentation.sequence} (${presentation.origin}, ${presentation.status}, ${presentation.durationMs}ms)`,
		"```python",
		presentation.code,
		"```",
	];
	if (presentation.safeText.text) lines.push("```text", presentation.safeText.text, "```");
	for (const operation of presentation.operations) {
		lines.push(
			`Operation: ${renderIpythonHostOperationText(operation)}${operation.message ? ` · ${operation.message}` : ""}`,
		);
	}
	for (const artifact of presentation.artifacts) {
		const label = artifact.label ? `${artifact.label} · ` : "";
		lines.push(`Artifact: ${label}${artifact.path}${artifact.mimeType ? ` (${artifact.mimeType})` : ""}`);
	}
	if (presentation.safeText.truncated) {
		const omitted = presentation.safeText.omittedBytes;
		lines.push(
			omitted === undefined
				? `Output truncated from ${presentation.safeText.totalBytes} bytes.`
				: `Output truncated from ${presentation.safeText.totalBytes} bytes; ${omitted} bytes omitted.`,
		);
	}
	return lines.join("\n");
}

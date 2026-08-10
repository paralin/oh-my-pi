import type { IpythonArtifactReference, IpythonCellResult, IpythonCellUpdate } from "./cell";

export type { IpythonArtifactReference } from "./cell";

import type { IpythonErrorEvent, IpythonExecutionEvent, IpythonProcessIds } from "./controller";
import { type IpythonCompletedCellPresentation, projectIpythonCellPresentation } from "./projection";

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
	readonly totalOutputBytes: number;
	readonly artifacts: readonly IpythonArtifactReference[];
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
		totalOutputBytes: safeText.totalBytes,
		artifacts: [...artifacts],
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
		typeof value.totalOutputBytes === "number" &&
		Array.isArray(value.events) &&
		value.events.every(isExecutionEvent) &&
		Array.isArray(value.errors) &&
		value.errors.every(isErrorEvent) &&
		Array.isArray(value.updates) &&
		value.updates.every(isStoredUpdate) &&
		Array.isArray(value.artifacts) &&
		value.artifacts.every(isArtifactReference)
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
	for (const artifact of presentation.artifacts) {
		lines.push(`Artifact: ${artifact.label ?? artifact.path}${artifact.mimeType ? ` (${artifact.mimeType})` : ""}`);
	}
	if (presentation.safeText.truncated) {
		lines.push(`Output truncated from ${presentation.safeText.totalBytes} bytes.`);
	}
	return lines.join("\n");
}

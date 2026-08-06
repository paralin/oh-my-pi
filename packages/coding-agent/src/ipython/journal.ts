import type { IpythonArtifactReference, IpythonCellResult, IpythonCellUpdate } from "./cell";

export type { IpythonArtifactReference } from "./cell";

import type { IpythonErrorEvent, IpythonExecutionEvent, IpythonProcessIds } from "./controller";

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
	result: IpythonCellResult,
	artifacts: readonly IpythonArtifactReference[] = result.artifacts,
): IpythonCellJournalDetail {
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
		safeText: result.modelText.text,
		safeTextTruncated: result.modelText.truncated,
		totalOutputBytes: result.modelText.totalBytes,
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
			typeof value.progress.stage === "string" &&
			typeof value.progress.message === "string"
		);
	}
	return value.kind === "execution" && isRecord(value.event) && typeof value.event.kind === "string";
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
		typeof value.sequence === "number" &&
		(value.origin === "model" || value.origin === "direct") &&
		value.authority === "trusted-cell" &&
		typeof value.code === "string" &&
		(value.status === "ok" || value.status === "error" || value.status === "aborted") &&
		typeof value.durationMs === "number" &&
		typeof value.safeText === "string" &&
		typeof value.safeTextTruncated === "boolean" &&
		Array.isArray(value.events) &&
		Array.isArray(value.errors) &&
		Array.isArray(value.updates) &&
		value.updates.every(isStoredUpdate) &&
		Array.isArray(value.artifacts) &&
		value.artifacts.every(isArtifactReference)
	);
}

export function renderIpythonJournalText(detail: IpythonJournalDetail): string {
	if (detail.kind === "lifecycle") return `IPython ${detail.event}: ${detail.message}`;
	const lines = [
		`IPython cell ${detail.sequence} (${detail.origin}, ${detail.status}, ${detail.durationMs}ms)`,
		"```python",
		detail.code,
		"```",
	];
	if (detail.safeText) lines.push("```text", detail.safeText, "```");
	for (const artifact of detail.artifacts) {
		lines.push(`Artifact: ${artifact.label ?? artifact.path}${artifact.mimeType ? ` (${artifact.mimeType})` : ""}`);
	}
	if (detail.safeTextTruncated) lines.push(`Output truncated from ${detail.totalOutputBytes} bytes.`);
	return lines.join("\n");
}

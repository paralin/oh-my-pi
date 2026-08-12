import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, type IpythonJournalDetail, isIpythonJournalDetail } from "../ipython/journal";
import { projectIpythonCellPresentation, renderIpythonHostOperationText } from "../ipython/projection";
import { DEFAULT_MAX_BYTES, truncateHeadBytes } from "./streaming-output-constants";

const IPYTHON_SUMMARY_TRUNCATION_MARKER = "[IPython summary truncated]";
const IPYTHON_SUMMARY_CODE_BYTES = 12 * 1024;
const IPYTHON_SUMMARY_OUTPUT_BYTES = 24 * 1024;
const IPYTHON_SUMMARY_ARTIFACT_BYTES = 1024;
const IPYTHON_SUMMARY_ARTIFACTS = 8;
const IPYTHON_SUMMARY_OPERATION_BYTES = 1024;
const IPYTHON_SUMMARY_OPERATIONS = 8;

function boundedSection(text: string, maxBytes: number, marker: string): string {
	if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
	const suffix = `
[${marker} truncated]`;
	return `${truncateHeadBytes(text, maxBytes - Buffer.byteLength(suffix, "utf-8")).text}${suffix}`;
}

export function renderBoundedIpythonJournalSummary(detail: IpythonJournalDetail, maxBytes = DEFAULT_MAX_BYTES): string {
	const effectiveMaxBytes = Number.isFinite(maxBytes) ? Math.max(1024, Math.floor(maxBytes)) : DEFAULT_MAX_BYTES;
	if (detail.kind === "lifecycle") {
		return boundedSection(`IPython ${detail.event}: ${detail.message}`, effectiveMaxBytes, "IPython summary");
	}
	const presentation = projectIpythonCellPresentation(detail);
	const lines = [
		`IPython cell ${presentation.sequence} (${presentation.origin}, ${presentation.status}, ${presentation.durationMs}ms)`,
		"```python",
		boundedSection(presentation.code, IPYTHON_SUMMARY_CODE_BYTES, "code"),
		"```",
	];
	if (presentation.safeText.text) {
		lines.push("```text", boundedSection(presentation.safeText.text, IPYTHON_SUMMARY_OUTPUT_BYTES, "output"), "```");
	}
	for (const operation of presentation.operations.slice(0, IPYTHON_SUMMARY_OPERATIONS)) {
		const text = `Operation: ${renderIpythonHostOperationText(operation)}${operation.message ? ` · ${operation.message}` : ""}`;
		lines.push(boundedSection(text, IPYTHON_SUMMARY_OPERATION_BYTES, "operation"));
	}
	if (presentation.operations.length > IPYTHON_SUMMARY_OPERATIONS) {
		lines.push(`[${presentation.operations.length - IPYTHON_SUMMARY_OPERATIONS} more operations omitted]`);
	}
	for (const artifact of presentation.artifacts.slice(0, IPYTHON_SUMMARY_ARTIFACTS)) {
		const label = artifact.label ? `${artifact.label} · ` : "";
		const reference = `Artifact: ${label}${artifact.path}${artifact.mimeType ? ` (${artifact.mimeType})` : ""}`;
		lines.push(boundedSection(reference, IPYTHON_SUMMARY_ARTIFACT_BYTES, "artifact reference"));
	}
	if (presentation.artifacts.length > IPYTHON_SUMMARY_ARTIFACTS) {
		lines.push(`[${presentation.artifacts.length - IPYTHON_SUMMARY_ARTIFACTS} more artifacts omitted]`);
	}
	if (presentation.safeText.truncated) lines.push(`Output truncated from ${presentation.safeText.totalBytes} bytes.`);
	const text = lines.join("\n");
	if (Buffer.byteLength(text, "utf-8") <= effectiveMaxBytes) return text;
	const suffix = `
${IPYTHON_SUMMARY_TRUNCATION_MARKER}`;
	return `${truncateHeadBytes(text, effectiveMaxBytes - Buffer.byteLength(suffix, "utf-8")).text}${suffix}`;
}

/**
 * Project a typed IPython journal message into bounded text for summary-only
 * consumers. The ordinary provider transcript keeps the stored custom message
 * unchanged; advisors, compaction, and handoff opt into this projection.
 */
export function projectIpythonJournalSummaryMessage(message: AgentMessage, maxBytes = DEFAULT_MAX_BYTES): AgentMessage {
	if (
		(message.role !== "custom" && message.role !== "hookMessage") ||
		message.customType !== IPYTHON_JOURNAL_MESSAGE_TYPE ||
		!isIpythonJournalDetail(message.details)
	) {
		return message;
	}
	return {
		role: "user",
		content: [{ type: "text", text: renderBoundedIpythonJournalSummary(message.details, maxBytes) }],
		attribution: message.attribution ?? "agent",
		timestamp: message.timestamp,
	};
}

/** Preserve ordering and identity for every message that needs no projection. */
export function projectIpythonJournalSummaryMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.map(projectIpythonJournalSummaryMessage);
}

/**
 * Join journal-only cells into a live primary transcript without replacing a
 * just-completed turn that has not reached the session file yet.
 */
export function mergeIpythonJournalSummaryMessages(
	liveMessages: readonly AgentMessage[],
	journalMessages: readonly AgentMessage[],
): AgentMessage[] {
	const combined = [
		...liveMessages
			.filter(
				message =>
					(message.role !== "custom" && message.role !== "hookMessage") ||
					message.customType !== IPYTHON_JOURNAL_MESSAGE_TYPE,
			)
			.map((message, order) => ({ message, order })),
		...journalMessages
			.filter(
				message =>
					(message.role === "custom" || message.role === "hookMessage") &&
					message.customType === IPYTHON_JOURNAL_MESSAGE_TYPE &&
					isIpythonJournalDetail(message.details),
			)
			.map((message, index) => ({
				message: projectIpythonJournalSummaryMessage(message),
				order: liveMessages.length + index,
			})),
	];
	combined.sort((left, right) => left.message.timestamp - right.message.timestamp || left.order - right.order);
	return combined.map(entry => entry.message);
}

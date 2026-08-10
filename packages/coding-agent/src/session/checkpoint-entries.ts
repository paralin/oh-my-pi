import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { stringProperty } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./session-entries";

/** State retained while an IPython checkpoint can still be rewound. */
export interface CheckpointState {
	/** Session entry ID that anchors the checkpoint branch and kernel snapshot. */
	checkpointEntryId: string;
	/** Timestamp when the checkpoint was created. */
	startedAt: string;
}

/** State retained after an IPython checkpoint has been rewound. */
export interface CompletedRewindState {
	/** Report retained after a successful rewind. */
	report: string;
	/** Timestamp for the checkpoint that was rewound. */
	startedAt: string;
	/** Timestamp when the rewind completed. */
	rewoundAt: string;
}

/** Extracts text from custom message content. */
export function customMessageContentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const part of content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/** Extracts the report body from persisted rewind-report content. */
export function reportFromRewindReportContent(content: string): string {
	const marker = "\nReport:\n";
	const index = content.lastIndexOf(marker);
	const report = index >= 0 ? content.slice(index + marker.length) : content;
	return report.trim();
}

/** Restores a pending IPython checkpoint from its persisted session entry. */
export function checkpointStateFromEntry(entry: SessionEntry): CheckpointState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "ipython-checkpoint") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	return startedAt ? { checkpointEntryId: entry.id, startedAt } : undefined;
}

/** Restores completed rewind state from a persisted session entry. */
export function completedRewindFromEntry(entry: SessionEntry): CompletedRewindState | undefined {
	if (entry.type !== "custom_message" || entry.customType !== "rewind-report") return undefined;
	const details = entry.details;
	if (!details || typeof details !== "object") return undefined;
	const startedAt = stringProperty(details, "startedAt");
	const rewoundAt = stringProperty(details, "rewoundAt");
	if (!startedAt || !rewoundAt) return undefined;
	const report =
		stringProperty(details, "report")?.trim() ||
		reportFromRewindReportContent(customMessageContentText(entry.content));
	return report.length > 0 ? { report, startedAt, rewoundAt } : undefined;
}

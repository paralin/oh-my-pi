import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { IpythonCompletedCellPresentation } from "./projection";

const MAX_CAPABILITY_OPERATIONS = 16;
const MAX_CAPABILITY_OPERATION_CHARS = 128;

export interface IpythonCellTelemetryRecord {
	readonly toolName: "ipython";
	readonly status: "ok" | "error" | "aborted";
	readonly durationMs: number;
	readonly capabilityOperations: readonly string[];
}

/** Projects one completed model cell into bounded provider-tool telemetry facets. */
export function createIpythonCellTelemetryRecord(
	presentation: IpythonCompletedCellPresentation,
): IpythonCellTelemetryRecord {
	const operations: string[] = [];
	const seen = new Set<string>();
	for (const event of presentation.events) {
		if (event.kind !== "host_operation" && event.kind !== "host_progress") continue;
		const operation = sanitizeText(event.operation).slice(0, MAX_CAPABILITY_OPERATION_CHARS).trim();
		if (!operation || seen.has(operation)) continue;
		seen.add(operation);
		operations.push(operation);
		if (operations.length === MAX_CAPABILITY_OPERATIONS) break;
	}
	return {
		toolName: "ipython",
		status: presentation.status,
		durationMs: presentation.durationMs,
		capabilityOperations: operations,
	};
}

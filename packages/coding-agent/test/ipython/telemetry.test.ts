import { describe, expect, test } from "bun:test";
import type { IpythonExecutionEvent } from "../../src/ipython/controller";
import type { IpythonCompletedCellPresentation } from "../../src/ipython/projection";
import { createIpythonCellTelemetryRecord } from "../../src/ipython/telemetry";
import { createActTelemetryRecord, recordIpythonCellTelemetry } from "../../src/telemetry-export";

function presentation(origin: "model" | "direct"): IpythonCompletedCellPresentation {
	const events: IpythonExecutionEvent[] = Array.from({ length: 20 }, (_, index) => ({
		kind: "host_progress" as const,
		operation: index === 19 ? "omp.duplicate" : `omp.${index}.${"x".repeat(160)}`,
		message: `progress ${index}`,
		data: {},
	}));
	events.push({ kind: "host_progress", operation: "omp.duplicate", message: "again", data: {} });
	return {
		kind: "cell",
		phase: "complete",
		cellId: `cell-${origin}`,
		executionId: `execute-${origin}`,
		sequence: 1,
		origin,
		authority: "trusted-cell",
		code: "pass",
		status: "ok",
		requestedAt: 1,
		startedAt: 2,
		finishedAt: 12,
		durationMs: 10,
		stdout: "",
		stderr: "",
		result: undefined,
		events,
		errors: [],
		updates: [],
		startupProgress: [],
		safeText: { text: "", truncated: false, totalBytes: 0, outputBytes: 0 },
		artifacts: [],
	};
}

describe("IPython telemetry projection", () => {
	test("counts one model cell as ipython and bounds capability operations without promoting them to tools", () => {
		const projected = createIpythonCellTelemetryRecord(presentation("model"));
		expect(projected).toMatchObject({ toolName: "ipython", status: "ok", durationMs: 10 });
		expect(projected.capabilityOperations).toHaveLength(16);
		expect(projected.capabilityOperations.every(operation => operation.length <= 128)).toBe(true);
		expect(new Set(projected.capabilityOperations).size).toBe(projected.capabilityOperations.length);
		expect(projected.capabilityOperations).not.toContain("ipython");
		expect(recordIpythonCellTelemetry(presentation("model"))).toEqual(projected);
	});

	test("does not count an operator-owned direct cell as a provider tool", () => {
		expect(recordIpythonCellTelemetry(presentation("direct"))).toBeUndefined();
	});
	test("projects Act telemetry as status, model, and usage only", () => {
		const record = createActTelemetryRecord({
			type: "act_event",
			actId: "act-telemetry",
			outerToolCallId: "cell-root",
			sequence: 5,
			event: "terminal",
			status: "done",
			prompt: "private prompt",
			promptTruncated: false,
			model: { provider: "test", id: "actor", name: "private alias" },
			cancellationCapability: "posix-managed",
			usage: {
				input: 2,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			error: "private output",
			errorTruncated: false,
		});
		expect(record).toEqual({
			status: "done",
			model: { provider: "test", id: "actor" },
			usage: {
				input: 2,
				output: 3,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		expect(JSON.stringify(record)).not.toContain("private");
	});
});

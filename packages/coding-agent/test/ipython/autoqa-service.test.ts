import { describe, expect, test } from "bun:test";
import { type IpythonAutoQaReportOwner, IpythonAutoQaService } from "../../src/ipython/autoqa-service";
import type { IpythonHostRequest } from "../../src/ipython/controller";

function hostRequest(data: Readonly<Record<string, unknown>>, signal = new AbortController().signal) {
	const progress: Array<{ message: string; data: Readonly<Record<string, unknown>> | undefined }> = [];
	const request: IpythonHostRequest = {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data: { type: "qa.report_issue", ...data },
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async (message, data) => {
			progress.push({ message, data });
		},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("Auto-QA does not allocate artifacts");
		},
	};
	return { request, progress };
}

function owner(capture: Array<{ tool: string; report: string; signal: AbortSignal }>): IpythonAutoQaReportOwner {
	return {
		reportIssue: async input => {
			capture.push(input);
			return { status: "recorded", pushed: 0, pushOk: false, pushSkipped: true };
		},
	};
}

describe("IPython Auto-QA service", () => {
	test("calls only the narrow report owner with bounded typed data and progress", async () => {
		const calls: Array<{ tool: string; report: string; signal: AbortSignal }> = [];
		const service = new IpythonAutoQaService({ owner: owner(calls) });
		const active = hostRequest({ tool: " read ", report: " trailing selector dropped " });
		const result = await service.handlers["qa.report_issue"]!(active.request);
		expect(calls).toEqual([{ tool: "read", report: "trailing selector dropped", signal: active.request.signal }]);
		expect(result).toEqual({ outcome: "recorded", pushed: 0, push_ok: false, push_skipped: true });
		expect(active.progress.map(event => event.message)).toEqual([
			"Auto-QA report started",
			"Auto-QA report completed",
		]);
	});

	test("rejects unknown, empty, and oversized input before calling an owner", async () => {
		const calls: Array<{ tool: string; report: string; signal: AbortSignal }> = [];
		const service = new IpythonAutoQaService({ owner: owner(calls) });
		await expect(
			service.handlers["qa.report_issue"]!(hostRequest({ tool: "read", report: "x", extra: true }).request),
		).rejects.toThrow("unknown field: extra");
		await expect(
			service.handlers["qa.report_issue"]!(hostRequest({ tool: "", report: "x" }).request),
		).rejects.toThrow("tool must be a nonempty string");
		await expect(
			service.handlers["qa.report_issue"]!(hostRequest({ tool: "read", report: "x".repeat(16_385) }).request),
		).rejects.toThrow("report is too large");
		expect(calls).toHaveLength(0);
	});

	test("honors cancellation before reaching the report owner", async () => {
		const calls: Array<{ tool: string; report: string; signal: AbortSignal }> = [];
		const service = new IpythonAutoQaService({ owner: owner(calls) });
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			service.handlers["qa.report_issue"]!(hostRequest({ tool: "read", report: "x" }, controller.signal).request),
		).rejects.toThrow("cancelled");
		expect(calls).toHaveLength(0);
	});
});

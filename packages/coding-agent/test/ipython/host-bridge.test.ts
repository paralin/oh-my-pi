import { describe, expect, test } from "bun:test";
import type {
	IpythonDisplayEvent,
	IpythonHostArtifactRequest,
	IpythonHostProgressEvent,
	IpythonHostRequest,
} from "../../src/ipython/controller.js";
import { composeIpythonHostHandlers, createFoundationalIpythonHostHandlers } from "../../src/ipython/host-bridge.js";

function request(
	data: Readonly<Record<string, unknown>>,
	progress: IpythonHostProgressEvent[],
	displays: IpythonDisplayEvent[],
): IpythonHostRequest {
	return {
		requestId: "execution-1",
		executionId: "execution-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal: new AbortController().signal,
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 3,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async (message, eventData = {}) => {
			progress.push({ kind: "host_progress", operation: String(data.type), message, data: eventData });
		},
		publishDisplay: async display => {
			displays.push({ ...display, kind: "display" });
		},
		allocateArtifact: async (artifact: IpythonHostArtifactRequest) => ({
			id: "artifact-1",
			path: `/sidecar/artifact${artifact.suffix}`,
			label: artifact.label,
			mimeType: artifact.mimeType,
			bytes: 0,
		}),
	};
}

describe("IPython host handler composition", () => {
	test("rejects reserved and duplicate operation names without a generic tool bridge", () => {
		expect(() => composeIpythonHostHandlers({ "tool.call": () => ({}) })).toThrow("reserved");
		expect(() => composeIpythonHostHandlers({ duplicate: () => ({}) }, { duplicate: () => ({}) })).toThrow(
			"duplicate IPython host operation",
		);
		expect(() => composeIpythonHostHandlers({ " not-trimmed": () => ({}) })).toThrow("trimmed");
	});

	test("publishes bounded cell state through focused foundational operations", async () => {
		const handlers = createFoundationalIpythonHostHandlers();
		const progress: IpythonHostProgressEvent[] = [];
		const displays: IpythonDisplayEvent[] = [];
		const info = await handlers["session.info"]?.(request({ type: "session.info" }, progress, displays));
		expect(info).toEqual({
			sessionId: "session-1",
			cwd: "/workspace",
			cellId: "cell-1",
			sequence: 3,
			origin: "model",
			authority: "trusted-cell",
		});
		await handlers["cell.progress"]?.(
			request({ type: "cell.progress", message: "searching", data: { step: 1 } }, progress, displays),
		);
		expect(progress).toEqual([
			{ kind: "host_progress", operation: "cell.progress", message: "searching", data: { step: 1 } },
		]);
		await handlers["cell.display"]?.(
			request(
				{
					type: "cell.display",
					data: { "text/html": "<script>unsafe()</script>", "application/json": { step: 1 } },
					metadata: { source: "test" },
				},
				progress,
				displays,
			),
		);
		expect(displays).toEqual([
			{
				kind: "display",
				data: { "text/html": "<script>unsafe()</script>", "application/json": { step: 1 } },
				metadata: { source: "test" },
				transient: {},
				update: false,
				text: "[displayed MIME types: application/json, text/html]",
			},
		]);
		expect(displays[0]?.text).not.toContain("<script>");
		const allocated = await handlers["artifact.allocate"]?.(
			request(
				{ type: "artifact.allocate", label: "report", mimeType: "application/json", suffix: ".json" },
				progress,
				displays,
			),
		);
		expect(allocated).toEqual({
			artifact: {
				id: "artifact-1",
				path: "/sidecar/artifact.json",
				label: "report",
				mimeType: "application/json",
				bytes: 0,
			},
		});
	});
});

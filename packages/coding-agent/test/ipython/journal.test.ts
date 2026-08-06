import { beforeAll, describe, expect, test } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { IpythonCellResult } from "../../src/ipython/cell.js";
import {
	createIpythonCellJournalDetail,
	createIpythonLifecycleJournalDetail,
	IPYTHON_JOURNAL_MESSAGE_TYPE,
	isIpythonJournalDetail,
	renderIpythonJournalText,
} from "../../src/ipython/journal.js";
import { ChatTranscriptBuilder } from "../../src/modes/components/chat-transcript-builder.js";
import { IpythonCellMessageComponent } from "../../src/modes/components/ipython-cell-message.js";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme.js";

const rawHtml = "<script>globalThis.pwned = true</script><b>unsafe</b>";

function cellResult(): IpythonCellResult {
	return {
		cellId: "cell-7",
		executionId: "execute-7",
		sequence: 7,
		origin: "direct",
		authority: "trusted-cell",
		code: "display(unsafe_html)\nraise ValueError('broken')",
		status: "error",
		requestedAt: 100,
		startedAt: 110,
		finishedAt: 135,
		durationMs: 25,
		stdout: "before\n",
		stderr: "",
		result: undefined,
		events: [
			{
				kind: "display",
				data: { "text/html": rawHtml },
				metadata: { source: "test" },
				transient: { display_id: "display-1" },
				update: false,
				text: "[displayed MIME types: text/html]",
			},
			{ kind: "error", ename: "ValueError", evalue: "broken", traceback: ["ValueError: broken"] },
		],
		errors: [{ kind: "error", ename: "ValueError", evalue: "broken", traceback: ["ValueError: broken"] }],
		artifacts: [],
		updates: [
			{
				kind: "startup",
				cellId: "cell-7",
				origin: "direct",
				progress: { stage: "restore", message: "Restoring IPython state..." },
			},
		],
		modelText: {
			text: "before\n[displayed MIME types: text/html]\nValueError: broken\n",
			truncated: false,
			totalBytes: 66,
			outputBytes: 66,
		},
	};
}

describe("IPython replay journal", () => {
	beforeAll(async () => {
		const selected = await getThemeByName("dark");
		if (!selected) throw new Error("dark test theme is unavailable");
		setThemeInstance(selected);
	});

	test("round-trips typed cell and lifecycle details without using raw rich MIME as text", () => {
		const detail = createIpythonCellJournalDetail(cellResult(), [
			{ path: "/tmp/plot.png", mimeType: "image/png", bytes: 123, label: "plot" },
		]);
		const replayed = JSON.parse(JSON.stringify(detail)) as unknown;
		expect(isIpythonJournalDetail(replayed)).toBe(true);
		expect(isIpythonJournalDetail({ ...detail, updates: [null] })).toBe(false);
		expect(isIpythonJournalDetail({ ...detail, artifacts: [{ path: 42 }] })).toBe(false);
		const text = renderIpythonJournalText(detail);
		expect(text).toContain("displayed MIME types: text/html");
		expect(text).toContain("ValueError: broken");
		expect(text).toContain("Artifact: plot (image/png)");
		expect(text).not.toContain(rawHtml);

		const lifecycle = createIpythonLifecycleJournalDetail("restore", "warning", "2 names restored; 1 failed.", {
			controllerPid: 10,
			kernelPid: 11,
		});
		expect(isIpythonJournalDetail(JSON.parse(JSON.stringify(lifecycle)))).toBe(true);
		expect(renderIpythonJournalText(lifecycle)).toBe("IPython restore: 2 names restored; 1 failed.");
		const control = createIpythonLifecycleJournalDetail("control", "warning", "compaction failed");
		expect(isIpythonJournalDetail(JSON.parse(JSON.stringify(control)))).toBe(true);
		expect(renderIpythonJournalText(control)).toBe("IPython control: compaction failed");
	});

	test("uses one expandable component for safe live and replay rendering", () => {
		const detail = createIpythonCellJournalDetail(cellResult(), [
			{ path: "/tmp/plot.png", mimeType: "image/png", label: "plot" },
		]);
		const component = new IpythonCellMessageComponent(detail);
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("In [7]");
		expect(collapsed).toContain("display(unsafe_html)");
		expect(collapsed).toContain("displayed MIME types: text/html");
		expect(collapsed).toContain("ValueError: broken");
		expect(collapsed).not.toContain(rawHtml);
		expect(collapsed).not.toContain("startup · restore");

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain("startup · restore: Restoring IPython state...");
		expect(expanded).toContain("artifact · plot (image/png)");
		expect(expanded).not.toContain(rawHtml);

		const lifecycle = new IpythonCellMessageComponent(
			createIpythonLifecycleJournalDetail("restart", "warning", "Kernel restarted.", {
				controllerPid: 12,
				kernelPid: 13,
			}),
		);
		const lifecycleText = Bun.stripANSI(lifecycle.render(100).join("\n"));
		expect(lifecycleText).toContain("IPython restart");
		expect(lifecycleText).toContain("Kernel restarted.");
		expect(lifecycleText).toContain("controller 12, kernel 13");
	});

	test("streams progress and ordered safe events before final journal completion", () => {
		const component = new IpythonCellMessageComponent({ code: "display(unsafe_html)", origin: "direct" });
		component.applyUpdate({
			kind: "startup",
			cellId: "cell-live",
			origin: "direct",
			progress: { stage: "runtime", message: "Preparing runtime..." },
		});
		component.applyUpdate({
			kind: "execution",
			cellId: "cell-live",
			origin: "direct",
			event: {
				kind: "display",
				data: { "text/html": rawHtml },
				metadata: {},
				transient: {},
				update: false,
				text: "[displayed MIME types: text/html]",
			},
		});
		const running = Bun.stripANSI(component.render(100).join("\n"));
		expect(running).toContain("running");
		expect(running).toContain("Preparing runtime...");
		expect(running).toContain("displayed MIME types: text/html");
		expect(running).not.toContain(rawHtml);
		component.complete(createIpythonCellJournalDetail(cellResult()));
		const complete = Bun.stripANSI(component.render(100).join("\n"));
		expect(complete).toContain("failed");
		expect(complete).toContain("25ms");
	});

	test("routes persisted cell details through the same replay component", () => {
		const detail = createIpythonCellJournalDetail(cellResult());
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender() {} } as unknown as TUI,
			cwd: "/work",
			requestRender() {},
		});
		builder.rebuild([
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: new Date(100).toISOString(),
				message: {
					role: "custom",
					customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
					content: "",
					display: true,
					details: detail,
					attribution: "user",
					timestamp: 100,
				},
			},
		]);
		const collapsed = Bun.stripANSI(builder.container.render(100).join("\n"));
		expect(collapsed).toContain("In [7]");
		expect(collapsed).not.toContain(rawHtml);
		builder.setExpanded(true);
		const expanded = Bun.stripANSI(builder.container.render(100).join("\n"));
		expect(expanded).toContain("startup · restore: Restoring IPython state...");
	});
});

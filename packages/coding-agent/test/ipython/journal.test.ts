import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { Settings } from "../../src/config/settings.js";
import type { IpythonMimeRenderer } from "../../src/extensibility/extensions/types.js";
import type { IpythonCellResult, IpythonCellUpdate } from "../../src/ipython/cell.js";
import type { IpythonErrorEvent, IpythonExecutionEvent } from "../../src/ipython/controller.js";
import {
	createIpythonCellJournalDetail,
	createIpythonLifecycleJournalDetail,
	IPYTHON_JOURNAL_MESSAGE_TYPE,
	isIpythonJournalDetail,
	renderIpythonJournalText,
} from "../../src/ipython/journal.js";
import {
	createIpythonCellText,
	projectIpythonCellPresentation,
	projectIpythonLiveCellPresentation,
} from "../../src/ipython/projection.js";
import { ChatTranscriptBuilder } from "../../src/modes/components/chat-transcript-builder.js";
import { IpythonCellMessageComponent } from "../../src/modes/components/ipython-cell-message.js";
import { getThemeByName, setThemeInstance } from "../../src/modes/theme/theme.js";
import type { SessionMessageEntry } from "../../src/session/session-entries.js";

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
	test("stores namespace metadata only on the completed cell detail", () => {
		const result: IpythonCellResult = {
			...cellResult(),
			namespaceDelta: {
				executionCount: 7,
				origin: "direct",
				added: [{ name: "answer", type: "int" }],
				rebound: [],
				deleted: [],
				omitted: { added: 0, rebound: 0, deleted: 0 },
			},
		};
		const prior = cellResult();
		const priorBytes = JSON.stringify(prior);
		const detail = createIpythonCellJournalDetail(result);
		expect(detail.namespaceDelta).toEqual(result.namespaceDelta);
		expect(isIpythonJournalDetail(detail)).toBe(true);
		expect(JSON.stringify(prior)).toBe(priorBytes);
		expect(createIpythonCellJournalDetail(prior).namespaceDelta).toBeUndefined();
	});

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
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
		expect(isIpythonJournalDetail({ ...detail, events: [{ kind: "stream", name: "stdout" }] })).toBe(false);
		expect(isIpythonJournalDetail({ ...detail, stdout: undefined })).toBe(false);
		expect(isIpythonJournalDetail({ ...detail, artifacts: [{ path: 42 }] })).toBe(false);
		const text = renderIpythonJournalText(detail);
		expect(text).toContain("displayed MIME types: text/html");
		expect(text).toContain("ValueError: broken");
		expect(text).toContain("Artifact: plot · /tmp/plot.png (image/png)");
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
			{ path: `${os.homedir()}/private.png`, mimeType: "image/png" },
		]);
		const component = new IpythonCellMessageComponent(detail);
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("✘ python · raise ValueError('broken')");
		expect(collapsed).toContain("↑ 2 ↓ 3 lines · 25ms");
		expect(collapsed).not.toContain("displayed MIME types: text/html");
		expect(collapsed).not.toContain("ValueError: broken");
		expect(collapsed).not.toContain(rawHtml);
		expect(collapsed).not.toContain("startup · restore");

		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain("displayed MIME types: text/html");
		expect(expanded).toContain("ValueError: broken");
		expect(expanded).toContain("startup · restore: Restoring IPython state...");
		expect(expanded).toContain("artifact · plot · /tmp/plot.png (image/png)");
		expect(expanded).toContain("artifact · ~/private.png (image/png)");
		expect(expanded).not.toContain(os.homedir());
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
		expect(running).toContain("python · display(unsafe_html) · ↑ 1 ↓ 1 lines");
		expect(running).not.toContain("Preparing runtime...");
		expect(running).not.toContain("displayed MIME types: text/html");
		expect(running).not.toContain(rawHtml);
		component.complete(createIpythonCellJournalDetail(cellResult()));
		const complete = Bun.stripANSI(component.render(100).join("\n"));
		expect(complete).toContain("✘ python · raise ValueError('broken')");
		expect(complete).not.toContain("ValueError: broken");
		expect(complete).toContain("25ms");
		component.setExpanded(true);
		const expanded = Bun.stripANSI(component.render(100).join("\n"));
		expect(expanded).toContain("ValueError: broken");
	});

	test("uses one MIME renderer across live and completed cells while retaining safe fallback", () => {
		const renderer: IpythonMimeRenderer = input =>
			new Text(`rich:${input.item.kind}:${String(input.item.update)}:${String(input.item.transient?.display_id)}`);
		const resolveRenderer = (mimeType: string): IpythonMimeRenderer | undefined =>
			mimeType === "text/html" ? renderer : undefined;
		const update: IpythonCellUpdate = {
			kind: "execution",
			cellId: "cell-live",
			origin: "direct",
			event: cellResult().events[0]!,
		};
		const live = new IpythonCellMessageComponent({ code: "display(unsafe_html)", origin: "direct" }, resolveRenderer);
		live.applyUpdate(update);
		const liveText = Bun.stripANSI(live.render(100).join("\n"));
		const completed = new IpythonCellMessageComponent(createIpythonCellJournalDetail(cellResult()), resolveRenderer);
		const completedText = Bun.stripANSI(completed.render(100).join("\n"));
		for (const text of [liveText, completedText]) {
			expect(text).not.toContain("displayed MIME types: text/html");
			expect(text).not.toContain("rich:display:false:display-1");
			expect(text).not.toContain(rawHtml);
		}
		live.setExpanded(true);
		completed.setExpanded(true);
		for (const text of [live, completed].map(component => Bun.stripANSI(component.render(100).join("\n")))) {
			expect(text).toContain("rich:display:false:display-1");
			expect(text).not.toContain(rawHtml);
		}

		const failedRenderer = new IpythonCellMessageComponent(createIpythonCellJournalDetail(cellResult()), () => () => {
			throw new Error("renderer failed");
		});
		failedRenderer.setExpanded(true);
		const fallback = Bun.stripANSI(failedRenderer.render(100).join("\n"));
		expect(fallback).toContain("displayed MIME types: text/html");
		expect(fallback).not.toContain(rawHtml);
	});

	test("routes persisted cell details through the same replay component", () => {
		const detail = createIpythonCellJournalDetail(cellResult());
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender() {} } as unknown as TUI,
			getIpythonMimeRenderer: mimeType =>
				mimeType === "text/html"
					? input =>
							new Text(
								`rich:${input.item.kind}:${String(input.item.update)}:${String(input.item.metadata?.source)}`,
							)
					: undefined,
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
		expect(collapsed).toContain("✘ python · raise ValueError('broken')");
		expect(collapsed).not.toContain("rich:display:false:test");
		expect(collapsed).not.toContain(rawHtml);
		builder.setExpanded(true);
		const expanded = Bun.stripANSI(builder.container.render(100).join("\n"));
		expect(expanded).toContain("rich:display:false:test");
		expect(expanded).toContain("startup · restore: Restoring IPython state...");
	});

	test("matches compact tool cards while Ctrl-O reveals the complete cell", () => {
		const codeLines = Array.from({ length: 25 }, (_, index) => `value_${index} = ${index}`);
		codeLines[12] = `blob = '${"y".repeat(4_100)}'`;
		const code = codeLines.join("\n");
		const outputLines = Array.from({ length: 30 }, (_, index) => `output-${index}`);
		outputLines[0] = `output-0-${"x".repeat(4_100)}`;
		const output = `${outputLines.join("\n")}\n`;
		const result: IpythonCellResult = {
			...cellResult(),
			cellId: "cell-long",
			executionId: "execute-long",
			origin: "model",
			code,
			status: "ok",
			stdout: output,
			events: [{ kind: "stream", name: "stdout", text: output }],
			errors: [],
			updates: [],
			modelText: {
				text: output,
				truncated: false,
				totalBytes: Buffer.byteLength(output),
				outputBytes: Buffer.byteLength(output),
			},
		};

		const completed = new IpythonCellMessageComponent(createIpythonCellJournalDetail(result));
		const collapsed = Bun.stripANSI(completed.render(100).join("\n"));
		expect(collapsed).toContain("✓ python · value_24 = 24");
		expect(collapsed).not.toContain("· model");
		expect(collapsed).toContain("↑ 25 ↓ 30 lines · 25ms");
		expect(collapsed).not.toContain("value_0 = 0");
		expect(collapsed).not.toContain("output-0-");
		expect(collapsed).not.toContain("output-29");
		expect(collapsed.split("\n")).toHaveLength(1);

		for (const width of [40, 16]) {
			const rows = completed.render(width).map(line => Bun.stripANSI(line));
			expect(rows.length).toBeLessThanOrEqual(20);
			expect(rows.every(line => Bun.stringWidth(line) <= width)).toBe(true);
		}

		completed.setExpanded(true);
		const expanded = Bun.stripANSI(completed.render(100).join("\n"));
		expect(expanded).toContain("blob =");
		expect(expanded.split("y").length - 1).toBeGreaterThanOrEqual(4_100);
		expect(expanded).toContain("output-0-");
		expect(expanded.split("x").length - 1).toBeGreaterThanOrEqual(4_100);
		expect(expanded).toContain("value_24 = 24");
		expect(expanded).toContain("output-29");
		expect(expanded).not.toContain("more lines");

		const live = new IpythonCellMessageComponent({ code, origin: "model" });
		live.applyUpdate({
			kind: "execution",
			cellId: "cell-long",
			origin: "model",
			event: { kind: "stream", name: "stdout", text: output },
		});
		const liveCollapsed = Bun.stripANSI(live.render(100).join("\n"));
		expect(liveCollapsed).toContain("python · value_24 = 24");
		expect(liveCollapsed).toContain("↑ 25 ↓ 30 lines");
		expect(liveCollapsed).not.toContain("value_0 = 0");
		expect(liveCollapsed).not.toContain("output-29");
		expect(liveCollapsed).not.toContain("output-0-");
		live.setExpanded(true);
		const liveExpanded = Bun.stripANSI(live.render(100).join("\n"));
		expect(liveExpanded).toContain("output-0-");
		expect(liveExpanded.split("x").length - 1).toBeGreaterThanOrEqual(4_100);

		const direct = new IpythonCellMessageComponent(
			createIpythonCellJournalDetail({ ...result, origin: "direct", cellId: "cell-direct" }),
		);
		const directCollapsed = Bun.stripANSI(direct.render(100).join("\n"));
		expect(directCollapsed).toContain("value_24 = 24 · ↑ 25 ↓ 30 lines");
		expect(directCollapsed).not.toContain("value_0 = 0");
		expect(directCollapsed).not.toContain("output-29");
	});

	test("counts a bash cell body without its magic header", () => {
		const result: IpythonCellResult = {
			...cellResult(),
			code: "%%bash\nprintf hi",
			status: "ok",
			stdout: "",
			events: [],
			errors: [],
			modelText: { text: "", truncated: false, totalBytes: 0, outputBytes: 0 },
		};
		const component = new IpythonCellMessageComponent(createIpythonCellJournalDetail(result));
		const collapsed = Bun.stripANSI(component.render(100).join("\n"));
		expect(collapsed).toContain("bash · printf hi · ↑ 1 lines");
		expect(collapsed).not.toContain("direct");

		component.setExpanded(true);
		expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("%%bash");
	});

	test("projects ordered live and replayed output through one structured record", () => {
		const error: IpythonErrorEvent = {
			kind: "error",
			ename: "ValueError",
			evalue: "broken",
			traceback: ["ValueError: broken"],
		};
		const events: IpythonCellResult["events"] = [
			{ kind: "stream", name: "stdout", text: "left" },
			{ kind: "stream", name: "stdout", text: "right\n" },
			{ kind: "stream", name: "stderr", text: "warning\n" },
			{ kind: "result", data: { "text/plain": "42", "application/vnd.omp.attachment+json": { id: "a-1" } } },
			{
				kind: "display",
				data: { "text/x-diff": "-old\n+new", "text/html": rawHtml },
				metadata: { source: "projection-test" },
				transient: { display_id: "diff-1" },
				update: false,
				text: "[displayed MIME types: text/html, text/x-diff]",
			},
			{ kind: "host_progress", operation: "omp.code.search", message: "2 matches", data: { files: 2 } },
			error,
		];
		const updates: IpythonCellUpdate[] = [
			{
				kind: "startup",
				cellId: "cell-projection",
				origin: "model",
				progress: { stage: "runtime", message: "Preparing runtime..." },
			},
			...events.map(event => ({
				kind: "execution" as const,
				cellId: "cell-projection",
				origin: "model" as const,
				event,
			})),
		];
		const modelText = createIpythonCellText(events, [error], "error");
		const result: IpythonCellResult = {
			cellId: "cell-projection",
			executionId: "execute-projection",
			sequence: 8,
			origin: "model",
			authority: "trusted-cell",
			code: "print('left', end=''); print('right')",
			status: "error",
			requestedAt: 200,
			startedAt: 210,
			finishedAt: 250,
			durationMs: 40,
			stdout: "leftright\n",
			stderr: "warning\n",
			result: "42",
			events,
			errors: [error],
			updates,
			artifacts: [{ path: "/tmp/diff.patch", mimeType: "text/x-diff", bytes: 9, label: "diff" }],
			modelText,
		};

		const live = projectIpythonLiveCellPresentation({ code: result.code, origin: result.origin, updates });
		const completed = projectIpythonCellPresentation(result);
		const replayed = projectIpythonCellPresentation(createIpythonCellJournalDetail(result));

		expect(live.safeText.text).toBe(completed.safeText.text);
		expect(replayed).toEqual(completed);
		expect(completed.stdout).toBe("leftright\n");
		expect(completed.stderr).toBe("warning\n");
		expect(completed.result).toBe("42");
		expect(completed.durationMs).toBe(40);
		expect(completed.startupProgress).toEqual([{ stage: "runtime", message: "Preparing runtime..." }]);
		expect(completed.events[3]).toEqual(events[3]);
		expect(completed.events[4]).toEqual(events[4]);
		expect(completed.artifacts).toEqual(result.artifacts);
		expect(completed.safeText.text).toContain("leftright");
		expect(completed.safeText.text).toContain("[omp.code.search] 2 matches");
		expect(completed.safeText.text).toContain("ValueError: broken");
		expect(completed.safeText.text).not.toContain("left\nright");
		expect(completed.safeText.text).not.toContain(rawHtml);

		const liveComponent = new IpythonCellMessageComponent({ code: result.code, origin: result.origin });
		for (const update of updates) liveComponent.applyUpdate(update);
		const liveText = Bun.stripANSI(liveComponent.render(120).join("\n"));
		const replayText = Bun.stripANSI(
			new IpythonCellMessageComponent(createIpythonCellJournalDetail(result)).render(120).join("\n"),
		);
		expect(liveText).not.toContain("leftright");
		expect(replayText).not.toContain("leftright");
		expect(liveText).toContain("↑ 1 ↓ 6 lines");
		expect(replayText).toContain("↑ 1 ↓ 6 lines");
		liveComponent.setExpanded(true);
		const expandedLiveText = Bun.stripANSI(liveComponent.render(120).join("\n"));
		expect(expandedLiveText).toContain("leftright");
		expect(liveText).not.toContain(rawHtml);
		expect(replayText).not.toContain(rawHtml);
	});

	test("renders removed tool history generically and one authoritative IPython cell", () => {
		const detail = createIpythonCellJournalDetail(cellResult());
		const entries = [
			{
				type: "message",
				id: "legacy-call-entry",
				parentId: null,
				timestamp: new Date(90).toISOString(),
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "legacy-call",
							name: "read",
							arguments: { path: `old-${"x".repeat(5_000)}\u001b[31m` },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "legacy",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 90,
				},
			},
			{
				type: "message",
				id: "legacy-result-entry",
				parentId: "legacy-call-entry",
				timestamp: new Date(91).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "legacy-call",
					toolName: "read",
					content: [{ type: "text", text: "old result\u001b[2J" }],
					isError: false,
					timestamp: 91,
				},
			},
			{
				type: "message",
				id: "ipython-call-entry",
				parentId: "legacy-result-entry",
				timestamp: new Date(99).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "ipython-call", name: "ipython", arguments: { code: "42" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "current",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: 99,
				},
			},
			{
				type: "message",
				id: "cell-entry",
				parentId: "ipython-call-entry",
				timestamp: new Date(100).toISOString(),
				message: {
					role: "custom",
					customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
					content: "",
					display: true,
					details: detail,
					attribution: "assistant",
					timestamp: 100,
				},
			},
			{
				type: "message",
				id: "ipython-result-entry",
				parentId: "cell-entry",
				timestamp: new Date(101).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "ipython-call",
					toolName: "ipython",
					content: [{ type: "text", text: "42" }],
					isError: false,
					timestamp: 101,
				},
			},
		] as SessionMessageEntry[];
		const builder = new ChatTranscriptBuilder({
			ui: { requestRender() {} } as unknown as TUI,
			getTool: () => {
				throw new Error("historical replay must not resolve tools");
			},
			cwd: "/work",
			requestRender() {},
		});
		builder.rebuild(entries);
		const rendered = Bun.stripANSI(builder.container.render(100).join("\n"));
		expect(rendered).toContain("Removed tool: read");
		expect(rendered).toContain("old result");
		expect(rendered).not.toContain("\u001b");
		expect(rendered.match(/python ·/g)).toHaveLength(1);
		expect(rendered).not.toContain("Removed tool: ipython");
		expect(rendered.length).toBeLessThan(9_000);
	});

	test("keeps the command head and failure tail inside the bounded 200 KiB result", () => {
		const command = "$ gh run watch 481516 --exit-status\n";
		const finalAssertion = "AssertionError: final failing assertion: expected check deploy to pass\n";
		const exitSummary = "gh run watch exited with status 1\n";
		const table = "NAME                STATUS  ELAPSED\nunit / linux        pending  00:42\n";
		const bodyBytes =
			200 * 1024 - Buffer.byteLength(command) - Buffer.byteLength(finalAssertion) - Buffer.byteLength(exitSummary);
		const repeatedTables = table.repeat(Math.ceil(bodyBytes / Buffer.byteLength(table))).slice(0, bodyBytes);
		const events: IpythonExecutionEvent[] = [
			{ kind: "stream", name: "stdout", text: command },
			{ kind: "stream", name: "stdout", text: repeatedTables },
			{
				kind: "error",
				ename: "AssertionError",
				evalue: "final failing assertion",
				traceback: [finalAssertion, exitSummary],
			},
		];
		const artifactPath = "/tmp/full-ipython-result.txt";
		const safeText = createIpythonCellText(events, [], "error", 50 * 1024, artifactPath);
		const totalBytes = safeText.totalBytes;
		const headerEnd = safeText.text.indexOf("\n") + 1;
		const gap = "\n[... IPython preview gap ...]\n";
		const retainedBytes = Buffer.byteLength(safeText.text) - headerEnd - Buffer.byteLength(gap);

		expect(totalBytes).toBeGreaterThanOrEqual(200 * 1024);
		expect(safeText).toMatchObject({ truncated: true, omittedBytes: totalBytes - retainedBytes });
		expect(safeText.outputBytes).toBeLessThanOrEqual(50 * 1024);
		expect(safeText.text).toContain(command.trim());
		expect(safeText.text).toContain(finalAssertion.trim());
		expect(safeText.text).toContain(exitSummary.trim());
		expect(safeText.text.split("\n", 1)[0]).toContain(artifactPath);
		expect(safeText.text.split("\n", 1)[0]).toContain(`${totalBytes} bytes total`);
		expect(safeText.text.split("\n", 1)[0]).toContain(`${totalBytes - retainedBytes} bytes omitted`);
	});

	test("bounds live safe text and preserves empty abort status", () => {
		const updates: IpythonCellUpdate[] = [
			{
				kind: "execution",
				cellId: "cell-long",
				origin: "model",
				event: { kind: "stream", name: "stdout", text: "x".repeat(500) },
			},
		];
		const live = projectIpythonLiveCellPresentation({ code: "print(long)", origin: "model", updates }, 80);
		expect(live.safeText.truncated).toBe(true);
		expect(live.safeText.totalBytes).toBe(500);
		expect(live.safeText.outputBytes).toBeLessThanOrEqual(80);
		expect(createIpythonCellText([], [], "aborted").text).toBe("IPython cell aborted.\n");
	});
});

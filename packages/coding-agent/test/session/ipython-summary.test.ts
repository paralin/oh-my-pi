import { describe, expect, it } from "bun:test";
import type { IpythonCellResult } from "../../src/ipython/cell";
import { createIpythonCellJournalDetail, IPYTHON_JOURNAL_MESSAGE_TYPE } from "../../src/ipython/journal";
import {
	mergeIpythonJournalSummaryMessages,
	projectIpythonJournalSummaryMessage,
} from "../../src/session/ipython-summary";
import { convertToLlm } from "../../src/session/messages";
import { buildScratchHandoffRecentContext } from "../../src/session/scratch-handoff";
import type { CustomMessageEntry } from "../../src/session/session-entries";
import { formatSessionHistoryMarkdown } from "../../src/session/session-history-format";

function cellDetail() {
	const result: IpythonCellResult = {
		cellId: "cell-summary",
		executionId: "execute-summary",
		sequence: 4,
		origin: "direct",
		authority: "trusted-cell",
		code: "answer = 42",
		status: "error",
		requestedAt: 10,
		startedAt: 12,
		finishedAt: 37,
		durationMs: 25,
		stdout: "safe output\n",
		stderr: "",
		result: undefined,
		events: [
			{ kind: "stream", name: "stdout", text: "safe output\n" },
			{
				kind: "display",
				data: { "text/html": "<script>unsafe()</script>" },
				metadata: {},
				transient: {},
				update: false,
				text: "[displayed MIME types: text/html]",
			},
		],
		errors: [{ kind: "error", ename: "ValueError", evalue: "bad value", traceback: ["ValueError: bad value"] }],
		updates: [],
		artifacts: [],
		modelText: {
			text: "safe output\n[displayed MIME types: text/html]\nValueError: bad value",
			truncated: false,
			totalBytes: 69,
			outputBytes: 69,
		},
	};
	return createIpythonCellJournalDetail(result, [
		{ path: "/tmp/cell-summary/result.txt", mimeType: "text/plain", bytes: 7, label: "result" },
	]);
}

function message() {
	return {
		role: "custom" as const,
		customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
		content: "",
		display: true,
		details: cellDetail(),
		attribution: "user" as const,
		timestamp: 37,
	};
}

describe("IPython harness summary projection", () => {
	it("projects bounded safe cell text without evaluating raw HTML", () => {
		const projected = projectIpythonJournalSummaryMessage(message());
		if (projected.role !== "user") throw new Error("expected user summary message");
		const text =
			typeof projected.content === "string"
				? projected.content
				: (projected.content.find(part => part.type === "text")?.text ?? "");
		expect(text).toContain("answer = 42");
		expect(text).toContain("safe output");
		expect(text).toContain("ValueError: bad value");
		expect(text).toContain("Artifact: result (text/plain)");
		expect(text).not.toContain("<script>");
	});

	it("bounds the complete summary including source code and artifact labels", () => {
		const input = message();
		if (input.role !== "custom" && input.role !== "hookMessage") throw new Error("Expected custom journal message");
		const details = input.details as ReturnType<typeof cellDetail>;
		const oversized = {
			...input,
			details: {
				...details,
				code: "x".repeat(200_000),
				artifacts: Array.from({ length: 100 }, (_, index) => ({
					path: `/tmp/artifact-${index}`,
					label: "artifact".repeat(1_000),
				})),
			},
		};
		const projected = projectIpythonJournalSummaryMessage(oversized);
		if (projected.role !== "user" || typeof projected.content === "string") {
			throw new Error("Expected projected user text");
		}
		const text = projected.content.find(part => part.type === "text")?.text ?? "";
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(50 * 1024);
		expect(text).toContain("[code truncated]");
		expect(text.match(/```/g)).toHaveLength(4);
		expect(text).toContain("[92 more artifacts omitted]");
		const history = formatSessionHistoryMarkdown([oversized]);
		expect(Buffer.byteLength(history, "utf-8")).toBeLessThanOrEqual(52 * 1024);
		expect(history).toContain("[code truncated]");
	});

	it("merges journal cells into the live advisor transcript without dropping the current turn", () => {
		const staleJournalCopy = message();
		const live = [
			{ role: "user" as const, content: [{ type: "text" as const, text: "before" }], timestamp: 10 },
			{ role: "user" as const, content: [{ type: "text" as const, text: "current turn" }], timestamp: 50 },
		];
		const merged = mergeIpythonJournalSummaryMessages(live, [staleJournalCopy]);
		expect(merged.map(item => item.timestamp)).toEqual([10, 37, 50]);
		expect(JSON.stringify(merged)).toContain("answer = 42");
		expect(JSON.stringify(merged)).toContain("current turn");
		expect(JSON.stringify(merged)).not.toContain("<script>");
	});

	it("feeds advisor/history formatting from the same safe projection", () => {
		const text = formatSessionHistoryMarkdown([message()]);
		expect(text).toContain("[ipython-cell]");
		expect(text).toContain("answer = 42");
		expect(text).toContain("safe output");
		expect(text).not.toContain("<script>");
	});

	it("feeds scratch handoff recent context while retaining its token budget", () => {
		const entry: CustomMessageEntry = {
			type: "custom_message",
			id: "entry-cell",
			parentId: null,
			timestamp: new Date(37).toISOString(),
			customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
			content: "",
			display: true,
			details: cellDetail(),
			attribution: "user",
		};
		const context = buildScratchHandoffRecentContext({
			entries: [entry],
			convertToLlm,
			maxTokens: 2_048,
		});
		expect(context?.bounded).toContain("answer = 42");
		expect(context?.bounded).toContain("safe output");
		expect(context?.bounded).not.toContain("<script>");
	});
});

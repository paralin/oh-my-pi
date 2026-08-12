/**
 * Contract: /dump renders the tool catalog through the shared AI inventory
 * renderer — a simplified TypeScript signature (derived from the wire JSON
 * Schema) plus each tool's examples in the model's native tool-call syntax.
 *
 * Tools carry live arktype schemas; the dump must surface a readable signature
 * (not the schema instance's internals) and must include examples, which the
 * previous `<parameter>`-per-key JSON Schema dump dropped entirely.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Model, Usage } from "@oh-my-pi/pi-ai";
import { formatSessionDumpText } from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import type { IpythonCellResult } from "../../src/ipython/cell.js";
import { createIpythonCellJournalDetail, IPYTHON_JOURNAL_MESSAGE_TYPE } from "../../src/ipython/journal.js";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const HARMONY_MODEL = { provider: "openai", id: "gpt-5", name: "GPT-5" } as Model;

describe("formatSessionDumpText tool parameters", () => {
	it("renders a concise tool name and description without a provider inventory", () => {
		const webSearchSchema = type({
			"query /** search query */": "string",
			"recency?": "'day' | 'week'",
		});

		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "ipython",
					description: "Executes one persistent Python cell.",
					parameters: webSearchSchema,
				},
			],
		});

		expect(out).toContain("### ipython");
		expect(out).toContain("Executes one persistent Python cell.");
		expect(out).not.toContain("namespace functions {");
		expect(out).not.toContain("_arktype");
	});

	it("keeps JSON-schema internals out of the dump inventory", () => {
		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "legacy",
					description: "Legacy tool.",
					parameters: {
						type: "object",
						properties: { path: { type: "string", description: "a path" } },
						required: ["path"],
					},
				},
			],
		});

		expect(out).toContain("### legacy");
		expect(out).toContain("Legacy tool.");
		expect(out).not.toContain("path: string");
	});

	it("includes tool examples in Python call syntax", () => {
		const ipythonSchema = type({ code: "string" });

		const out = formatSessionDumpText({
			messages: [],
			tools: [
				{
					name: "ipython",
					description: "Executes one persistent Python cell.",
					parameters: ipythonSchema,
				},
			],
		});

		expect(out).toContain("## Available Tools");
		expect(out).toContain("### ipython");
		expect(out).toContain("Executes one persistent Python cell.");
	});

	it("does not falsely omit the Available Tools section even if systemPrompt contains tool headings", () => {
		const out = formatSessionDumpText({
			messages: [],
			systemPrompt: ["# Inventory\nThis is a rule discussing # Tool: ipython.\nUse it for ordinary work."],
			tools: [
				{
					name: "web_search",
					description: "Searches the web.",
					parameters: { type: "object" },
				},
			],
		});

		expect(out).toContain("## Available Tools");
	});
});

describe("formatSessionDumpText markdown-headings transcript", () => {
	it("renders the main /dump transcript with legacy markdown role headings, not native envelopes", () => {
		const out = formatSessionDumpText({
			model: HARMONY_MODEL,
			messages: [
				{ role: "user", content: "Hello", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Reading." },
						{
							type: "toolCall",
							id: "c1",
							name: "read",
							arguments: { path: "src/foo.ts" },
						},
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				},
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "file body" }],
					isError: false,
					timestamp: 3,
				},
			],
		});

		// Legacy per-message markdown headings (the pre-16.x /dump shape the user wants back).
		expect(out).toContain("## User");
		expect(out).toContain("## Assistant");
		expect(out).toContain("### Tool Result: read");
		expect(out).toContain("### Tool Call: read");
		expect(out).toContain("path: src/foo.ts");
		// Tool calls render as a readable heading + YAML, never the <invoke>/<parameter> XML.
		expect(out).not.toContain("<invoke ");
		expect(out).not.toContain("<parameter ");
		expect(out).toContain("file body");
		// The 16.x native-dialect transcript wrapper and envelopes must be gone.
		expect(out).not.toContain("## Transcript");
		expect(out).not.toContain("<|start|>");
	});

	it("does not nest a thinking block that already carries a literal <thinking> envelope (#2700)", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "<thinking>\nCheck the logs.\n</thinking>" }],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		expect(out).toContain("<thinking>\nCheck the logs.\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});

	it("renders sibling thinking blocks split by a tool call without nesting envelopes", () => {
		const out = formatSessionDumpText({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "<thinking>\nfirst\n</thinking>" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "f.ts" } },
						{ type: "thinking", thinking: "<thinking>\nsecond\n</thinking>" },
					],
					api: "mock",
					provider: "mock",
					model: "mock",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 1,
				},
			],
		});

		// Each block is unwrapped then re-wrapped independently — never nested.
		expect(out).toContain("<thinking>\nfirst\n</thinking>");
		expect(out).toContain("<thinking>\nsecond\n</thinking>");
		expect(out).not.toContain("<thinking>\n<thinking>");
	});
});

describe("formatSessionDumpText IPython projection", () => {
	it("renders the stored cell projection without evaluating rich MIME", () => {
		const result: IpythonCellResult = {
			cellId: "cell-dump",
			executionId: "execute-dump",
			sequence: 3,
			origin: "model",
			authority: "trusted-cell",
			code: "display(html)",
			status: "aborted",
			requestedAt: 10,
			startedAt: 12,
			finishedAt: 37,
			durationMs: 25,
			stdout: "before\n",
			stderr: "warning\n",
			result: undefined,
			events: [
				{ kind: "stream", name: "stdout", text: "before\n" },
				{ kind: "stream", name: "stderr", text: "warning\n" },
				{
					kind: "display",
					data: { "text/html": "<script>unsafe()</script>" },
					metadata: {},
					transient: {},
					update: false,
					text: "[displayed MIME types: text/html]",
				},
			],
			errors: [],
			updates: [],
			artifacts: [],
			modelText: {
				text: "before\nwarning\n[displayed MIME types: text/html]\n[IPython output truncated]",
				truncated: true,
				totalBytes: 4096,
				outputBytes: 82,
			},
		};
		const detail = createIpythonCellJournalDetail(result, [
			{ path: "/tmp/cell-dump/display.html", mimeType: "text/html", bytes: 25, label: "display" },
		]);
		const out = formatSessionDumpText({
			messages: [
				{
					role: "custom",
					customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
					content: "",
					display: true,
					details: detail,
					attribution: "agent",
					timestamp: 37,
				},
			],
		});

		expect(out).toContain("## IPython");
		expect(out).toContain("IPython cell 3 (model, aborted, 25ms)");
		expect(out).toContain("before\nwarning");
		expect(out).toContain("displayed MIME types: text/html");
		expect(out).toContain("Artifact: display · /tmp/cell-dump/display.html (text/html)");
		expect(out).toContain("Output truncated from 4096 bytes.");
		expect(out).not.toContain("<script>unsafe()</script>");
	});
});

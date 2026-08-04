import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AfterToolCallContext } from "@oh-my-pi/pi-agent-core";
import { analyzeSuccessfulChanges } from "@oh-my-pi/pi-coding-agent/capability/successful-change-analyzer";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { TtsrCoordinator, type TtsrCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/ttsr-coordinator";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function semanticRule() {
	const rulePath = "/tmp/semantic-rule.md";
	return buildRuleFromMarkdown(
		"semantic-rule",
		`---
scope: ["tool:edit(*.ts)"]
semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)\\([^)]*\\)\\s*\\{[^}]*\\}'
---
Keep the helper direct.`,
		rulePath,
		createSourceMeta("test", rulePath, "project"),
		{ ruleName: "semantic-rule" },
	);
}

function context(pathname: string, id: string): AfterToolCallContext {
	return {
		assistantMessage: {
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "test",
			usage: {},
		} as never,
		toolCall: { type: "toolCall", id, name: "edit", arguments: {} },
		args: {},
		result: { content: [{ type: "text", text: "applied" }] },
		successfulChanges: [{ path: pathname, operation: "update", ranges: [{ startLine: 2, endLine: 2 }] }],
		isError: false,
		context: { systemPrompt: [""], messages: [], tools: [] },
	};
}

function coordinator(manager: TtsrManager, cwd: string, injected: string[][]): TtsrCoordinator {
	const host = {
		agent: {},
		sessionManager: {
			getCwd: () => cwd,
			appendTtsrInjection: (names: string[]) => injected.push(names),
		},
		settings: {},
		emitSessionEvent: async () => {},
		schedulePostPromptTask: () => {},
		scheduleAgentContinue: () => {},
		promptGeneration: () => 0,
	} as unknown as TtsrCoordinatorHost;
	return new TtsrCoordinator(host, manager);
}

let tmpDir = "";

afterEach(async () => {
	if (tmpDir) await removeWithRetries(tmpDir);
	tmpDir = "";
});

describe("post-edit semantic TTSR", () => {
	it("reads final destinations, intersects changed ranges, and skips deletes and stale paths", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-change-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(
			file,
			"const untouched = 1;\nfunction changed() { return 1; }\nfunction legacy() { return 2; }\n",
		);
		const manager = new TtsrManager();
		const rule = semanticRule();
		expect(manager.addRule(rule)).toBe(true);
		expect(
			manager.checkDelta("function changed() { return 1; }", {
				source: "tool",
				toolName: "edit",
				filePaths: [file],
			}),
		).toEqual([]);

		const matches = await analyzeSuccessfulChanges(
			manager,
			[
				{ path: file, operation: "update", ranges: [{ startLine: 2, endLine: 2 }] },
				{ path: file, operation: "update", ranges: [{ startLine: 20, endLine: 20 }] },
				{ path: path.join(tmpDir, "deleted.ts"), operation: "delete", ranges: [] },
				{ path: path.join(tmpDir, "stale.ts"), operation: "update", ranges: [{ startLine: 1, endLine: 1 }] },
			],
			"edit",
		);
		expect(matches).toHaveLength(1);
		expect(matches[0]?.rule.name).toBe("semantic-rule");
		expect(matches[0]?.change.ranges).toEqual([
			{ startLine: 2, endLine: 2 },
			{ startLine: 20, endLine: 20 },
		]);
	});

	it("prepends one reminder to the responsible successful result", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-result-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(file, "const untouched = 1;\nfunction changed() { return 1; }\n");
		const manager = new TtsrManager();
		manager.addRule(semanticRule());
		const injected: string[][] = [];
		const result = await coordinator(manager, tmpDir, injected).afterToolCall(context(file, "call-1"));
		expect(result?.content?.[0]).toMatchObject({ type: "text", text: expect.stringContaining("semantic-rule") });
		expect(result?.content?.[1]).toEqual({ type: "text", text: "applied" });
		expect(injected).toEqual([["semantic-rule"]]);
	});

	it("atomically claims a semantic reminder across concurrent sibling calls", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-concurrent-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(file, "const untouched = 1;\nfunction changed() { return 1; }\n");
		const manager = new TtsrManager();
		manager.addRule(semanticRule());
		const injected: string[][] = [];
		const ttsr = coordinator(manager, tmpDir, injected);
		const results = await Promise.all([
			ttsr.afterToolCall(context(file, "call-1")),
			ttsr.afterToolCall(context(file, "call-2")),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(injected).toEqual([["semantic-rule"]]);
	});
});

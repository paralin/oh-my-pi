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

function referenceRule(max = 1) {
	const rulePath = "/tmp/reference-rule.md";
	return buildRuleFromMarkdown(
		"reference-rule",
		`---
scope: ["tool:edit(*.ts)"]
semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)\\([^)]*\\)\\s*\\{[^}]*\\}'
  references:
    capture: NAME
    max: ${max}
---
Keep the helper direct.`,
		rulePath,
		createSourceMeta("test", rulePath, "project"),
		{ ruleName: "reference-rule" },
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

		const analysis = await analyzeSuccessfulChanges(
			manager,
			[
				{ path: file, operation: "update", ranges: [{ startLine: 2, endLine: 2 }] },
				{ path: file, operation: "update", ranges: [{ startLine: 20, endLine: 20 }] },
				{ path: path.join(tmpDir, "deleted.ts"), operation: "delete", ranges: [] },
				{ path: path.join(tmpDir, "stale.ts"), operation: "update", ranges: [{ startLine: 1, endLine: 1 }] },
			],
			{ toolName: "edit", cwd: tmpDir },
		);
		expect(analysis.matches).toHaveLength(1);
		expect(analysis.matches[0]?.rule.name).toBe("semantic-rule");
		expect(analysis.matches[0]?.change.ranges).toEqual([
			{ startLine: 2, endLine: 2 },
			{ startLine: 20, endLine: 20 },
		]);
		expect(analysis.reports[1]?.report.skipped[0]?.reason).toContain("final source unavailable");
	});

	it("counts unique call sites, excludes the declaration, and records rejected evidence", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-references-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(file, "function changed() { return 1; }\nchanged();\nchanged();\n");
		const manager = new TtsrManager();
		manager.addRule(referenceRule());
		let requestedPosition: { line: number; character: number } | undefined;
		const analysis = await analyzeSuccessfulChanges(
			manager,
			[{ path: file, operation: "update", ranges: [{ startLine: 1, endLine: 1 }] }],
			{
				toolName: "edit",
				cwd: tmpDir,
				lookupReferences: async request => {
					requestedPosition = request.position;
					const uri = `file://${file}`;
					return {
						status: "ok",
						serverName: "test-lsp",
						uri,
						position: request.position,
						locations: [
							{ uri, range: { start: request.position, end: { ...request.position, character: 16 } } },
							{ uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 7 } } },
							{ uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } } },
							{ uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 7 } } },
						],
					};
				},
			},
		);
		expect(requestedPosition).toEqual({ line: 0, character: 9 });
		expect(analysis.matches).toEqual([]);
		expect(analysis.reports[0]?.report.candidates[0]).toMatchObject({
			status: "rejected",
			referenceEvidence: { capture: "NAME", count: 2, serverName: "test-lsp" },
		});
	});

	it("does not query references without a changed semantic candidate", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-no-candidate-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(file, "const changed = 1;\n");
		const manager = new TtsrManager();
		manager.addRule(referenceRule());
		let lookups = 0;
		const analysis = await analyzeSuccessfulChanges(
			manager,
			[{ path: file, operation: "update", ranges: [{ startLine: 1, endLine: 1 }] }],
			{
				toolName: "edit",
				cwd: tmpDir,
				lookupReferences: async () => {
					lookups++;
					return { status: "unavailable", reason: "unexpected lookup" };
				},
			},
		);
		expect(lookups).toBe(0);
		expect(analysis.matches).toEqual([]);
		expect(analysis.reports[0]?.report.candidates).toEqual([]);
	});

	it("records unavailable and cancelled reference lookups as skips", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ttsr-semantic-reference-skips-"));
		const file = path.join(tmpDir, "file.ts");
		await Bun.write(file, "function changed() { return 1; }\n");
		const manager = new TtsrManager();
		manager.addRule(referenceRule());
		const change = [{ path: file, operation: "update" as const, ranges: [{ startLine: 1, endLine: 1 }] }];
		const unavailable = await analyzeSuccessfulChanges(manager, change, {
			toolName: "edit",
			cwd: tmpDir,
			lookupReferences: async () => ({ status: "unavailable", reason: "server missing" }),
		});
		expect(unavailable.matches).toEqual([]);
		expect(unavailable.reports[0]?.report.candidates[0]).toMatchObject({
			status: "skipped",
			reason: "server missing",
		});

		const controller = new AbortController();
		const cancelled = await analyzeSuccessfulChanges(manager, change, {
			toolName: "edit",
			cwd: tmpDir,
			signal: controller.signal,
			lookupReferences: async request => {
				controller.abort();
				return {
					status: "ok",
					serverName: "ignores-abort",
					uri: `file://${file}`,
					position: request.position,
					locations: [],
				};
			},
		});
		expect(cancelled.matches).toEqual([]);
		expect(cancelled.reports[0]?.report.candidates[0]).toMatchObject({
			status: "skipped",
			reason: "analysis cancelled",
		});
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

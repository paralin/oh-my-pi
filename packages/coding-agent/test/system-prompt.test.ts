import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "../src/system-prompt";

describe("IPython system prompt", () => {
	it("renders only the fixed runtime ABI before volatile notices", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			calendarDate: "2026-08-06",
			contextFiles: [],
			cwd: "/workspace/omp",
			recursiveDepth: 2,
			resolvedSystemPromptCustomization: null,
			sessionLogLocation: "/tmp/session.jsonl",
			sessionNotice: "subagent",
		});

		expect(systemPrompt).toHaveLength(2);
		expect(systemPrompt[0]).toContain("exclusive `ipython`");
		expect(systemPrompt[0]).toContain('{ "code": "<cell>" }');
		expect(systemPrompt[0]).toContain("%%bash");
		expect(systemPrompt[0]).toContain("persists through turns and compaction");
		expect(systemPrompt[0]).toContain("separate subshell");
		expect(systemPrompt[0]).toContain("external project through its native environment");
		expect(systemPrompt[0]).toContain("`rlm` and installed Python skills are preloaded");
		expect(systemPrompt[0]).toContain("`SKILL.md`");
		expect(systemPrompt[0]).toContain("appended operator and project instructions");
		expect(systemPrompt[1]).toContain("Today is 2026-08-06.");
		expect(systemPrompt[1]).toContain("Session log: /tmp/session.jsonl.");
		expect(systemPrompt[1]).toContain("Session: subagent.");
		expect(systemPrompt[1]).toContain("Recursive depth: 2.");
	});

	it("does not expose removed catalogs or workstation inventory", async () => {
		const { systemPrompt } = await buildSystemPrompt({
			calendarDate: "2026-08-06",
			contextFiles: [],
			cwd: "/workspace/omp",
			resolvedSystemPromptCustomization: null,
		});
		const rendered = systemPrompt.join("\n\n");

		for (const removedContent of [
			"# Tool Inventory",
			"namespace functions",
			"<workstation>",
			"<workspace-tree>",
			"<personality>",
			"skill://",
		]) {
			expect(rendered).not.toContain(removedContent);
		}
	});
});

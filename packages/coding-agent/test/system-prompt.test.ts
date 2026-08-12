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
		for (const required of [
			"exclusive `ipython`",
			'{ "code": "<cell>" }',
			"persistent Python scratchpad",
			"Bind retained values to descriptive durable names",
			"Treat output as a budget",
			"Use the preloaded `await run(cmd)` for finite supervised commands",
			"batch adjacent reads, searches, parsing, and focused checks",
			"external project through its native environment",
			"Do not install project dependencies into the kernel",
			"`%%bash` on the first substantive line",
			"Each `%%bash` cell is a fresh subshell",
			"`%cd` or `os.environ`",
			"OMP serializes cells",
			"rejects the whole cell and never splits it",
			"`$ code` and `$$ code`",
			"kernel ends with the session",
			"`rlm`, `omp`, `helpers`, `show`, `rg`, `run`, and installed Python skills are preloaded",
			"returns a handle, not its answer",
			"Do not guess host capability names or signatures",
			"Ordinary local Python helper functions are allowed",
			"`await rlm.list_subagents()`",
			"await agent_message.send",
			"`SKILL.md`",
			"`inspect.signature`",
			"Await every async skill or host call",
			"`omp.capabilities()` as the bounded authoritative index",
			"host retains permissions, credentials, persistence, cancellation, and side effects",
			"appended operator and project instructions",
		])
			expect(systemPrompt[0]).toContain(required);
		for (const volatile of ["2026-08-06", "/workspace/omp", "/tmp/session.jsonl", "Session: subagent."])
			expect(systemPrompt[0]).not.toContain(volatile);
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

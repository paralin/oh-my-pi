import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	applyOpsToPhases,
	markdownToPhases,
	nextActionableTask,
	phasesToMarkdown,
	resolveTodoMarkdownPath,
} from "../../src/tools/todo.js";

describe("host todo state", () => {
	it("starts the first task and advances after completion", () => {
		const initialized = applyOpsToPhases(
			[],
			[{ op: "init", list: [{ phase: "Execution", items: ["inspect", "verify"] }] }],
		);
		expect(initialized.errors).toEqual([]);
		expect(initialized.phases[0]?.tasks.map(task => task.status)).toEqual(["in_progress", "pending"]);

		const completed = applyOpsToPhases(initialized.phases, [{ op: "done", task: "inspect" }]);
		expect(completed.errors).toEqual([]);
		expect(completed.phases[0]?.tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
	});

	it("round-trips persisted phases including blocker reasons", () => {
		const phases = [
			{
				name: "Verification",
				tasks: [{ content: "wait for CI", status: "blocked" as const, blocker: "CI is running" }],
			},
		];
		const parsed = markdownToPhases(phasesToMarkdown(phases));
		expect(parsed.errors).toEqual([]);
		expect(parsed.phases).toEqual(phases);
	});

	it("selects an in-progress task before pending work", () => {
		expect(
			nextActionableTask([
				{ name: "First", tasks: [{ content: "pending", status: "pending" }] },
				{ name: "Second", tasks: [{ content: "active", status: "in_progress" }] },
			])?.content,
		).toBe("active");
	});

	it("resolves an omitted todo file below the workspace", () => {
		const cwd = path.resolve("tmp", "todo-workspace");
		expect(resolveTodoMarkdownPath("", cwd)).toBe(path.join(cwd, "TODO.md"));
	});
});

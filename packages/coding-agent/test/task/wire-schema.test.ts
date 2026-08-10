import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { taskSchema } from "@oh-my-pi/pi-coding-agent/task";
import { getTaskSchema, oneLineLabel } from "@oh-my-pi/pi-coding-agent/task/types";

// Contract: the task tool's wire shape is flat `{ name?, agent?, task, isolated? }`
// (batch: `{ context, tasks[] }` of the same items). `agent` defaults to the
// schema's spawn-policy default, and unknown keys sent by stale callers (`role`,
// `description`) are stripped by the schema's `+: "delete"` — never rejected.

describe("oneLineLabel", () => {
	it("returns short text unchanged", () => {
		expect(oneLineLabel("DB migration specialist")).toBe("DB migration specialist");
	});

	it("collapses control and zero-width characters that \\s alone misses", () => {
		// U+0085 (NEL) and U+200B (zero-width space) are NOT matched by \s, so a
		// bare replace(/\s+/) would leak them into a prompt/roster field.
		const out = oneLineLabel("Auth\u0085flow\u200breviewer");
		expect(out).toBe("Auth flow reviewer");
		expect(out).not.toMatch(/[\p{Cc}\p{Cf}]/u);
	});

	it("respects a minimal cap without a negative-slice blowup", () => {
		expect(oneLineLabel("abcdef", 1)).toBe("…");
		expect(oneLineLabel("abcdef", 0)).toBe("…");
	});

	it("truncates on a code-point boundary without splitting a surrogate pair", () => {
		// The cut would land mid-emoji at the default cap; the result must stay
		// well-formed (a lone surrogate makes encodeURIComponent throw).
		const out = oneLineLabel(`${"a".repeat(78)}😀tail`);
		expect(out.endsWith("…")).toBe(true);
		expect(() => encodeURIComponent(out)).not.toThrow();
	});
});

/** Narrow a parsed batch payload to its items; fails the test on any other shape. */
function parsedItems(parsed: unknown): Array<Record<string, unknown>> {
	if (parsed instanceof type.errors) throw new Error(`schema rejected input: ${parsed.summary}`);
	if (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks)) {
		return parsed.tasks;
	}
	throw new Error("expected a batch parse result with tasks[]");
}

describe("task wire schema", () => {
	it("accepts the flat { name, agent, task } shape", () => {
		const parsed = taskSchema({ name: "AuthLoader", agent: "scout", task: "map the auth flow" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.name).toBe("AuthLoader");
			expect(parsed.agent).toBe("scout");
			expect(parsed.task).toBe("map the auth flow");
		}
	});

	it("defaults a missing agent to 'task'", () => {
		const parsed = taskSchema({ task: "x" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect(parsed.agent).toBe("task");
		}
	});

	it("deletes stale caller keys (role, description) instead of rejecting", () => {
		const parsed = taskSchema({ agent: "task", task: "x", role: "Rust specialist", description: "stale ui label" });
		expect(parsed instanceof type.errors).toBe(false);
		if (!(parsed instanceof type.errors)) {
			expect("role" in parsed).toBe(false);
			expect("description" in parsed).toBe(false);
			expect(parsed.task).toBe("x");
		}
	});

	it("defaults batch item agents to 'task' on the fast path and keeps names", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const items = parsedItems(batch({ context: "ctx", tasks: [{ name: "DbMigrator", task: "x" }] }));
		expect(items[0]?.agent).toBe("task");
		expect(items[0]?.name).toBe("DbMigrator");
	});

	it("defaults batch item agents to the schema's defaultAgent", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true, defaultAgent: "scout" });
		const items = parsedItems(batch({ context: "ctx", tasks: [{ task: "x" }, { agent: "reviewer", task: "y" }] }));
		expect(items[0]?.agent).toBe("scout");
		expect(items[1]?.agent).toBe("reviewer");
	});

	it("deletes stale keys from batch items", () => {
		const batch = getTaskSchema({ isolationEnabled: false, batchEnabled: true });
		const items = parsedItems(batch({ context: "ctx", tasks: [{ task: "x", role: "DB migration specialist" }] }));
		const item = items[0] ?? {};
		expect("role" in item).toBe(false);
		expect(item.task).toBe("x");
	});
});

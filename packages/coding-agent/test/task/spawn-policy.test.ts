import { describe, expect, it } from "bun:test";
import initAgentPrompt from "../../src/prompts/agents/init.md" with { type: "text" };
import { isScoutSpawnable } from "../../src/task/spawn-policy";
import { getTaskSchema } from "../../src/task/types";

describe("task spawn policy", () => {
	it("uses the first allowed spawn as the schema default", () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false, defaultAgent: "fact-finder" });
		const parsed = schema({ task: "check" });

		expect(parsed).toEqual({ agent: "fact-finder", task: "check" });
	});
});

describe("isScoutSpawnable", () => {
	it("is true with no disabled agents and unrestricted spawns", () => {
		expect(isScoutSpawnable(undefined, "*")).toBe(true);
		expect(isScoutSpawnable([], "*")).toBe(true);
	});

	it("is false when scout is disabled via task.disabledAgents", () => {
		expect(isScoutSpawnable(["scout"], "*")).toBe(false);
		expect(isScoutSpawnable(["scout", "reviewer"], "*")).toBe(false);
	});

	it("is false when spawning is disabled", () => {
		expect(isScoutSpawnable(undefined, false)).toBe(false);
		expect(isScoutSpawnable(undefined, "")).toBe(false);
	});

	it("is false when scout is not in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "reviewer")).toBe(false);
	});

	it("is true when scout is in the allowed spawn list", () => {
		expect(isScoutSpawnable(undefined, "scout,reviewer")).toBe(true);
		expect(isScoutSpawnable(["reviewer"], "scout")).toBe(true);
	});
});

describe("bundled agent prompt scout gating", () => {
	it("does not hard-code scout in the init agent prompt", () => {
		expect(initAgentPrompt.toLowerCase()).not.toContain("scout");
		expect(initAgentPrompt).toContain("multiple research agents");
	});
});

import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";

describe("parseArgs — headless goal flags", () => {
	it("parses --goal and --goal-budget for print mode", () => {
		const result = parseArgs([
			"--print",
			"--mode",
			"json",
			"--goal",
			"finish the scope",
			"--goal-budget",
			"50000",
			"start",
		]);

		expect(result.print).toBe(true);
		expect(result.mode).toBe("json");
		expect(result.goal).toBe("finish the scope");
		expect(result.goalBudget).toBe(50000);
		expect(result.messages).toEqual(["start"]);
	});
});

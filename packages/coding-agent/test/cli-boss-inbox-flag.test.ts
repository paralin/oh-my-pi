import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

describe("parseArgs — --boss-inbox flag", () => {
	it("parses the flag without consuming the prompt", () => {
		const result = parseArgs(["--boss-inbox", "review", "the", "status"]);

		expect(result.bossInbox).toBe(true);
		expect(result.messages).toEqual(["review", "the", "status"]);
		expect(result.unrecognizedFlags).toEqual([]);
	});

	it("preserves a following profile selection", () => {
		const extracted = extractProfileFlags(["--boss-inbox", "--profile", "work", "summarize"]);
		const result = parseArgs(extracted.argv);

		expect(extracted.profile).toBe("work");
		expect(result.bossInbox).toBe(true);
		expect(result.messages).toEqual(["summarize"]);
		expect(result.unrecognizedFlags).toEqual([]);
	});
});

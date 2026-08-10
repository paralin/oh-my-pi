import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { parseConventionalAnalysisResponse } from "@oh-my-pi/pi-coding-agent/commit/shared-llm";

describe("commit shared LLM parsing", () => {
	it("parses the assistant JSON analysis", () => {
		const message = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: JSON.stringify({ type: "fix", scope: null, details: [], issue_refs: [] }),
				},
			],
		} as unknown as AssistantMessage;

		expect(parseConventionalAnalysisResponse(message)).toEqual({
			type: "fix",
			scope: null,
			details: [],
			issueRefs: [],
		});
	});
});

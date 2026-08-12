import { describe, expect, test } from "bun:test";
import { validateSummaryRules } from "@oh-my-pi/pi-coding-agent/commit/agentic/validation";
import { validateAnalysis } from "@oh-my-pi/pi-coding-agent/commit/analysis/validation";
import { formatCommitMessage } from "@oh-my-pi/pi-coding-agent/commit/message";
import type { ConventionalAnalysis } from "@oh-my-pi/pi-coding-agent/commit/types";

function analysis(details: ConventionalAnalysis["details"]): ConventionalAnalysis {
	return { type: "fix", scope: "commit", details, issueRefs: [] };
}

describe("commit message contract", () => {
	test("accepts lowercase subjects without an imperative-verb allowlist", () => {
		// "quarantine" is deliberately outside the canned commit-verb examples.
		expect(validateSummaryRules("quarantine stale prompt snapshots").errors).toEqual([]);
	});

	test("rejects uppercase and recognized past-tense openings", () => {
		expect(validateSummaryRules("Quarantine stale prompt snapshots").errors).toContain(
			"Summary must start with a lowercase word",
		);
		expect(validateSummaryRules("restored prompt snapshots").errors).toContain(
			"Summary must not start with a recognized past-tense verb",
		);
	});

	test("formats validated details as prose body paragraphs", () => {
		const commitAnalysis = analysis([
			{ text: "The retry retains the provider response.", userVisible: false },
			{ text: "The formatter keeps each body paragraph readable.", userVisible: false },
		]);

		expect(validateAnalysis(commitAnalysis)).toEqual({ valid: true, errors: [] });
		expect(formatCommitMessage(commitAnalysis, "retain provider response")).toBe(
			"fix(commit): retain provider response\n\nThe retry retains the provider response.\n\nThe formatter keeps each body paragraph readable.",
		);

		const invalid = validateAnalysis(
			analysis([
				{ text: "- The retry retains the provider response.", userVisible: false },
				{ text: "The formatter retains output.\nIt keeps paragraphs separate.", userVisible: false },
			]),
		);
		expect(invalid.errors).toContain(
			"Detail must be prose, not a list item: - The retry retains the provider response.",
		);
		expect(invalid.errors).toContain(
			"Detail must be a single paragraph: The formatter retains output.\nIt keeps paragraphs separate.",
		);
	});
});

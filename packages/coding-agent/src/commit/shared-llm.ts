import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type as t } from "@oh-my-pi/pi-ai";
import type { ChangelogCategory, ConventionalAnalysis } from "./types";
import { extractTextContent, normalizeAnalysis, parseJsonPayload } from "./utils";

const changelogCategoryLiteral = t(
	"'Added' | 'Changed' | 'Fixed' | 'Deprecated' | 'Removed' | 'Security' | 'Breaking Changes'",
);

/** Shared schema for single-pass and map-reduce JSON analysis responses. */
const detailItem = t({
	text: "string",
	"changelog_category?": changelogCategoryLiteral,
	"user_visible?": "boolean",
});

export const conventionalAnalysisParameters = t({
	type: "'feat' | 'fix' | 'refactor' | 'docs' | 'test' | 'chore' | 'style' | 'perf' | 'build' | 'ci' | 'revert'",
	scope: t("string").or("null"),
	details: detailItem.array(),
	issue_refs: "string[]",
});

interface ParsedConventionalAnalysis {
	type: ConventionalAnalysis["type"];
	scope: string | null;
	details: Array<{ text: string; changelog_category?: ChangelogCategory; user_visible?: boolean }>;
	issue_refs: string[];
}

/** Parse and validate the assistant's JSON analysis response. */
export function parseConventionalAnalysisResponse(message: AssistantMessage): ConventionalAnalysis {
	const text = extractTextContent(message);
	const parsed = conventionalAnalysisParameters.assert(parseJsonPayload(text)) as ParsedConventionalAnalysis;
	return normalizeAnalysis(parsed);
}

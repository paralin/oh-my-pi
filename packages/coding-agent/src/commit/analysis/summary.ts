import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import summarySystemPrompt from "../../commit/prompts/summary-system.md" with { type: "text" };
import summaryUserPrompt from "../../commit/prompts/summary-user.md" with { type: "text" };
import type { CommitSummary } from "../../commit/types";
import { RequestProfileOwner } from "../../session/request-profile";
import { toReasoningEffort } from "../../thinking";
import { extractTextContent } from "../utils";

export interface SummaryInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	commitType: string;
	scope: string | null;
	details: string[];
	stat: string;
	maxChars: number;
	userContext?: string;
}

/**
 * Generate a commit summary line for the conventional commit header.
 */
export async function generateSummary({
	model,
	apiKey,
	thinkingLevel,
	commitType,
	scope,
	details,
	stat,
	maxChars,
	userContext,
}: SummaryInput): Promise<CommitSummary> {
	const systemPrompt = renderSummaryPrompt({ commitType, scope, maxChars });
	const userPrompt = prompt.render(summaryUserPrompt, {
		user_context: userContext,
		details: details.join("\n"),
		stat,
	});

	const requestProfile = RequestProfileOwner.noTools([systemPrompt]);
	const response = await requestProfile.complete(
		model,
		[{ role: "user", content: userPrompt, timestamp: Date.now() }],
		{ apiKey, maxTokens: 200, reasoning: toReasoningEffort(thinkingLevel) },
	);

	return parseSummaryFromResponse(response, commitType, scope);
}

function renderSummaryPrompt({
	commitType,
	scope,
	maxChars,
}: {
	commitType: string;
	scope: string | null;
	maxChars: number;
}): string {
	const scopePrefix = scope ? `(${scope})` : "";
	return prompt.render(summarySystemPrompt, {
		commit_type: commitType,
		scope_prefix: scopePrefix,
		chars: String(maxChars),
	});
}

function parseSummaryFromResponse(message: AssistantMessage, commitType: string, scope: string | null): CommitSummary {
	const text = extractTextContent(message);
	return { summary: stripTypePrefix(text, commitType, scope) };
}

export function stripTypePrefix(summary: string, commitType: string, scope: string | null): string {
	const trimmed = summary.trim();
	const scopePart = scope ? `(${scope})` : "";
	const withScope = `${commitType}${scopePart}: `;
	if (trimmed.startsWith(withScope)) {
		return trimmed.slice(withScope.length).trim();
	}
	const withoutScope = `${commitType}: `;
	if (trimmed.startsWith(withoutScope)) {
		return trimmed.slice(withoutScope.length).trim();
	}
	return trimmed;
}

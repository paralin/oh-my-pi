import type { ConventionalAnalysis } from "./types";

export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string): string {
	const scopePart = analysis.scope ? `(${analysis.scope})` : "";
	const header = `${analysis.type}${scopePart}: ${summary}`;
	const bodyParagraphs = analysis.details.map(detail => detail.text.trim());
	if (bodyParagraphs.length === 0) {
		return header;
	}
	return `${header}\n\n${bodyParagraphs.join("\n\n")}`;
}

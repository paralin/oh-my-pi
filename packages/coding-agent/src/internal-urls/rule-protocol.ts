/**
 * Protocol handler for rule:// URLs.
 *
 * URL forms:
 * - rule://<name> - Reads rule content
 */
import { getActiveRules } from "../capability/rule";
import type { InternalResource, InternalUrl, ProtocolHandler, UrlCompletion } from "./types";

export class RuleProtocolHandler implements ProtocolHandler {
	readonly scheme = "rule";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const rules = getActiveRules();

		const ruleName = url.rawHost || url.hostname;
		if (!ruleName) {
			throw new Error("rule:// URL requires a rule name: rule://<name>");
		}

		const rule = rules.find(r => r.name === ruleName);
		if (!rule) {
			const available = rules.map(r => r.name);
			const availableStr = available.length > 0 ? available.join(", ") : "none";
			throw new Error(`Unknown rule: ${ruleName}\nAvailable: ${availableStr}`);
		}
		const content = rule.semanticCondition
			? `${rule.content.trimEnd()}\n\n## Semantic conditions\n\n\`\`\`json\n${JSON.stringify(rule.semanticCondition, null, 2)}\n\`\`\`\n`
			: rule.content;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: rule.path,
			notes: [],
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveRules().map(rule => ({
			value: rule.name,
			...(rule.description ? { description: rule.description } : {}),
		}));
	}
}

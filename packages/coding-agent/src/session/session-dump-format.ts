/**
 * Plain-text / markdown session formatting for `/dump` and `/advisor dump raw`.
 *
 * Renders a prelude (system prompt, model/thinking config, tool inventory)
 * followed by the message history as per-message markdown headings: `## User`,
 * `## Assistant` (with `<thinking>` blocks and `### Tool Call: <name>` + YAML
 * args), `### Tool Result: <name>`, and the execution/summary sections.
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { YAML } from "bun";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, isIpythonJournalDetail, renderIpythonJournalText } from "../ipython/journal";
import { canonicalizeMessage } from "../utils/thinking-display";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	bashExecutionToText,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	pythonExecutionToText,
} from "./messages";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
}

function renderToolInventory(tools: readonly SessionDumpToolInfo[]): string {
	return tools.map(tool => `### ${tool.name}\n${tool.description}`).join("\n\n");
}

function renderThinking(text: string): string {
	const trimmed = text.trim();
	if (trimmed.startsWith("<thinking>") && trimmed.endsWith("</thinking>")) return trimmed;
	return `<thinking>\n${trimmed}\n</thinking>`;
}

/** System prompt + model/thinking config + tool inventory — shared by both transcript styles. */
function renderDumpHeader(
	options: FormatSessionDumpTextOptions,
	inventoryTools: readonly SessionDumpToolInfo[],
): string[] {
	const lines: string[] = [];

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(systemPrompt[index]);
			lines.push("\n");
		}
	}

	const model = options.model;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model ? `${model.provider}/${model.id}` : "(not selected)"}`);
	lines.push(`Thinking Level: ${options.thinkingLevel ?? ""}`);
	lines.push("\n");

	if (inventoryTools.length > 0) {
		lines.push("## Available Tools\n");
		lines.push(renderToolInventory(inventoryTools));
		lines.push("\n");
	}

	return lines;
}

/** Append the legacy per-message markdown-heading transcript (the pre-16.x `/dump` body). */
function appendMarkdownTranscript(lines: string[], messages: readonly AgentMessage[]): void {
	for (const msg of messages) {
		if (msg.role === "user" || msg.role === "developer") {
			lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else {
				for (const c of msg.content) {
					if (c.type === "text") lines.push(c.text);
					else if (c.type === "image") lines.push("[Image]");
				}
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");
			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					lines.push(c.text);
				} else if (c.type === "thinking") {
					const thinking = canonicalizeMessage(c.thinking);
					if (thinking.length === 0) continue;
					// Unwrap any literal `<thinking>` envelope already present in the
					// block (e.g. Opus 4.5 — issue #2700) so the dump never nests tags.
					lines.push(`${renderThinking(thinking)}\n`);
				} else if (c.type === "toolCall") {
					lines.push(`### Tool Call: ${c.name}`);
					const rawArgs = c.arguments as Record<string, unknown> | undefined;
					if (rawArgs && typeof rawArgs === "object") {
						if (Object.keys(rawArgs).length > 0) {
							lines.push("```yaml");
							lines.push(YAML.stringify(rawArgs, null, 2).trimEnd());
							lines.push("```\n");
						}
					}
				}
			}
			lines.push("");
		} else if (msg.role === "toolResult") {
			lines.push(`### Tool Result: ${msg.toolName}`);
			if (msg.isError) lines.push("(error)");
			for (const c of msg.content) {
				if (c.type === "text") {
					lines.push("```");
					lines.push(c.text);
					lines.push("```");
				} else if (c.type === "image") {
					lines.push("[Image output]");
				}
			}
			lines.push("");
		} else if (msg.role === "bashExecution") {
			const bashMsg = msg as BashExecutionMessage;
			if (!bashMsg.excludeFromContext) {
				lines.push("## Bash Execution\n");
				lines.push(bashExecutionToText(bashMsg));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				lines.push(pythonExecutionToText(pythonMsg));
				lines.push("\n");
			}
		} else if (msg.role === "custom" || msg.role === "hookMessage") {
			const customMsg = msg as CustomMessage | HookMessage;
			if (customMsg.customType === IPYTHON_JOURNAL_MESSAGE_TYPE && isIpythonJournalDetail(customMsg.details)) {
				lines.push("## IPython\n", renderIpythonJournalText(customMsg.details), "\n");
				continue;
			}
			lines.push(`## ${customMsg.customType}\n`);
			if (typeof customMsg.content === "string") {
				lines.push(customMsg.content);
			} else {
				for (const c of customMsg.content) {
					if (c.type === "text") lines.push(c.text);
					else if (c.type === "image") lines.push("[Image]");
				}
			}
			lines.push("\n");
		} else if (msg.role === "branchSummary") {
			const branchMsg = msg as BranchSummaryMessage;
			lines.push("## Branch Summary\n");
			lines.push(`(from branch: ${branchMsg.fromId})\n`);
			lines.push(branchMsg.summary);
			lines.push("\n");
		} else if (msg.role === "compactionSummary") {
			const compactMsg = msg as CompactionSummaryMessage;
			lines.push("## Compaction Summary\n");
			lines.push(`(${compactMsg.tokensBefore} tokens before compaction)\n`);
			lines.push(compactMsg.summary);
			lines.push("\n");
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			lines.push("## File Mention\n");
			for (const file of fileMsg.files) {
				lines.push(`<file path="${file.path}">`);
				if (file.content) lines.push(file.content);
				if (file.image) lines.push("[Image attached]");
				lines.push("</file>\n");
			}
			lines.push("\n");
		}
	}
}

/**
 * Format messages and session metadata as markdown/plain text (same as
 * AgentSession.formatSessionAsText / /dump).
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const inventoryTools = options.tools ?? [];
	const lines = renderDumpHeader(options, inventoryTools);
	appendMarkdownTranscript(lines, options.messages);
	return lines.join("\n").trim();
}

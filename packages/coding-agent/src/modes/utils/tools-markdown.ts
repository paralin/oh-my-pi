import type { AgentTool } from "@oh-my-pi/pi-agent-core";

export interface ToolsMarkdownBindings {
	tools: ReadonlyArray<Pick<AgentTool<any, any, any>, "description" | "name">>;
}

function escapeTableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/\r?\n+/g, " ")
		.trim();
}

export function buildToolsMarkdown(bindings: ToolsMarkdownBindings): string {
	if (bindings.tools.length === 0) {
		return "No tools are currently visible to the agent.";
	}

	const rows: string[] = [];
	for (const tool of bindings.tools) {
		const description = escapeTableCell(tool.description) || "No description provided.";
		rows.push(`| \`${tool.name}\` | ${description} |`);
	}

	return ["| Tool | Description |", "|------|-------------|", ...rows].join("\n");
}

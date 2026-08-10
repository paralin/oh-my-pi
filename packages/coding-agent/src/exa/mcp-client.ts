import { $env, logger } from "@oh-my-pi/pi-utils";
import { type CallMcpOptions, callMCP } from "../mcp/json-rpc";
import type { ExaSearchResponse, MCPCallResponse, MCPTool, MCPToolsResponse } from "./types";

/** Find EXA_API_KEY from Bun.env or .env files */
export function findApiKey(): string | null {
	return $env.EXA_API_KEY;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null) return null;
	return value as Record<string, unknown>;
}

function parseJsonContent(text: string): unknown | null {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Normalize tools/call payloads across MCP servers.
 *
 * Exa currently returns different shapes depending on deployment/environment:
 * - direct payload in result
 * - structured payload under result.structuredContent / result.data / result.result
 * - JSON payload embedded as text in result.content[]
 */
function normalizeMcpToolPayload(payload: unknown): unknown {
	const candidates: unknown[] = [];
	const root = asRecord(payload);

	if (root) {
		if (root.structuredContent !== undefined) candidates.push(root.structuredContent);
		if (root.data !== undefined) candidates.push(root.data);
		if (root.result !== undefined) candidates.push(root.result);
		candidates.push(root);

		const content = root.content;
		if (Array.isArray(content)) {
			for (const item of content) {
				const part = asRecord(item);
				if (!part) continue;
				const text = part.text;
				if (typeof text !== "string" || text.trim().length === 0) continue;
				const parsed = parseJsonContent(text);
				if (parsed !== null) candidates.push(parsed);
			}
		}
	} else {
		candidates.push(payload);
	}

	for (const candidate of candidates) {
		if (isSearchResponse(candidate)) {
			return candidate;
		}
	}

	return payload;
}

/** Fetch available tools from Exa MCP */
export async function fetchExaTools(apiKey: string | null, toolNames: string[]): Promise<MCPTool[]> {
	const params = new URLSearchParams();
	if (apiKey) params.set("exaApiKey", apiKey);
	params.set("toolNames", toolNames.join(","));
	const url = `https://mcp.exa.ai/mcp?${params.toString()}`;
	const response = (await callMCP(url, "tools/list")) as MCPToolsResponse;

	if (response.error) {
		logger.error("MCP tools/list error", { toolNames, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result?.tools ?? [];
}

/** Fetch available tools from Websets MCP */
export async function fetchWebsetsTools(apiKey: string): Promise<MCPTool[]> {
	const url = `https://websetsmcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}`;
	const response = (await callMCP(url, "tools/list")) as MCPToolsResponse;

	if (response.error) {
		logger.error("Websets MCP tools/list error", { error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return response.result?.tools ?? [];
}

/** Call a tool on Exa MCP (simplified: toolName as first arg for easier use) */
export async function callExaTool(
	toolName: string,
	args: Record<string, unknown>,
	apiKey: string | null,
	options?: CallMcpOptions,
): Promise<unknown> {
	const params = new URLSearchParams();
	if (apiKey) params.set("exaApiKey", apiKey);
	params.set("tools", toolName);
	const url = `https://mcp.exa.ai/mcp?${params.toString()}`;
	const response = (await callMCP(
		url,
		"tools/call",
		{
			name: toolName,
			arguments: args,
		},
		options,
	)) as MCPCallResponse;

	if (response.error) {
		logger.error("MCP tools/call error", { toolName, args, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return normalizeMcpToolPayload(response.result);
}

/** Call a tool on Websets MCP */
export async function callWebsetsTool(
	apiKey: string,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const url = `https://websetsmcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(apiKey)}`;
	const response = (await callMCP(url, "tools/call", {
		name: toolName,
		arguments: args,
	})) as MCPCallResponse;

	if (response.error) {
		logger.error("Websets MCP tools/call error", { toolName, args, error: response.error });
		throw new Error(`MCP error: ${response.error.message}`);
	}

	return normalizeMcpToolPayload(response.result);
}

/** Format search results for LLM */
export function formatSearchResults(data: ExaSearchResponse): string {
	const results = data.results ?? [];
	if (results.length === 0) return "No results found.";

	let output = "";
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		output += `\n## ${r.title ?? "Untitled"}`;
		if (r.url) output += `\n**URL:** ${r.url}`;
		if (r.author) output += `\n**Author:** ${r.author}`;
		if (r.publishedDate) output += `\n**Published Date:** ${r.publishedDate}`;
		if (r.text) output += `\n**Text:** ${r.text}`;
		if (r.highlights?.length) {
			output += `\n**Highlights:**`;
			for (const h of r.highlights) {
				output += `\n- ${h}`;
			}
		}
		output += "\n";
	}

	if (data.costDollars) {
		output += `\n**Cost:** $${data.costDollars.total.toFixed(4)}`;
	}
	if (data.searchTime) {
		output += `\n**Search Time:** ${data.searchTime.toFixed(2)}s`;
	}

	return output.trim();
}
/**
 * Format a non-search MCP response as human-readable text.
 * Handles objects, arrays, primitives, and common MCP response shapes.
 */
export function formatGenericResponse(data: unknown): string {
	if (data === null || data === undefined) return "No result.";
	if (typeof data === "string") return data;
	if (typeof data === "number" || typeof data === "boolean") return String(data);

	if (Array.isArray(data)) {
		if (data.length === 0) return "(empty)";
		const parts: string[] = [];
		for (let i = 0; i < data.length; i++) {
			const item = data[i];
			if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>;
				const title = (record.title ?? record.name ?? record.id ?? `Item ${i + 1}`) as string;
				parts.push(`\n### ${title}`);
				for (const [k, v] of Object.entries(record)) {
					if (["title", "name", "id"].includes(k)) continue;
					parts.push(`- **${k}:** ${formatValue(v)}`);
				}
			} else {
				parts.push(`- ${formatValue(item)}`);
			}
		}
		return parts.join("\n");
	}

	if (typeof data === "object") {
		const record = data as Record<string, unknown>;
		if (record.content && Array.isArray(record.content)) {
			// MCP-style content array — extract text blocks
			const texts = record.content
				.filter(
					(c: unknown): c is { type: string; text?: string } =>
						typeof c === "object" && c !== null && (c as Record<string, unknown>)?.type === "text",
				)
				.map(c => c.text ?? "")
				.filter(Boolean);
			if (texts.length > 0) return texts.join("\n");
		}

		const lines: string[] = [];
		for (const [k, v] of Object.entries(record)) {
			if (k === "content") continue; // handled above
			if (v === null || v === undefined) continue;
			if (typeof v === "object") {
				const formatted = formatGenericResponse(v);
				if (formatted) lines.push(`- **${k}:**\n${indent(formatted, 2)}`);
			} else {
				lines.push(`- **${k}:** ${formatValue(v)}`);
			}
		}
		return lines.join("\n") || "(empty)";
	}

	return String(data);
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function indent(text: string, spaces: number): string {
	const pad = " ".repeat(spaces);
	return text
		.split("\n")
		.map(line => pad + line)
		.join("\n");
}

/** Check if result is a search response */
export function isSearchResponse(data: unknown): data is ExaSearchResponse {
	return (
		typeof data === "object" &&
		data !== null &&
		("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data)
	);
}

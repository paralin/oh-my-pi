/**
 * Exa MCP Types
 *
 * Types for the Exa MCP client and tool implementations.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";

/** MCP tool definition from server */
export interface MCPTool {
	name: string;
	description: string;
	inputSchema: TSchema;
}

/** MCP tools/list response */
export interface MCPToolsResponse {
	result?: {
		tools: MCPTool[];
	};
	error?: {
		code: number;
		message: string;
	};
}

/** MCP tools/call response */
export interface MCPCallResponse {
	result?: {
		content?: Array<{ type: string; text?: string }>;
	};
	error?: {
		code: number;
		message: string;
	};
}

/** Search result from Exa */
export interface ExaSearchResult {
	id?: string;
	title?: string;
	url?: string;
	author?: string;
	publishedDate?: string;
	text?: string;
	highlights?: string[];
	image?: string;
	favicon?: string;
}

/** Search response from Exa */
export interface ExaSearchResponse {
	results?: ExaSearchResult[];
	statuses?: Array<{ id: string; status: string; source?: string }>;
	costDollars?: { total: number };
	searchTime?: number;
	requestId?: string;
}

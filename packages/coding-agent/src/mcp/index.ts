/**
 * MCP (Model Context Protocol) support.
 *
 * Provides per-project .mcp.json configuration for connecting to
 * MCP servers via stdio or HTTP transports.
 */

// Client
export * from "./client";
// Config
export * from "./config";
export * from "./config-writer";
// JSON-RPC (lightweight HTTP-based MCP calls)
export { callMCP, parseSSE } from "./json-rpc";
// Manager
export * from "./manager";
// OAuth Discovery
export * from "./oauth-discovery";
// Transports
export * from "./transports/http";
export * from "./transports/stdio";
// Types
export * from "./types";

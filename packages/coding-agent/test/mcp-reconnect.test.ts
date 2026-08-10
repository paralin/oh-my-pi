import { describe, expect, it } from "bun:test";
import { isRetriableConnectionError } from "@oh-my-pi/pi-coding-agent/mcp/reconnect";

describe("isRetriableConnectionError", () => {
	const retriable = [
		"ECONNREFUSED",
		"ECONNRESET",
		"EPIPE",
		"ENETUNREACH",
		"EHOSTUNREACH",
		"fetch failed",
		"Transport not connected",
		"network error",
		"HTTP 404: Not Found",
		"HTTP 502: Bad Gateway",
		"HTTP 503: Service Unavailable",
		"Transport closed",
	];

	for (const msg of retriable) {
		it(`matches: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(true);
		});
	}

	const nonRetriable = [
		"MCP error -32603: Server still initializing",
		"HTTP 401: Unauthorized",
		"HTTP 403: Forbidden",
		"HTTP 400: Bad Request",
		"Request timeout after 30000ms",
		"SSE response timeout after 30000ms",
		"Tool not found: do_stuff",
	];

	for (const msg of nonRetriable) {
		it(`does not match: ${msg}`, () => {
			expect(isRetriableConnectionError(new Error(msg))).toBe(false);
		});
	}

	it("returns false for non-Error values", () => {
		expect(isRetriableConnectionError("ECONNREFUSED")).toBe(false);
		expect(isRetriableConnectionError(null)).toBe(false);
		expect(isRetriableConnectionError(undefined)).toBe(false);
		expect(isRetriableConnectionError({ message: "ECONNREFUSED" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// MCP client retry behavior
// ---------------------------------------------------------------------------

import { describe, expect, it } from "bun:test";
import { sortMCPToolSummaries } from "@oh-my-pi/pi-coding-agent/mcp/manager";

describe("sortMCPToolSummaries", () => {
	it("orders by server and raw tool name", () => {
		const tools = [
			{ serverName: "zeta", name: "alpha" },
			{ serverName: "alpha", name: "zeta" },
			{ serverName: "alpha", name: "alpha" },
		];
		expect(sortMCPToolSummaries(tools)).toEqual([
			{ serverName: "alpha", name: "alpha" },
			{ serverName: "alpha", name: "zeta" },
			{ serverName: "zeta", name: "alpha" },
		]);
	});

	it("produces the same output regardless of connection order", () => {
		const a = sortMCPToolSummaries([
			{ serverName: "one", name: "shared" },
			{ serverName: "two", name: "shared" },
		]);
		const b = sortMCPToolSummaries([
			{ serverName: "two", name: "shared" },
			{ serverName: "one", name: "shared" },
		]);
		expect(a).toEqual(b);
	});

	it("sorts in place", () => {
		const tools = [
			{ serverName: "b", name: "x" },
			{ serverName: "a", name: "x" },
		];
		expect(sortMCPToolSummaries(tools)).toBe(tools);
	});
});

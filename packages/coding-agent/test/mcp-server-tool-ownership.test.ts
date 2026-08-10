/** Exact server names determine MCP summary ownership. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");
const SHORT_SERVER = "atlassian";
const COLON_SERVER = "atlassian:atlassian";
const FIRST_TOOL = manyToolName(0);

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

describe("MCP summary ownership with prefix-colliding server names", () => {
	let workDir: string;
	let manager: MCPManager;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-ownership-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
	});

	it("refreshing one server keeps the sibling server's summaries", async () => {
		await manager.connectServers({ [SHORT_SERVER]: fixtureConfig(), [COLON_SERVER]: fixtureConfig() }, {});
		await Promise.all([manager.waitForConnection(SHORT_SERVER), manager.waitForConnection(COLON_SERVER)]);
		const summaries = () => manager.getTools();
		expect(summaries().filter(tool => tool.serverName === SHORT_SERVER)).toHaveLength(MANY_TOOL_COUNT);
		expect(summaries().filter(tool => tool.serverName === COLON_SERVER)).toHaveLength(MANY_TOOL_COUNT);
		expect(summaries().filter(tool => tool.name === FIRST_TOOL)).toHaveLength(2);

		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(tool => tool.serverName));
		});

		await manager.refreshServerTools(SHORT_SERVER);

		expect(summaries()).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(payloads.length).toBeGreaterThan(0);
		for (const payload of payloads) {
			expect(payload.filter(server => server === COLON_SERVER)).toHaveLength(MANY_TOOL_COUNT);
		}
	}, 20_000);

	it("disconnecting one server removes exactly its summaries", async () => {
		await manager.connectServers({ [SHORT_SERVER]: fixtureConfig(), [COLON_SERVER]: fixtureConfig() }, {});
		await Promise.all([manager.waitForConnection(SHORT_SERVER), manager.waitForConnection(COLON_SERVER)]);
		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(tool => tool.serverName));
		});

		await manager.disconnectServer(COLON_SERVER);

		const remaining = manager.getTools();
		expect(remaining).toHaveLength(MANY_TOOL_COUNT);
		expect(remaining.every(tool => tool.serverName === SHORT_SERVER)).toBe(true);
		expect(payloads.at(-1)?.some(server => server === COLON_SERVER)).toBe(false);
	}, 20_000);
});

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function session(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact.log") }),
		settings: Settings.isolated(),
		enableLsp: false,
	};
}

let tmpDir = "";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(async () => {
	if (tmpDir) await removeWithRetries(tmpDir);
	tmpDir = "";
});

describe("WriteTool successful changes", () => {
	it("projects canonical create and update operations over final whole-file ranges", async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-successful-change-"));
		const tool = new WriteTool(session(tmpDir));
		const relativePath = "src/file.ts";
		const absolutePath = path.join(tmpDir, relativePath);
		const firstContent = "export const first = 1;\nexport const second = 2;";
		const createResult = await tool.execute("create", { path: relativePath, content: firstContent });
		expect(tool.successfulChanges({ path: relativePath, content: firstContent }, createResult)).toEqual([
			{ path: absolutePath, operation: "create", ranges: [{ startLine: 1, endLine: 2 }] },
		]);

		const updateContent = "export const only = 1;";
		const updateResult = await tool.execute("update", { path: relativePath, content: updateContent });
		expect(tool.successfulChanges({ path: relativePath, content: updateContent }, updateResult)).toEqual([
			{ path: absolutePath, operation: "update", ranges: [{ startLine: 1, endLine: 1 }] },
		]);
	});

	it("omits failed and non-filesystem results", () => {
		const tool = Object.create(WriteTool.prototype) as WriteTool;
		expect(tool.successfulChanges({}, { content: [], isError: true })).toEqual([]);
		expect(tool.successfulChanges({}, { content: [], details: { xdev: {} as never } })).toEqual([]);
	});
});

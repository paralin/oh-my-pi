import { describe, expect, it } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { EditTool, type EditToolDetails } from "@oh-my-pi/pi-coding-agent/edit";

function project(details: EditToolDetails, isError = false) {
	return EditTool.prototype.successfulChanges.call({} as EditTool, {}, {
		content: [],
		details,
		...(isError ? { isError: true } : {}),
	} as AgentToolResult<EditToolDetails>);
}

describe("EditTool successful changes", () => {
	it("projects create, update, move, and delete results with canonical ranges", () => {
		expect(
			project({ path: "/tmp/create.ts", op: "create", diff: "", newText: "const a = 1;\nconst b = 2;" }),
		).toEqual([{ path: "/tmp/create.ts", operation: "create", ranges: [{ startLine: 1, endLine: 2 }] }]);
		expect(
			project({
				path: "/tmp/update.ts",
				diff: "@@ -1,3 +1,4 @@\n keep\n-old\n+new\n+added\n tail",
				newText: "keep\nnew\nadded\ntail",
				firstChangedLine: 2,
			}),
		).toEqual([{ path: "/tmp/update.ts", operation: "update", ranges: [{ startLine: 2, endLine: 3 }] }]);
		expect(
			project({
				path: "/tmp/destination.ts",
				sourcePath: "/tmp/source.ts",
				op: "update",
				move: "/tmp/destination.ts",
				diff: "",
				resultingLineCount: 42,
				snapshotsPruned: true,
			}),
		).toEqual([
			{
				path: "/tmp/destination.ts",
				operation: "move",
				ranges: [{ startLine: 1, endLine: 42 }],
				sourcePath: "/tmp/source.ts",
			},
		]);
		expect(project({ path: "/tmp/delete.ts", op: "delete", diff: "", oldText: "gone" })).toEqual([
			{ path: "/tmp/delete.ts", operation: "delete", ranges: [{ startLine: 1, endLine: 1 }] },
		]);
	});

	it("keeps successful entries from partial multi-file and pruned results", () => {
		const changes = project(
			{
				diff: "",
				firstChangedLine: 1,
				perFileResults: [
					{
						path: "/tmp/first.ts",
						op: "update",
						diff: "@@ -1 +1 @@\n-old\n+new",
						snapshotsPruned: true,
					},
					{ path: "/tmp/failed.ts", diff: "", isError: true, errorText: "stale" },
				],
			},
			true,
		);
		expect(changes).toEqual([{ path: "/tmp/first.ts", operation: "update", ranges: [{ startLine: 1, endLine: 1 }] }]);
	});

	it("recomputes same-file ranges against the final source", () => {
		const changes = project({
			diff: "",
			oldText: "one\nold\nthree\nfour\nold",
			newText: "one\nfirst\nthree\nfour\nsecond",
			perFileResults: [
				{ path: "/tmp/file.ts", op: "update", diff: "@@ -2 +2 @@\n-old\n+first" },
				{ path: "/tmp/file.ts", op: "update", diff: "@@ -5 +5 @@\n-old\n+second" },
			],
		});
		expect(changes).toEqual([
			{
				path: "/tmp/file.ts",
				operation: "update",
				ranges: [
					{ startLine: 2, endLine: 2 },
					{ startLine: 5, endLine: 5 },
				],
			},
		]);
	});
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	allocateIpythonHostArtifact,
	finalizeIpythonHostArtifacts,
	spillIpythonCellArtifacts,
} from "../../src/ipython/artifacts.js";
import type { IpythonCellResult } from "../../src/ipython/cell.js";
import { createIpythonCellText } from "../../src/ipython/projection.js";

function result(): IpythonCellResult {
	return {
		cellId: "cell/unsafe",
		executionId: "execution",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		code: "display(payload)",
		status: "ok",
		requestedAt: 1,
		startedAt: 2,
		finishedAt: 3,
		durationMs: 1,
		stdout: "full output",
		stderr: "",
		result: undefined,
		events: [
			{
				kind: "display",
				data: {
					"text/html": "<script>unsafe()</script>",
					"image/png": Buffer.from("png-bytes").toString("base64"),
					"application/json": { ok: true },
				},
				metadata: {},
				transient: {},
				update: false,
				text: "[displayed MIME types: application/json, image/png, text/html]",
			},
		],
		errors: [],
		updates: [],
		artifacts: [],
		modelText: {
			text: "[displayed MIME types: application/json, image/png, text/html]\n[IPython output truncated]",
			truncated: true,
			totalBytes: 10_000,
			outputBytes: 100,
		},
	};
}

describe("IPython host artifact allocation", () => {
	test("reserves a path beneath the active cell and honors cancellation and suffix validation", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-allocation-"));
		try {
			const active = new AbortController();
			const artifact = await allocateIpythonHostArtifact(
				root,
				"cell/unsafe",
				{ label: "report", mimeType: "application/json", suffix: ".json" },
				active.signal,
			);
			expect(artifact).toMatchObject({ label: "report", mimeType: "application/json", bytes: 0 });
			expect(artifact.path.startsWith(path.join(root, "ipython", "artifacts", "cell_unsafe", "allocated"))).toBe(
				true,
			);
			expect(await fs.readFile(artifact.path)).toHaveLength(0);
			await fs.writeFile(artifact.path, "answer");
			expect(await finalizeIpythonHostArtifacts([artifact], root)).toEqual([{ ...artifact, bytes: 6 }]);
			await expect(
				finalizeIpythonHostArtifacts([{ ...artifact, path: path.join(root, "..", "escape") }], root),
			).rejects.toThrow("escaped the session sidecar");
			await expect(
				allocateIpythonHostArtifact(
					root,
					"cell",
					{ label: "bad", mimeType: "text/plain", suffix: "../escape" },
					active.signal,
				),
			).rejects.toThrow("artifact suffix");
			const aborted = new AbortController();
			aborted.abort(new Error("cell stopped"));
			await expect(
				allocateIpythonHostArtifact(
					root,
					"cell",
					{ label: "late", mimeType: "text/plain", suffix: ".txt" },
					aborted.signal,
				),
			).rejects.toThrow("cell stopped");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("IPython artifact spill", () => {
	test("atomically spills full truncated results and rich MIME payloads under the sidecar", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-artifacts-"));
		try {
			const artifacts = await spillIpythonCellArtifacts(result(), root);
			expect(artifacts).toHaveLength(4);
			expect(artifacts.every(artifact => artifact.path.startsWith(path.join(root, "ipython", "artifacts")))).toBe(
				true,
			);
			expect(artifacts.every(artifact => !artifact.path.includes("cell/unsafe"))).toBe(true);
			const full = artifacts.find(artifact => artifact.label === "Full IPython result");
			const html = artifacts.find(artifact => artifact.mimeType === "text/html");
			const png = artifacts.find(artifact => artifact.mimeType === "image/png");
			const json = artifacts.find(artifact => artifact.mimeType === "application/json" && artifact !== full);
			if (!full || !html || !png || !json) throw new Error("artifact spill omitted a required payload");
			expect(full.path).toBe(path.join(root, "ipython", "artifacts", "cell_unsafe", "full-result.json"));
			expect(JSON.parse(await fs.readFile(full.path, "utf8")).stdout).toBe("full output");
			expect(await fs.readFile(html.path, "utf8")).toBe("<script>unsafe()</script>");
			expect(await fs.readFile(png.path, "utf8")).toBe("png-bytes");
			expect(JSON.parse(await fs.readFile(json.path, "utf8"))).toEqual({ ok: true });
			const remaining = (await fs.readdir(path.dirname(full.path))).filter(name => name.endsWith(".tmp"));
			expect(remaining).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("puts the deterministic full-result path in the bounded projection", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-full-result-"));
		try {
			const command = "$ gh run watch 481516 --exit-status\n";
			const failing = "AssertionError: final failing assertion\ngh run watch exited with status 1\n";
			const error = {
				kind: "error" as const,
				ename: "AssertionError",
				evalue: "final failing assertion",
				traceback: [failing],
			};
			const events = [
				{ kind: "stream" as const, name: "stdout" as const, text: `${command}${"x".repeat(200 * 1024)}` },
				error,
			] satisfies IpythonCellResult["events"];
			const modelText = createIpythonCellText(events, [], "error");
			const artifacts = await spillIpythonCellArtifacts(
				{
					...result(),
					status: "error",
					events,
					errors: [error],
					modelText,
				},
				root,
			);
			const full = artifacts.find(artifact => artifact.label === "Full IPython result");
			if (!full) throw new Error("full result artifact was not written");
			const withPath = createIpythonCellText(events, [], "error", modelText.outputBytes, full.path);

			expect(withPath.outputBytes).toBeLessThanOrEqual(modelText.outputBytes);
			expect(withPath.text.split("\n", 1)[0]).toContain(`Full IPython output: ${full.path}`);
			expect(withPath.text.split("\n", 1)[0]).toMatch(/4 lines, 204911 bytes total; 0 lines, \d+ bytes omitted/);
			expect(JSON.parse(await fs.readFile(full.path, "utf8")).events).toEqual(events);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

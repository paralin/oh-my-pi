import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { analyzeSuccessfulChanges } from "@oh-my-pi/pi-coding-agent/capability/successful-change-analyzer";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { findReferences, locationContainsPosition } from "@oh-my-pi/pi-coding-agent/lsp/references";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const roots: string[] = [];

async function workspace(prefix: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return root;
}

function callSiteCount(result: Awaited<ReturnType<typeof findReferences>>): number {
	if (result.status !== "ok") throw new Error(result.reason);
	return result.locations.filter(location => !locationContainsPosition(location, result.uri, result.position)).length;
}

afterEach(async () => {
	await shutdownAll();
	await Promise.all(roots.splice(0).map(root => removeWithRetries(root)));
});

function referenceRule(name: string, extension: string, regex: string, max: number) {
	const rulePath = `/tmp/${name}.md`;
	return buildRuleFromMarkdown(
		name,
		`---
scope: ["tool:edit(*.${extension})"]
semanticCondition:
  candidate:
    regex: '${regex}'
  references:
    capture: NAME
    max: ${max}
---
Keep the helper direct.`,
		rulePath,
		createSourceMeta("test", rulePath, "project"),
		{ ruleName: name },
	);
}

describe("LSP reference service", () => {
	it("returns Go locations and preserves the rendered LSP tool behavior", async () => {
		const root = await workspace("omp-go-references-");
		const file = path.join(root, "helper.go");
		await Bun.write(path.join(root, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
		await Bun.write(file, "package fixture\n\nfunc local() int { return 1 }\nfunc use() int { return local() }\n");
		const result = await findReferences({ cwd: root, filePath: file, position: { line: 2, character: 5 } });
		expect(result.status).toBe("ok");
		expect(callSiteCount(result)).toBe(1);

		const session = { cwd: root, settings: Settings.isolated(), enableLsp: true } as ToolSession;
		const rendered = await new LspTool(session).execute("refs", {
			action: "references",
			file,
			line: 3,
			symbol: "local",
		});
		expect(rendered.content[0]?.type === "text" && rendered.content[0].text).toContain("Found 2 reference(s)");
	}, 30_000);

	it("returns TypeScript references by exact source position", async () => {
		const root = await workspace("omp-ts-references-");
		await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
		await fs.symlink(
			path.join(import.meta.dir, "../../../../node_modules/@bufbuild/protoplugin/node_modules/typescript"),
			path.join(root, "node_modules/typescript"),
			"dir",
		);
		await Bun.write(path.join(root, "package.json"), '{"private":true,"devDependencies":{"typescript":"*"}}\n');
		await Bun.write(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n');
		const file = path.join(root, "helper.ts");
		await Bun.write(
			file,
			"function local(): number { return 1; }\nconst first = local();\nconst second = local();\n",
		);
		const result = await findReferences({ cwd: root, filePath: file, position: { line: 0, character: 9 } });
		expect(result.status).toBe("ok");
		expect(callSiteCount(result)).toBe(2);
	}, 30_000);

	it("applies Go reference bounds to same-spelled methods by exact position", async () => {
		const root = await workspace("omp-go-reference-bounds-");
		const file = path.join(root, "helper.go");
		await Bun.write(path.join(root, "go.mod"), "module example.com/fixture\n\ngo 1.22\n");
		await Bun.write(
			file,
			[
				"package fixture",
				"type one struct{}",
				"func (one) helper() int { return 1 }",
				"func useOne() int { return one{}.helper() }",
				"type two struct{}",
				"func (two) helper() int { return 2 }",
				"func useTwo() int { return two{}.helper() + two{}.helper() }",
				"",
			].join("\n"),
		);
		const manager = new TtsrManager();
		manager.addRule(
			referenceRule(
				"go-reference-boundary",
				"go",
				"func\\s+\\([^)]*\\)\\s+(?<NAME>helper)\\(\\)\\s+int\\s*\\{[^}]*\\}",
				1,
			),
		);
		const analysis = await analyzeSuccessfulChanges(
			manager,
			[{ path: file, operation: "update", ranges: [{ startLine: 3, endLine: 6 }] }],
			{ toolName: "edit", cwd: root },
		);
		expect(analysis.matches).toHaveLength(1);
		expect(analysis.reports[0]?.report.candidates).toMatchObject([
			{ status: "matched", referenceEvidence: { capture: "NAME", count: 1, serverName: "gopls" } },
			{ status: "rejected", referenceEvidence: { capture: "NAME", count: 2, serverName: "gopls" } },
		]);
	}, 30_000);

	it("applies TypeScript reference bounds to same-spelled methods by exact position", async () => {
		const root = await workspace("omp-ts-reference-bounds-");
		await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
		await fs.symlink(
			path.join(import.meta.dir, "../../../../node_modules/@bufbuild/protoplugin/node_modules/typescript"),
			path.join(root, "node_modules/typescript"),
			"dir",
		);
		await Bun.write(path.join(root, "package.json"), '{"private":true,"devDependencies":{"typescript":"*"}}\n');
		await Bun.write(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true},"include":["*.ts"]}\n');
		const file = path.join(root, "helper.ts");
		await Bun.write(
			file,
			[
				"class One { helper(): number { return 1; } }",
				"const one = new One(); one.helper();",
				"class Two { helper(): number { return 2; } }",
				"const two = new Two(); two.helper(); two.helper();",
				"class Three { helper(): number { return 3; } }",
				"const three = new Three(); three.helper(); three.helper(); three.helper();",
				"",
			].join("\n"),
		);
		const manager = new TtsrManager();
		manager.addRule(
			referenceRule(
				"ts-reference-boundary",
				"ts",
				"(?<NAME>helper)\\(\\):\\s*number\\s*\\{\\s*return\\s+\\d;\\s*\\}",
				2,
			),
		);
		const analysis = await analyzeSuccessfulChanges(
			manager,
			[{ path: file, operation: "update", ranges: [{ startLine: 1, endLine: 5 }] }],
			{ toolName: "edit", cwd: root },
		);
		expect(analysis.matches).toHaveLength(1);
		expect(analysis.reports[0]?.report.candidates).toMatchObject([
			{
				status: "matched",
				referenceEvidence: { capture: "NAME", count: 1, serverName: "typescript-language-server" },
			},
			{
				status: "matched",
				referenceEvidence: { capture: "NAME", count: 2, serverName: "typescript-language-server" },
			},
			{
				status: "rejected",
				referenceEvidence: { capture: "NAME", count: 3, serverName: "typescript-language-server" },
			},
		]);
	}, 30_000);
});

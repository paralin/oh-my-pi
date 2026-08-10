import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../src/session/tool-session.js";
import type { ReadResult } from "../src/tools/read.js";
import { ReadService } from "../src/tools/read.js";

let artifactCounter = 0;

function textOutput(result: ReadResult): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

/**
 * Defaults that pin tests to the legacy outermost-only collector so small
 * fixtures keep emitting deterministic elisions:
 *   - `minTotalLines: 0` skips the size gate.
 *   - `unfoldUntil: 0` short-circuits BFS unfolding.
 * Tests that need BFS or the size gate override these explicitly.
 */
const LEGACY_SUMMARY_OVERRIDES: Record<string, unknown> = {
	"read.summarize.minTotalLines": 0,
	"read.summarize.unfoldUntil": 0,
	"read.summarize.unfoldLimit": 0,
};

function createSession(cwd: string, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = Settings.isolated({ ...LEGACY_SUMMARY_OVERRIDES, ...overrides });
	const sessionFile = path.join(cwd, "session.jsonl");
	const sessionDir = path.join(cwd, "session");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => sessionDir,
		allocateOutputArtifact: async (toolType: string) => {
			await fs.mkdir(sessionDir, { recursive: true });
			const id = `artifact-${++artifactCounter}`;
			return { id, path: path.join(sessionDir, `${id}.${toolType}.log`) };
		},
		settings,
	};
}

describe("read summary", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-summary-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("summarizes parseable TypeScript files without an explicit selector", async () => {
		const fixture = path.join(tmpDir, "src", "fixture.ts");
		await fs.mkdir(path.dirname(fixture), { recursive: true });
		await fs.writeFile(
			fixture,
			"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n",
		);

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);
		expect(text).toContain("export function alpha(value: string): string { … }");
		expect(text).toContain("export function beta(): number { … }");
		expect(text).not.toContain("const clean = value.trim()");
		expect(result.details?.summary?.elidedSpans).toBe(2);
	});

	it("summarizes Markdown only when prose summaries are enabled", async () => {
		const fixture = path.join(tmpDir, "fixture.md");
		await fs.writeFile(
			fixture,
			"# Heading\n\nIntro line.\n\n```ts\nexport function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n```\n\nMore prose.\n",
		);

		const defaultTool = new ReadService(createSession(tmpDir));
		const defaultResult = await defaultTool.read(fixture);
		expect(textOutput(defaultResult)).toContain("const clean = 'alpha';");
		expect(defaultResult.details?.summary).toBeUndefined();

		const proseTool = new ReadService(createSession(tmpDir, { "read.summarize.prose": true }));
		const proseResult = await proseTool.read(fixture);
		expect(textOutput(proseResult)).not.toContain("const clean = 'alpha';");
		expect(proseResult.details?.summary?.elidedSpans).toBe(1);
	});

	it("keeps non-.md markdown flavors verbatim when prose summaries are disabled", async () => {
		const fixture = path.join(tmpDir, "fixture.mdx");
		await fs.writeFile(
			fixture,
			"# Heading\n\nIntro line.\n\n```ts\nexport function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n```\n\nMore prose.\n",
		);

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		expect(textOutput(result)).toContain("const clean = 'alpha';");
		expect(result.details?.summary).toBeUndefined();
	});

	it("does not truncate summarized output", async () => {
		const fixture = path.join(tmpDir, "many.ts");
		const source = Array.from(
			{ length: 20 },
			(_, index) =>
				`export function fn${index}(): number {\n\tconst one = ${index};\n\tconst two = ${index + 1};\n\treturn one + two;\n}`,
		).join("\n\n");
		await fs.writeFile(fixture, `${source}\n`);

		const tool = new ReadService(createSession(tmpDir, { "read.defaultLimit": 10 }));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(text).toContain("export function fn19(): number {");
		expect(text).not.toContain("[Showing lines");
		expect(result.details?.truncation).toBeUndefined();
		expect(result.details?.summary?.elidedSpans).toBe(20);
	});

	it("returns verbatim anchored ranges when a selector is explicit", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(`${fixture}:1-9999`);
		const text = textOutput(result);

		expect(text).toContain("const clean = 'alpha';");
		expect(text).not.toContain("…");
		expect(result.details?.summary).toBeUndefined();
	});

	it("returns raw verbatim content without anchors", async () => {
		const fixture = path.join(tmpDir, "fixture.ts");
		await fs.writeFile(fixture, "export const value = 1;\n");

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(`${fixture}:raw`);
		const text = textOutput(result);

		expect(text).toBe("export const value = 1;\n");
		expect(text).not.toMatch(/^1[a-z]{2}\|/);
	});

	it("returns raw verbatim content for compound `:lines:raw` selector", async () => {
		const fixture = path.join(tmpDir, "compound.ts");
		await fs.writeFile(fixture, "alpha\nbeta\ngamma\ndelta\nepsilon\n");

		const tool = new ReadService(createSession(tmpDir));
		const linesFirst = await tool.read(`${fixture}:2-4:raw`);
		const linesFirstText = textOutput(linesFirst);
		// Verbatim: no line-number prefix.
		expect(linesFirstText).toContain("beta");
		expect(linesFirstText).toContain("gamma");
		expect(linesFirstText).toContain("delta");
		expect(linesFirstText).not.toMatch(/^\s*\d+[a-z]{2}\|/m);
		expect(linesFirstText).not.toMatch(/^\s*\d+\|/m);
		// Note: explicit ranges expand with surrounding context lines, so we don't
		// assert on what is excluded — only that the requested range is present
		// verbatim with no anchor or line-number prefixes.

		const rawFirst = await tool.read(`${fixture}:raw:2-4`);
		const rawFirstText = textOutput(rawFirst);
		expect(rawFirstText).toBe(linesFirstText);
	});

	it("falls back to normal reads when summaries are disabled or parsing fails", async () => {
		const valid = path.join(tmpDir, "valid.ts");
		const broken = path.join(tmpDir, "broken.ts");
		await fs.writeFile(valid, "export function alpha(): string {\n\tconst clean = 'alpha';\n\treturn clean;\n}\n");
		await fs.writeFile(broken, "export function broken( {\n");

		const disabledTool = new ReadService(createSession(tmpDir, { "read.summarize.enabled": false }));
		const disabled = await disabledTool.read(valid);
		expect(textOutput(disabled)).toContain("const clean = 'alpha';");
		expect(disabled.details?.summary).toBeUndefined();

		const enabledTool = new ReadService(createSession(tmpDir));
		const parseFailure = await enabledTool.read(broken);
		expect(textOutput(parseFailure)).toContain("export function broken( {");
		expect(parseFailure.details?.summary).toBeUndefined();
	});

	it("preserves SQLite colon paths while plain-file selectors split only line suffixes", async () => {
		const dbPath = path.join(tmpDir, "data.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
			db.run("INSERT INTO users (id, name) VALUES (42, 'Ada')");
		} finally {
			db.close();
		}

		const tool = new ReadService(createSession(tmpDir));
		const row = await tool.read(`${dbPath}:users:42`);
		const text = textOutput(row);

		expect(text).toContain("id: 42");
		expect(text).toContain("name: Ada");
	});

	it("renders brace-pair elisions as a single line with `…`", async () => {
		// Collapse the head / elided / closing-brace sandwich into one line.
		const fixture = path.join(tmpDir, "merge.ts");
		await fs.writeFile(
			fixture,
			"export function stripNewLinePrefixes(lines: string[]): string[] {\n\tconst out: string[] = [];\n\tfor (const line of lines) {\n\t\tout.push(line.replace(/^\\n+/, ''));\n\t}\n\treturn out;\n}\n",
		);

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(text).toContain("export function stripNewLinePrefixes(lines: string[]): string[] { … }");
		// The plain `…` ellipsis line must NOT appear once the merge fires.
		expect(text).not.toContain("\n…\n");
		expect(text).toMatch(/^export function stripNewLinePrefixes/m);
		expect(result.details?.summary?.elidedSpans).toBe(1);
	});

	it("merges trailing-punctuation closers like `};` and `})`", async () => {
		// `const x = { ... };` — closer is `};` not just `}`. The merge must
		// still fire and preserve the trailing `;` on the merged line.
		const fixture = path.join(tmpDir, "object.ts");
		await fs.writeFile(fixture, "export const config = {\n\talpha: 1,\n\tbeta: 2,\n\tgamma: 3,\n\tdelta: 4,\n};\n");

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(text).toContain("export const config = { … };");
		expect(text).not.toContain("\n…\n");
	});

	it("does not merge when the closing line is not a bare brace", async () => {
		// Python def: head ends with `:`, tail ends with `return …` — no brace
		// pair. The summarizer must keep the original head / `...` / tail
		// rendering instead of merging.
		const fixture = path.join(tmpDir, "fixture.py");
		await fs.writeFile(
			fixture,
			"def greet(name: str) -> str:\n    clean = name.strip()\n    label = clean or 'world'\n    upper = label.upper()\n    return f'hello {upper}'\n",
		);

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(text).toContain("def greet(name: str) -> str:");
		// Python's body elision keeps first/last body lines, so plain `…`
		// must remain as the elided segment.
		expect(text).toContain("\n…\n");
		expect(text).not.toContain(" … ");
	});

	it("appends an elision footer that names targeted recovery ranges", async () => {
		// Regression for issue #1046: summarized reads must tell the model how
		// to recover the elided body so it does not stall on `…` / `{ … }`
		// markers and burn a turn guessing the selector.
		const fixture = path.join(tmpDir, "footer.ts");
		await fs.writeFile(
			fixture,
			"export function alpha(value: string): string {\n\tconst clean = value.trim();\n\tconst label = clean || 'alpha';\n\treturn label.toUpperCase();\n}\n\nexport function beta(): number {\n\tconst one = 1;\n\tconst two = 2;\n\treturn one + two;\n}\n",
		);

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(result.details?.summary?.elidedSpans).toBe(2);
		expect(result.details?.summary?.elidedLines).toBeGreaterThan(0);
		expect(text).toContain("ln elided");
		expect(text).toContain(`${fixture}:1-5,7-11`);
		expect(text).not.toContain(`${fixture}:raw`);
		expect(text).not.toContain(`${fixture}:1-9999`);
		// Footer must be the LAST block of output so the recovery hint sits
		// next to the structural summary it describes.
		expect(text.trimEnd().endsWith("]")).toBe(true);
	});

	it("does not append a footer when the file has no elision", async () => {
		const fixture = path.join(tmpDir, "noelide.ts");
		await fs.writeFile(fixture, "export const x = 1;\n");

		const tool = new ReadService(createSession(tmpDir));
		const result = await tool.read(fixture);
		const text = textOutput(result);

		expect(text).not.toContain("elided regions");
		expect(text).not.toContain(":raw");
		expect(result.details?.summary).toBeUndefined();
	});
});

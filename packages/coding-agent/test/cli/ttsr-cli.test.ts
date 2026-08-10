import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runTtsrCommand,
	TTSR_ACTIONS,
	TTSR_SOURCES,
	type TtsrCommandArgs,
} from "@oh-my-pi/pi-coding-agent/cli/ttsr-cli";

let output = "";
let tempDir = "";
const stdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ttsr-cli-"));
	output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		output += Bun.stripANSI(chunk.toString());
		return true;
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.exitCode = 0;
	process.stdout.write = stdoutWrite;
	fs.rmSync(tempDir, { recursive: true, force: true });
});

async function writeRule(condition: string, scope: string[]): Promise<string> {
	const rulePath = path.join(tempDir, "test-rule.md");
	await Bun.write(
		rulePath,
		`---\ndescription: test rule\ncondition: "${condition.replace(/"/g, '\\"')}"\nscope: [${scope.map(item => `"${item}"`).join(", ")}]\n---\nbody\n`,
	);
	return rulePath;
}

async function run(command: TtsrCommandArgs): Promise<void> {
	await runTtsrCommand(command);
}

describe("omp ttsr", () => {
	it("exposes only list and test actions", () => {
		expect(TTSR_ACTIONS).toEqual(["test", "list"]);
		expect(TTSR_SOURCES).toEqual(["text", "thinking", "tool"]);
	});

	it("matches a regex isolated rule on an IPython code stream", async () => {
		const rule = await writeRule(": any", ["tool:ipython"]);
		await run({ action: "test", test: { rule, snippet: "const x: any = 1", source: "tool", tool: "ipython" } });
		expect(output).toContain("source=tool:ipython");
		expect(output).toContain("Triggered");
		expect(output).toContain("test-rule");
	});

	it("keeps an IPython rule out of prose", async () => {
		const rule = await writeRule(": any", ["tool:ipython"]);
		await run({ action: "test", test: { rule, snippet: "const x: any = 1", source: "text", verbose: true } });
		expect(output).toContain("No rules triggered");
		expect(output).toContain("out-of-scope");
	});

	it("returns regex-only JSON detail", async () => {
		const rule = await writeRule("forbidden", ["text"]);
		await run({ action: "test", json: true, test: { rule, snippet: "forbidden", source: "text" } });
		const report = JSON.parse(output);
		expect(report.triggered[0]).toMatchObject({ name: "test-rule", matched: ["forbidden"], defined: ["forbidden"] });
		expect(report.triggered[0]).not.toHaveProperty("semantic");
	});

	it("rejects a non-IPython tool stream", async () => {
		const rule = await writeRule("forbidden", ["tool:ipython"]);
		await expect(
			run({ action: "test", test: { rule, snippet: "forbidden", source: "tool", tool: "edit" } }),
		).rejects.toThrow("Only --tool ipython");
	});
});

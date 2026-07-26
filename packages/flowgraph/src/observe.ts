/**
 * Observation: what the engine looks at on the model's behalf.
 *
 * Under the single-answer design the model has no read tools. A node declares
 * which observations its question needs and the engine gathers them, so what
 * the model sees at each step is authored rather than discovered. That is the
 * same inversion the edges apply to control, applied to input.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type GoArtifact, renderArtifact, renderTests, testFileName, unimplementedFuncs } from "./artifact";
import type { ContextKind } from "./graph";

/** Maximum bytes one observation contributes, so a large package cannot swamp a question. */
const MAX_OBSERVATION_BYTES = 24 * 1024;

function clamp(text: string): string {
	if (text.length <= MAX_OBSERVATION_BYTES) return text;
	return `${text.slice(0, MAX_OBSERVATION_BYTES)}\n... [truncated at ${MAX_OBSERVATION_BYTES} bytes]`;
}

async function runCommand(argv: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
	const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { ok: exitCode === 0, output: clamp([stdout, stderr].filter(Boolean).join("\n").trim()) };
}

/**
 * Run a deterministic gate command. The engine calls this directly, so no
 * answer can assert that its own gate passed.
 */
export async function runGate(
	command: string[],
	cwd: string,
	emptyOutput: boolean,
): Promise<{ ok: boolean; output: string }> {
	const { ok, output } = await runCommand(command, cwd);
	return { ok: ok && (!emptyOutput || output === ""), output: output || "(no output)" };
}

/** Read every Go source in the workspace except the files the walk is writing. */
async function readSources(root: string, exclude: readonly string[]): Promise<string> {
	const entries = await fs.readdir(root);
	const sources: string[] = [];
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".go") || exclude.includes(entry)) continue;
		sources.push(`--- ${entry}\n${await Bun.file(path.join(root, entry)).text()}`);
	}
	return sources.join("\n") || "(no other Go sources)";
}

/**
 * Gather one node's declared observations into a single block for its question.
 *
 * Returns an empty string when the node declared none, so an orientation-free
 * node costs nothing.
 */
export async function observe(kinds: readonly ContextKind[], root: string, artifact: GoArtifact): Promise<string> {
	const blocks: string[] = [];
	for (const kind of kinds) {
		switch (kind) {
			case "package_doc": {
				const { output } = await runCommand(["go", "doc", "-all", "."], root);
				blocks.push(`# Package documentation\n${output || "(none)"}`);
				break;
			}
			case "sources":
				blocks.push(`# Existing sources\n${await readSources(root, [artifact.file, testFileName(artifact)])}`);
				break;
			case "artifact":
				blocks.push(
					artifact.structs.length === 0 && artifact.funcs.length === 0
						? "# Artifact\n(nothing built yet)"
						: `# Artifact ${artifact.file}\n${renderArtifact(artifact)}`,
				);
				// The test set is replaced whole, so a node that rewrites it has to
				// see what it is replacing.
				if (artifact.tests.length > 0) {
					blocks.push(`# Artifact ${testFileName(artifact)}\n${renderTests(artifact)}`);
				}
				break;
			case "build": {
				const { ok, output } = await runCommand(["go", "build", "./..."], root);
				blocks.push(`# go build\n${ok ? "ok" : output}`);
				break;
			}
			case "vet": {
				const { ok, output } = await runCommand(["go", "vet", "./..."], root);
				blocks.push(`# go vet\n${ok ? "clean" : output}`);
				break;
			}
			case "tests": {
				const { ok, output } = await runCommand(["go", "test", "./..."], root);
				blocks.push(`# go test\n${ok ? "pass" : output}`);
				break;
			}
			case "todo": {
				const pending = unimplementedFuncs(artifact);
				blocks.push(`# Unimplemented\n${pending.length === 0 ? "(none left)" : pending.join("\n")}`);
				break;
			}
		}
	}
	return blocks.join("\n\n");
}

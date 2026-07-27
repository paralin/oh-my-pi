/**
 * The ordinary tools a tool-driven walk keeps.
 *
 * The single-answer walk gives the model no way to touch the workspace, so the
 * engine renders every line it ships. A tool-driven walk inverts that half back:
 * the session reads, edits, and runs commands the way an unguided one does, and
 * the graph supplies the checklist rather than the hands. What the graph still
 * owns is where the walk may go next, which is the part worth keeping.
 *
 * These are deliberately the smallest set that can build a Go package: enough to
 * make the mode comparable to a freeform lane, few enough that the tool schemas
 * stay a small constant part of the cached prefix.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";

/** Bytes one tool result may contribute, so a large file cannot swamp the session. */
const MAX_RESULT_BYTES = 32 * 1024;
/** Wall-clock ceiling on one command, so a hung test cannot hold the walk. */
const COMMAND_TIMEOUT_MS = 120_000;

function clamp(text: string): string {
	if (text.length <= MAX_RESULT_BYTES) return text;
	return `${text.slice(0, MAX_RESULT_BYTES)}\n... [truncated at ${MAX_RESULT_BYTES} bytes]`;
}

function ok(text: string) {
	return { content: [{ type: "text" as const, text: clamp(text) || "(no output)" }], isError: false };
}

function fail(text: string) {
	return { content: [{ type: "text" as const, text: clamp(text) }], isError: true };
}

/**
 * Resolve a model-supplied path inside the walk's directory.
 *
 * The walk is confined to one directory and the session is not: a relative path
 * with enough parent segments reaches the whole disk. Resolution is therefore
 * the engine's, not the model's.
 */
function resolveInside(dir: string, rel: string): string | undefined {
	const full = path.resolve(dir, rel);
	return full === dir || full.startsWith(`${dir}${path.sep}`) ? full : undefined;
}

/** Read, write, edit, list, and run: the walk's ordinary hands. */
export function createToolbox(dir: string): AgentTool<any>[] {
	const inside = (rel: string) => resolveInside(dir, rel);

	return [
		{
			name: "read",
			label: "Read",
			description: "Read a file in the working directory.",
			parameters: z.object({ path: z.string().describe("Path relative to the working directory.") }),
			execute: async (_id, params: { path: string }) => {
				const full = inside(params.path);
				if (!full) return fail(`path escapes the working directory: ${params.path}`);
				const file = Bun.file(full);
				if (!(await file.exists())) return fail(`no such file: ${params.path}`);
				return ok(await file.text());
			},
		},
		{
			name: "write",
			label: "Write",
			description: "Write a file in the working directory, creating or replacing it whole.",
			parameters: z.object({ path: z.string(), content: z.string() }),
			execute: async (_id, params: { path: string; content: string }) => {
				const full = inside(params.path);
				if (!full) return fail(`path escapes the working directory: ${params.path}`);
				await fs.mkdir(path.dirname(full), { recursive: true });
				await Bun.write(full, params.content);
				return ok(`wrote ${params.path} (${params.content.length} bytes)`);
			},
		},
		{
			name: "edit",
			label: "Edit",
			description: "Replace one exact occurrence of a string in a file.",
			parameters: z.object({
				path: z.string(),
				old: z.string().describe("Exact text to replace. Must occur exactly once."),
				new: z.string(),
			}),
			execute: async (_id, params: { path: string; old: string; new: string }) => {
				const full = inside(params.path);
				if (!full) return fail(`path escapes the working directory: ${params.path}`);
				const file = Bun.file(full);
				if (!(await file.exists())) return fail(`no such file: ${params.path}`);
				const text = await file.text();
				const occurrences = text.split(params.old).length - 1;
				if (occurrences === 0) return fail(`old text not found in ${params.path}`);
				if (occurrences > 1) return fail(`old text occurs ${occurrences} times in ${params.path}; make it unique`);
				await Bun.write(full, text.replace(params.old, params.new));
				return ok(`edited ${params.path}`);
			},
		},
		{
			name: "ls",
			label: "List",
			description: "List the working directory.",
			parameters: z.object({}),
			execute: async () => ok((await fs.readdir(dir)).sort().join("\n")),
		},
		{
			name: "bash",
			label: "Bash",
			description: "Run a shell command in the working directory. Use it to build, vet, and test.",
			parameters: z.object({ command: z.string() }),
			execute: async (_id, params: { command: string }) => {
				const proc = Bun.spawn(["bash", "-lc", params.command], {
					cwd: dir,
					stdout: "pipe",
					stderr: "pipe",
					timeout: COMMAND_TIMEOUT_MS,
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				const output = [stdout, stderr].filter(Boolean).join("\n").trim();
				return ok(`exit ${exitCode}\n${output}`);
			},
		},
	];
}

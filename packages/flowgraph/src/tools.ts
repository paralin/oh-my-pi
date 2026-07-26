/**
 * Workspace tools a node may expose.
 *
 * These are deliberately small and root-confined rather than the coding agent's
 * full surface: a node's whole point is that the model sees only what that step
 * needs, and a tool that can reach outside the walk's target directory would
 * make the narrowing decorative.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";

/** Result detail every file-touching tool returns, so the walk can bind artifacts to nodes. */
export interface FileToolDetails {
	/** Path relative to the workspace root. */
	path: string;
	/** True when the call changed the file, which makes it a walk artifact. */
	mutated: boolean;
}

/** Maximum bytes a single tool returns, so one large file cannot swamp a node's context. */
const MAX_OUTPUT_BYTES = 64 * 1024;

function clamp(text: string): string {
	if (text.length <= MAX_OUTPUT_BYTES) return text;
	return `${text.slice(0, MAX_OUTPUT_BYTES)}\n... [truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

/**
 * Resolve a model-supplied path inside the workspace root.
 *
 * Rejects absolute paths and traversal rather than clamping them: a node that
 * asked for a file outside its workspace has misunderstood its task, and a
 * silently rewritten path would hide that in the trajectory.
 */
function resolveInRoot(root: string, relative: string): string {
	const resolved = path.resolve(root, relative);
	const rel = path.relative(root, resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`path escapes the workspace root: ${relative}`);
	}
	return resolved;
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
 * Run a deterministic gate command. The walk calls this directly rather than
 * through a tool so the model cannot decide that its own gate passed.
 */
export async function runGate(
	command: string[],
	cwd: string,
	emptyOutput: boolean,
): Promise<{ ok: boolean; output: string }> {
	const { ok, output } = await runCommand(command, cwd);
	return { ok: ok && (!emptyOutput || output === ""), output: output || "(no output)" };
}

/**
 * Build the workspace tool table for one walk.
 *
 * Every tool is bound to `root` at construction, so allowlisting is a name
 * lookup in the returned map and no tool carries ambient authority.
 */
export function createWorkspaceTools(root: string): ReadonlyMap<string, AgentTool<any>> {
	const tools: AgentTool<any>[] = [
		{
			name: "list_dir",
			label: "List Directory",
			description: "List the entries of a directory inside the workspace.",
			parameters: z.object({ path: z.string().describe("Directory path relative to the workspace root.") }),
			execute: async (_id, params: { path: string }) => {
				const target = resolveInRoot(root, params.path);
				const entries = await fs.readdir(target, { withFileTypes: true });
				const listing = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
				return { content: [{ type: "text", text: clamp(listing || "(empty)") }] };
			},
		},
		{
			name: "read_file",
			label: "Read File",
			description: "Read a file inside the workspace.",
			parameters: z.object({ path: z.string().describe("File path relative to the workspace root.") }),
			execute: async (_id, params: { path: string }) => {
				const target = resolveInRoot(root, params.path);
				const text = await Bun.file(target).text();
				const details: FileToolDetails = { path: params.path, mutated: false };
				return { content: [{ type: "text", text: clamp(text) }], details };
			},
		},
		{
			name: "write_file",
			label: "Write File",
			description: "Write a file inside the workspace, replacing its entire contents.",
			parameters: z.object({
				path: z.string().describe("File path relative to the workspace root."),
				content: z.string().describe("Complete new file contents."),
			}),
			execute: async (_id, params: { path: string; content: string }) => {
				const target = resolveInRoot(root, params.path);
				await Bun.write(target, params.content);
				const details: FileToolDetails = { path: params.path, mutated: true };
				return {
					content: [{ type: "text", text: `wrote ${params.content.length} bytes to ${params.path}` }],
					details,
				};
			},
		},
		{
			name: "go_doc",
			label: "Go Doc",
			description: "Run `go doc` for a package or symbol and return its documentation.",
			parameters: z.object({ target: z.string().describe("Package path or `package.Symbol`.") }),
			execute: async (_id, params: { target: string }) => {
				const { output } = await runCommand(["go", "doc", "-all", params.target], root);
				return { content: [{ type: "text", text: output }] };
			},
		},
		{
			name: "go_build",
			label: "Go Build",
			description: "Build every package in the workspace and return compiler diagnostics.",
			parameters: z.object({}),
			execute: async () => {
				const { ok, output } = await runCommand(["go", "build", "./..."], root);
				return { content: [{ type: "text", text: ok ? "build ok" : output }], isError: !ok };
			},
		},
		{
			name: "go_vet",
			label: "Go Vet",
			description: "Run `go vet` over the workspace and return its findings.",
			parameters: z.object({}),
			execute: async () => {
				const { ok, output } = await runCommand(["go", "vet", "./..."], root);
				return { content: [{ type: "text", text: ok ? "vet clean" : output }], isError: !ok };
			},
		},
	];
	return new Map(tools.map(tool => [tool.name, tool]));
}

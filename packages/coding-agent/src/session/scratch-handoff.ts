import * as fs from "node:fs/promises";
import * as path from "node:path";

import { resolveToCwd } from "../tools/path-utils";
import type { SessionEntry } from "./session-entries";

export const SCRATCH_HANDOFF_READ_CUSTOM_TYPE = "scratch-handoff-read";

export interface ScratchHandoffSettings {
	enabled: boolean;
	rootDir: string | undefined;
}

export interface ScratchHandoffContext {
	/** Path the agent should use in tool calls. */
	displayPath: string;
	/** Absolute path used by the runtime to create/read the file. */
	absolutePath: string;
	/** Developer instruction block appended to the system prompt. */
	prompt: string;
	/** Current scratch file body loaded into context through a synthetic read result. */
	scratchText: string;
	/** Parent session scratch file, linked from subagent scratch files. */
	parentDisplayPath?: string;
}

export interface ScratchHandoffPathSelection {
	/** Explicit scratch file used for this session, including paths restored from persisted session state. */
	scratchFile?: string;
	/** Parent session scratch file carried across resumed subagent sessions. */
	parentScratchDisplayPath?: string;
}

export function scratchHandoffDate(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}${month}${day}`;
}

export function resolveScratchHandoffPath(input: {
	cwd: string;
	rootDir: string | undefined;
	sessionId: string;
	agentId?: string;
	scratchFile?: string;
	date?: Date;
}): { displayPath: string; absolutePath: string } {
	const explicitPath = input.scratchFile?.trim();
	if (explicitPath) {
		return {
			displayPath: explicitPath.split(path.sep).join("/"),
			absolutePath: resolveToCwd(explicitPath, input.cwd),
		};
	}
	const rootDir = input.rootDir?.trim() || "agent";
	const safeSessionId = input.sessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	const safeAgentId = input.agentId?.trim().replace(/[^a-zA-Z0-9._-]/g, "-") || safeSessionId;
	const fileName = safeAgentId === safeSessionId ? `${safeSessionId}.org` : `${safeAgentId}-${safeSessionId}.org`;
	const displayPath = path.join(rootDir, scratchHandoffDate(input.date), fileName).split(path.sep).join("/");
	const absolutePath = resolveToCwd(displayPath, input.cwd);
	return { displayPath, absolutePath };
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? value : undefined;
}

function scratchHandoffDetails(details: unknown): ScratchHandoffPathSelection | undefined {
	if (!details || typeof details !== "object") return undefined;
	const record = details as Record<string, unknown>;
	const scratchFile = nonEmptyString(record.path);
	const parentScratchDisplayPath = nonEmptyString(record.parentPath);
	if (!scratchFile && !parentScratchDisplayPath) return undefined;
	return { scratchFile, parentScratchDisplayPath };
}

export function latestPersistedScratchHandoffPathSelection(
	entries: readonly SessionEntry[],
): ScratchHandoffPathSelection | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom_message" || entry.customType !== SCRATCH_HANDOFF_READ_CUSTOM_TYPE) continue;
		const selection = scratchHandoffDetails(entry.details);
		if (selection?.scratchFile) return selection;
	}
	return undefined;
}

export function resolveScratchHandoffPathSelection(input: {
	entries: readonly SessionEntry[];
	scratchFile?: string;
	parentScratchDisplayPath?: string;
}): ScratchHandoffPathSelection {
	const persisted = latestPersistedScratchHandoffPathSelection(input.entries);
	return {
		scratchFile: nonEmptyString(input.scratchFile) ?? persisted?.scratchFile,
		parentScratchDisplayPath: nonEmptyString(input.parentScratchDisplayPath) ?? persisted?.parentScratchDisplayPath,
	};
}

export async function buildScratchHandoffContext(input: {
	cwd: string;
	sessionId: string;
	agentId?: string;
	scratchFile?: string;
	settings: ScratchHandoffSettings;
	parentScratchDisplayPath?: string;
	date?: Date;
}): Promise<ScratchHandoffContext | undefined> {
	if (!input.settings.enabled && !input.scratchFile?.trim() && !input.parentScratchDisplayPath?.trim())
		return undefined;
	const { displayPath, absolutePath } = resolveScratchHandoffPath({
		cwd: input.cwd,
		rootDir: input.settings.rootDir,
		sessionId: input.sessionId,
		agentId: input.agentId,
		scratchFile: input.scratchFile,
		date: input.date,
	});
	await ensureScratchHandoffFile({
		absolutePath,
		displayPath,
		sessionId: input.sessionId,
		parentScratchDisplayPath: input.parentScratchDisplayPath,
		date: input.date,
	});
	const scratchText = (await fs.readFile(absolutePath, "utf8").catch(() => "")).trim();
	return {
		displayPath,
		absolutePath,
		parentDisplayPath: input.parentScratchDisplayPath,
		prompt: renderScratchHandoffPrompt(displayPath, input.parentScratchDisplayPath),
		scratchText,
	};
}

async function ensureScratchHandoffFile(input: {
	absolutePath: string;
	displayPath: string;
	sessionId: string;
	parentScratchDisplayPath?: string;
	date?: Date;
}): Promise<void> {
	await fs.mkdir(path.dirname(input.absolutePath), { recursive: true });
	try {
		await fs.stat(input.absolutePath);
		return;
	} catch (error) {
		const code =
			typeof error === "object" && error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		if (code !== "ENOENT") throw error;
	}
	await fs.writeFile(input.absolutePath, initialScratchHandoffDocument(input), "utf8");
}

function initialScratchHandoffDocument(input: {
	displayPath: string;
	sessionId: string;
	parentScratchDisplayPath?: string;
	date?: Date;
}): string {
	const isoDate = (input.date ?? new Date()).toISOString();
	const parentLine = input.parentScratchDisplayPath
		? `- Parent scratch: [[file:${input.parentScratchDisplayPath}][Parent scratch handoff]]\n`
		: "";
	return `#+TITLE: OMP Scratch Handoff ${input.sessionId}\n#+DATE: ${isoDate}\n\n* Scratch Handoff\n:PROPERTIES:\n:session: ${input.sessionId}\n:path: ${input.displayPath}\n:END:\n\n${parentLine}- Current objective: \n- Work completed: \n- Files changed: \n- Verification: \n- Blockers or risks: \n- Next action: \n- Source refs: \n`;
}

function renderScratchHandoffPrompt(displayPath: string, parentScratchDisplayPath: string | undefined): string {
	const lines = [
		"Scratch compaction protocol:",
		`- Existing scratch org file: ${displayPath}. A synthetic read tool result has loaded its current contents into this session; inspect or update the file only when live state diverges.`,
		"- Treat the scratch file as the durable continuity packet for context pressure, resume, and successor sessions.",
	];
	if (parentScratchDisplayPath) {
		lines.push(
			`- Parent scratch org file: ${parentScratchDisplayPath}. Link to it as [[file:${parentScratchDisplayPath}][Parent scratch handoff]] when you need parent context; do not write your subagent state into the parent file.`,
		);
	}
	lines.push(
		"- After orientation, write the first useful scratch delta if the file lacks current task state. Do not wait for the final response to create the first handoff.",
		"- Before any deliberate large read/edit/proof block, before context pressure can force compaction, and before ending with unfinished work, inspect the scratch file and update only stale or missing handoff state.",
		"- Do not rewrite or re-output the whole summary when the file is already current.",
		"- The scratch file must be enough for a successor session: current objective, completed work, changed files, verification already run, blockers, next action, and source refs needed to continue.",
		"- Treat any automatic handoff or context-budget reserve as last-resort space for a concise final delta, not as the place to build the first scratch summary.",
		"- If no update is needed, leave the file unchanged and report one sentence saying it was already current.",
		"- In the final response, mention whether the scratch file was updated or unchanged and name the path.",
	);
	return lines.join("\n");
}

export function renderScratchHandoffSyntheticRead(context: ScratchHandoffContext): string {
	const parentLine = context.parentDisplayPath ? `Parent scratch: ${context.parentDisplayPath}\n` : "";
	return `Synthetic read(path="${context.displayPath}") loaded the scratch handoff file for this session.\n${parentLine}<scratch-handoff-context>\nPath: ${context.displayPath}\n\n${context.scratchText}\n</scratch-handoff-context>`;
}

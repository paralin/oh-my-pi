import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";

import { resolveToCwd } from "../tools/path-utils";

import { createCustomMessage } from "./messages";
import type { SessionEntry } from "./session-entries";

export const SCRATCH_HANDOFF_READ_CUSTOM_TYPE = "scratch-handoff-read";
export const SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE = "scratch-handoff-write";

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
	/** Current scratch file body provided as continuation state. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scratchHandoffDetails(details: unknown): ScratchHandoffPathSelection | undefined {
	if (!isRecord(details)) return undefined;
	const record = details;
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

export type ScratchHandoffMessageConverter = (messages: AgentMessage[]) => Message[];

function sessionEntryMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	if (entry.type !== "custom_message") return undefined;
	if (entry.customType === SCRATCH_HANDOFF_READ_CUSTOM_TYPE) return undefined;
	return createCustomMessage(
		entry.customType,
		entry.content,
		entry.display,
		entry.details,
		entry.timestamp,
		entry.attribution,
	);
}

function modelVisibleUserMessageIndex(
	messages: readonly AgentMessage[],
	convertToLlm: ScratchHandoffMessageConverter,
): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && convertToLlm([message]).some(converted => converted.role === "user")) return index;
	}
	return -1;
}

function latestModelVisibleUserEntryIndex(
	entries: readonly SessionEntry[],
	convertToLlm: ScratchHandoffMessageConverter,
): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const message = sessionEntryMessage(entries[index]);
		if (message && convertToLlm([message]).some(converted => converted.role === "user")) return index;
	}
	return -1;
}

function latestScratchHandoffWriteEntryIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "custom" && entry.customType === SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE) return index;
	}
	return -1;
}

export function buildScratchHandoffRecentContext(input: {
	entries: readonly SessionEntry[];
	pendingMessages?: readonly AgentMessage[];
	convertToLlm: ScratchHandoffMessageConverter;
}): string | undefined {
	const pendingMessages = input.pendingMessages ?? [];
	const pendingUserIndex = modelVisibleUserMessageIndex(pendingMessages, input.convertToLlm);
	const messages =
		pendingUserIndex >= 0
			? pendingMessages.slice(pendingUserIndex)
			: [
					...input.entries
						.slice(
							Math.max(
								latestModelVisibleUserEntryIndex(input.entries, input.convertToLlm),
								latestScratchHandoffWriteEntryIndex(input.entries) + 1,
								0,
							),
						)
						.map(sessionEntryMessage)
						.filter((message): message is AgentMessage => message !== undefined),
					...pendingMessages,
				];
	const llmMessages = input
		.convertToLlm(messages.filter(message => message.role !== "toolResult"))
		.filter(message => message.role !== "toolResult");
	const text = snapcompact.serializeConversation(llmMessages).trim();
	return text.length > 0 ? text : undefined;
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
	return `#+TITLE: OMP Scratch Handoff ${input.sessionId}\n#+DATE: ${isoDate}\n\n* Scratch Handoff\n:PROPERTIES:\n:session: ${input.sessionId}\n:path: ${input.displayPath}\n:END:\n\n${parentLine}** TODO Current work\n- Objective: \n- Skill stack: \n- Work completed: \n- Files changed: \n- Verification: \n- Blockers or risks: \n- Next action: \n- Source refs: \n`;
}

function renderScratchHandoffPrompt(displayPath: string, parentScratchDisplayPath: string | undefined): string {
	const lines = [
		"Scratch continuity protocol:",
		`- Existing scratch org file: ${displayPath}. Its current contents are already in context as continuation state; inspect or update the file only when live state diverges.`,
		"- Continue exactly as if no context reset, compaction, or handoff occurred. Do not mention, log, summarize, or count scratch loading, scratch reset, or compaction as work completed, evidence, progress, or a user-visible event unless the user explicitly asks about scratch mechanics.",
		"- Record the loaded skill/command stack in the `Skill stack:` field, in the order it was loaded (e.g. orient -> investigate-issue -> ...), so a successor session reloads and resumes the same stack.",
		"- Resume the active skill/workflow stack recorded in the scratch file or restored session context; do not restart the workflow from its initial capture/orientation step.",
		"- Treat the scratch file as the durable continuity packet for context pressure, resume, and successor sessions.",
		"- Track work inside the scratch file with org GTD TODO/DONE subheadings. Keep the current work under an active `** TODO ...` heading, record state as bullets under that heading, and add future work as child `*** TODO ...` subheadings.",
		"- A child TODO blocks closing its parent heading. Before marking the parent DONE, complete each child TODO or defer it explicitly with owner, blocker, next action, return condition, and source refs.",
		"- Do not use the separate todo tool/list for scratch-owned work; scratch org TODO headings are the task tracker in this setup.",
	];
	if (parentScratchDisplayPath) {
		lines.push(
			`- Parent scratch org file: ${parentScratchDisplayPath}. Link to it as [[file:${parentScratchDisplayPath}][Parent scratch handoff]] when you need parent context; do not write your subagent state into the parent file.`,
		);
	}
	lines.push(
		"- After orientation, write the first useful scratch delta if the file lacks current task state. Do not wait for the final response to create the first handoff.",
		"- After the first scratch delta, keep iteratively refining the same org heading instead of appending duplicate status blocks; add a new TODO subheading only for real child work.",
		"- Before any deliberate large read/edit/proof block, before context pressure can force compaction, and before ending with unfinished work, inspect the scratch file and update only stale or missing handoff state.",
		"- Do not rewrite or re-output the whole summary when the file is already current.",
		"- The scratch file must be enough for a successor session: current objective, loaded skill/command stack in load order, open org TODO subheadings, completed work, changed files, verification already run, blockers, next action, and source refs needed to continue.",
		"- Treat any automatic handoff or context-budget reserve as last-resort space for a concise final delta, not as the place to build the first scratch summary.",
		"- If no update is needed, leave the file unchanged and report one sentence saying it was already current.",
		"- In the final response, mention whether the scratch file was updated or unchanged and name the path.",
	);
	return lines.join("\n");
}

/**
 * Build the successor session's first model-visible handoff message. It leads
 * with the resume directive (reload the recorded skill stack in load order,
 * continue from the scratch org TODO subheading state, and do not restart),
 * then the scratch file path and its current contents. The recorded skill stack
 * and open TODO headings live inside the scratch body, so the directive surfaces
 * them as the first thing the successor must act on.
 */
export function renderScratchHandoffResumeMessage(input: {
	displayPath: string;
	scratchText: string;
	parentDisplayPath?: string;
	recentContextText?: string;
}): string {
	const parentLine = input.parentDisplayPath ? `Parent scratch: ${input.parentDisplayPath}\n` : "";
	const scratchContext = [
		`${parentLine}<scratch-handoff-context>`,
		`Path: ${input.displayPath}`,
		"",
		input.scratchText,
		"</scratch-handoff-context>",
	].join("\n");
	const recentContext = input.recentContextText?.trim();
	return [
		"Resume this session from the scratch handoff below.",
		"Reload and continue the skill/command stack recorded in the scratch file, in its original load order, and continue from the scratch file's org TODO subheading state. Continue the work already in progress.",
		"Do not restart the workflow from its orientation or initial-capture step, and do not treat this handoff as a new task.",
		"",
		scratchContext,
		recentContext
			? `\n<recent-session-context>\nRecent user, assistant, and tool-call turns that may not be reflected in the scratch file. Tool result bodies are intentionally omitted.\n\n${recentContext}\n</recent-session-context>`
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

export function renderScratchHandoffSyntheticRead(context: ScratchHandoffContext): string {
	return renderScratchHandoffResumeMessage({
		displayPath: context.displayPath,
		scratchText: context.scratchText,
		parentDisplayPath: context.parentDisplayPath,
	});
}

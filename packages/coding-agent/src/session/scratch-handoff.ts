import * as fs from "node:fs/promises";
import * as path from "node:path";

import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";

import { resolveToCwd } from "../tools/path-utils";

import { createCustomMessage } from "./messages";
import type { SessionEntry } from "./session-entries";

export const SCRATCH_HANDOFF_READ_CUSTOM_TYPE = "scratch-handoff-read";
export const SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE = "scratch-handoff-write";
export const SCRATCH_HANDOFF_CLOSEOUT_CUSTOM_TYPE = "scratch-handoff-closeout";

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

/** True when a scratch document contains at least one populated continuity field. */
export function scratchHandoffHasContent(text: string): boolean {
	const fieldPattern =
		/^-\s+(?:Objective|Skill stack|Work completed|Files changed|Verification|Blockers or risks|Next action|Source refs):[ \t]*(\S.*)$/gm;
	return fieldPattern.test(text);
}
/** True when a scratch document has the minimum state needed for an autonomous resume. */
export function scratchHandoffIsComplete(text: string): boolean {
	const hasOpenTodo = /^\*+\s+TODO\s+\S/m.test(text);
	const hasObjective = /^-\s+Objective:[ \t]*\S/m.test(text);
	const hasNextAction =
		/^-\s+Next action:[ \t]*\S/m.test(text) ||
		/^-\s+Next action:[ \t]*\n(?:[ \t]+(?:[-+*]|\d+\.)[ \t]+\S.*\n?)+/m.test(text);
	return hasOpenTodo && hasObjective && hasNextAction;
}

/**
 * Continuity state of the scratch document for one maintenance pass.
 *
 * - `verified`: resumable content that already covers every message in the delta
 *   window, so it can anchor composed native or standard compaction.
 * - `stale`: resumable content with work recorded after the last scratch write.
 *   The attached delta and the closeout instruction carry that work; this is the
 *   ordinary state whenever context pressure arrives before a closeout turn.
 * - `unusable`: the document lacks the objective, open TODO, or next action an
 *   autonomous resume needs, so the model must rebuild it.
 */
export type ScratchContinuityState = "verified" | "stale" | "unusable";

/** Classify scratch continuity from document content and recorded write state. */
export function resolveScratchContinuityState(input: {
	scratchText: string;
	/** A closeout turn wrote the document during this maintenance episode. */
	closeoutWriteCompleted: boolean;
	/** The current branch records at least one write to this scratch path. */
	hasRecordedWrite: boolean;
	/** Session work landed after the newest recorded write. */
	hasDelta: boolean;
}): ScratchContinuityState {
	if (!scratchHandoffIsComplete(input.scratchText)) return "unusable";
	if (input.closeoutWriteCompleted) return "verified";
	return input.hasRecordedWrite && !input.hasDelta ? "verified" : "stale";
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
	const explicitParent = nonEmptyString(input.parentScratchDisplayPath);
	return {
		scratchFile: nonEmptyString(input.scratchFile) ?? (explicitParent ? undefined : persisted?.scratchFile),
		parentScratchDisplayPath: explicitParent ?? persisted?.parentScratchDisplayPath,
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

/** Smallest inline delta the recent-context budget ever allows. */
export const SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS = 2_048;
/** Share of the context window an inline delta may consume. */
export const SCRATCH_HANDOFF_RECENT_CONTEXT_WINDOW_FRACTION = 0.1;

/**
 * scratchHandoffRecentContextBudget sizes the inline delta carried past a
 * handoff.
 *
 * Everything in the rebuilt context is a new prefix paid at full price, so an
 * unbounded inline delta re-buys the context the handoff exists to release.
 * Applies to serialized text only: a SnapCompact archive of the same delta is
 * bounded by its own frame budget and carries far more work per prefix token,
 * so it is never trimmed against this number.
 */
export function scratchHandoffRecentContextBudget(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS;
	return Math.max(
		SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS,
		Math.floor(contextWindow * SCRATCH_HANDOFF_RECENT_CONTEXT_WINDOW_FRACTION),
	);
}

/**
 * Index of the first entry the latest compaction kept. Entries before it left
 * the model context at that boundary, so the delta window must never reach back
 * across it even when no scratch write has been recorded since.
 */
function latestCompactionBoundaryIndex(entries: readonly SessionEntry[]): number {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "compaction") continue;
		const keptIndex = entries.findIndex(candidate => candidate.id === entry.firstKeptEntryId);
		return keptIndex >= 0 ? keptIndex : index + 1;
	}
	return 0;
}

/** First entry of the work not yet represented in the scratch document. */
function scratchHandoffDeltaStartIndex(entries: readonly SessionEntry[], scratchPath?: string): number {
	let start = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE) continue;
		if (scratchPath && (!isRecord(entry.data) || entry.data.path !== scratchPath)) continue;
		start = index + 1;
		break;
	}
	return Math.max(start, latestCompactionBoundaryIndex(entries));
}

/** Work recorded after the scratch document was last written. */
export interface ScratchHandoffDelta {
	/**
	 * The complete delta. Use it for representations that carry their own bound
	 * and compress well, such as a SnapCompact archive.
	 */
	text: string;
	/**
	 * The delta trimmed to the caller's token budget, for inline prefix text.
	 * Equal to {@link text} when the delta already fits.
	 */
	bounded: string;
}

/** Keep the newest messages that fit the budget; the oldest are dropped first. */
function trimDeltaToBudget(messages: Message[], maxTokens: number): { kept: Message[]; dropped: number } {
	if (!Number.isFinite(maxTokens) || maxTokens <= 0) return { kept: messages, dropped: 0 };
	let total = 0;
	let start = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		const cost = countTokens(snapcompact.serializeConversation([messages[index]]));
		if (start < messages.length && total + cost > maxTokens) break;
		total += cost;
		start = index;
		if (total >= maxTokens) break;
	}
	return { kept: messages.slice(start), dropped: start };
}

export function buildScratchHandoffRecentContext(input: {
	entries: readonly SessionEntry[];
	pendingMessages?: readonly AgentMessage[];
	scratchPath?: string;
	convertToLlm: ScratchHandoffMessageConverter;
	/** Token ceiling for {@link ScratchHandoffDelta.bounded}; unbounded when omitted. */
	maxTokens?: number;
}): ScratchHandoffDelta | undefined {
	const pendingMessages = input.pendingMessages ?? [];
	const messages = input.convertToLlm([
		...input.entries
			.slice(scratchHandoffDeltaStartIndex(input.entries, input.scratchPath))
			.map(sessionEntryMessage)
			.filter((message): message is AgentMessage => message !== undefined),
		...pendingMessages,
	]);
	const text = snapcompact.serializeConversation(messages).trim();
	if (text.length === 0) return undefined;
	const maxTokens = input.maxTokens ?? Number.POSITIVE_INFINITY;
	const { kept, dropped } = trimDeltaToBudget(messages, maxTokens);
	let bounded = dropped === 0 ? text : snapcompact.serializeConversation(kept).trim();
	// A single oversized message survives the message-level trim, so clamp the
	// serialized tail too: the inline budget is a hard bound, not a target.
	const maxChars = Number.isFinite(maxTokens) ? maxTokens * 4 : Number.POSITIVE_INFINITY;
	const omitted: string[] = [];
	if (dropped > 0) omitted.push(`${dropped} older message${dropped === 1 ? "" : "s"}`);
	if (bounded.length > maxChars) {
		bounded = bounded.slice(bounded.length - maxChars);
		omitted.push("an oversized head");
	}
	if (omitted.length > 0) {
		// Do not point at the scratch document here: this delta exists precisely
		// because the document does not cover it yet. Re-deriving is correct and
		// cheaper than acting on a guess.
		bounded = `[Older session context was dropped to keep this resume small: ${omitted.join(" and ")} omitted. If continuing needs detail from that span, re-derive it from the workspace (re-read files, re-run commands) instead of assuming it.]\n\n${bounded}`;
	}
	return { text, bounded };
}

export async function buildScratchHandoffContext(input: {
	cwd: string;
	rootCwd?: string;
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
		cwd: input.rootCwd ?? input.cwd,
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
	const lines = [
		"#+TITLE: Current agent work",
		`#+DATE: ${isoDate}`,
		`#+SESSION: ${input.sessionId}`,
		`#+PATH: ${input.displayPath}`,
	];
	if (input.parentScratchDisplayPath) {
		lines.push(`#+PARENT_SCRATCH: [[file:${input.parentScratchDisplayPath}][Parent scratch handoff]]`);
	}
	lines.push(
		"",
		"* TODO Current work",
		"- Objective: ",
		"- Skill stack: ",
		"- Work completed: ",
		"- Files changed: ",
		"- Verification: ",
		"- Blockers or risks: ",
		"- Next action: ",
		"- Source refs: ",
	);
	return `${lines.join("\n")}\n`;
}

function renderScratchHandoffPrompt(displayPath: string, parentScratchDisplayPath: string | undefined): string {
	const lines = [
		"Scratch continuity protocol:",
		`- Existing scratch org file: ${displayPath}. Its current contents are already in context as continuation state; inspect or update the file only when live state diverges.`,
		"- Continue exactly as if no context reset, compaction, or handoff occurred. Do not mention, log, summarize, or count scratch loading, scratch updates, scratch reset, or compaction as work completed, evidence, progress, or a user-visible event unless the user explicitly asks about scratch mechanics.",
		"- Treat `Skill stack:` as a minimal continuation dependency list, not session history. Record only skills required by the current open TODO or next concrete action, preserving original relative load order. Remove completed-phase, one-shot orientation/planning/review, stale, superseded, duplicate, and merely historical skills. Leave it empty when no skill is currently required.",
		"- Keep `#+TITLE` as a one-line summary of the agent's current purpose when a scratch update is warranted.",
		"- Keep scratch metadata in root org keywords such as `#+SESSION`, `#+PATH`, and optional `#+PARENT_SCRATCH`; do not add a wrapper heading above the work tree.",
		"- On resume, use the current open TODO and next action to select skills. Load only recorded entries the immediate work requires, preserving their recorded order. Skip clearly irrelevant, stale, historical, or duplicate entries; apply normal skill matching to newly relevant skills. NEVER mechanically replay the full field or restart completed orientation/capture steps.",
		"- Treat the scratch file as the durable continuity packet for context pressure, compaction, and process resume, not a progress log for trivial turns.",
		"- When updating scratch, track work inside the file with org GTD TODO/DONE subheadings. Keep the current work under an active `* TODO ...` heading, record state as bullets under that heading, and add future work as child `** TODO ...` subheadings.",
		"- A child TODO blocks closing its parent heading. Before marking the parent DONE, complete each child TODO or defer it explicitly with owner, blocker, next action, return condition, and source refs.",
		"- Keep verification as current proof and residual risk, not a transcript of intermediate skill steps. Record commands only when continuation needs the exact invocation, output, blocker, or falsifier.",
		"- Do not use the separate todo tool/list for scratch-owned work; scratch org TODO headings are the task tracker in this setup.",
	];
	if (parentScratchDisplayPath) {
		lines.push(
			`- Parent scratch org file: ${parentScratchDisplayPath}. Link to it as [[file:${parentScratchDisplayPath}][Parent scratch handoff]] when you need parent context; do not write your subagent state into the parent file.`,
		);
	}
	lines.push(
		"- Do not update the scratch document during ordinary work. Update it only when a handoff or closeout instruction explicitly asks you to, unless the significant-work exception applies.",
		"- Significant-work exception: if a significant amount of non-trivial work has already been done and completing it is projected to require significant further work after a likely handoff, update scratch before that handoff risk; trivial lookups, small edits, and routine status changes do not qualify.",
		"- When an update is warranted, refine the same org heading instead of appending duplicate status blocks; add a new TODO subheading only for real child work.",
		"- Do not rewrite or re-output the whole summary when the file is already current.",
		"- The scratch file must be a full, comprehensive snapshot of current work so another agent can resume with little to no warm-up: current objective, minimal current/next-task skill dependencies in relative load order, open org TODO subheadings, completed work, touched files, current proof, blockers, next action, and source refs needed to continue.",
		"- Org-link artifacts, issues, plans, logs, traces, or large evidence instead of copying their bodies into scratch; the scratch document is the resumption index and current-state snapshot, not an artifact dump.",
		"- Treat any automatic handoff or context-budget reserve as last-resort space for a concise final delta; if scratch is stale because an update was warranted, update it into the comprehensive snapshot before handoff.",
		"- If no update is needed, leave the file unchanged; do not report scratch state to the user.",
		"- Org wrapping the scratch document is unnecessary; keep the org structure valid and readable, but do not run a formatter solely for scratch-handoff text.",
		"- In final responses, do not mention whether the scratch file was updated, unchanged, or where it lives unless the user explicitly asks about scratch mechanics. Scratch continuity is internal maintenance, not task evidence.",
	);
	return lines.join("\n");
}

export function renderScratchHandoffCloseoutMessage(displayPath: string): string {
	return [
		"Context maintenance threshold reached. PENCILS DOWN.",
		`This turn is now scratch-handoff maintenance only. Before any more task work, update the existing scratch org file at ${displayPath}.`,
		"Do not clear, recreate, truncate, rename, or replace the scratch file with a fresh template.",
		"Update the current TODO heading completely and accurately as a full, comprehensive snapshot so another agent can resume with little to no warm-up: objective; only skills required by the current open TODO or next concrete action, in original relative load order; completed work; touched files; current proof; blockers or risks; next action; and source refs. The skill stack is not session history: remove completed-phase, one-shot, stale, superseded, duplicate, and merely historical skills; leave it empty when none are required.",
		"Org-link artifacts, issues, plans, logs, traces, or large evidence instead of copying their bodies into scratch. Use the edit or write tool against that exact scratch path.",
		"After the scratch write succeeds, END THE TURN immediately. NEVER start or continue task work, invoke another task tool, emit a user-facing scratch status, or name the scratch path. The next turn or agent resumes from the scratch; the runtime observes the write directly.",
	].join("\n");
}

/**
 * Build the first model-visible message after scratch compaction or process
 * resume. It directs the model to select only skills needed by immediate work,
 * continue from the scratch org TODO state, and avoid restarting.
 */
export function renderScratchHandoffResumeMessage(input: {
	displayPath: string;
	scratchText: string;
	parentDisplayPath?: string;
	recentContextText?: string;
	recentContextSnapcompactFrames?: number;
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
	const snapcompactFrames = input.recentContextSnapcompactFrames ?? 0;
	const recentContextBlock =
		snapcompactFrames > 0
			? `<recent-session-context>\nThe complete session delta after the most recent successful scratch write is preserved in ${snapcompactFrames} attached SnapCompact frames. Read those frames before continuing so tool results, decisions, and verification newer than the scratch file remain authoritative.\n</recent-session-context>`
			: recentContext
				? `<recent-session-context>\nSession context newer than the scratch file follows.\n\n${recentContext}\n</recent-session-context>`
				: "";
	return [
		"Resume this session from the scratch handoff below.",
		"Use the scratch file's current open TODO and next action to choose skills for immediate work. Load only relevant entries from its `Skill stack:` field, preserving their recorded order. Skip clearly irrelevant, stale, historical, or duplicate entries; apply normal skill matching if immediate work needs an unrecorded skill. NEVER mechanically replay the full field. Then resume the work already in progress.",
		"Do not restart the workflow from its orientation or initial-capture step, and do not treat this handoff as a new task.",
		"",
		scratchContext,
		recentContextBlock ? `\n${recentContextBlock}` : "",
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

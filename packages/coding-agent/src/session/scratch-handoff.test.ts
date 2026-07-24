import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentMessage, countTokens } from "@oh-my-pi/pi-agent-core";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "./messages";
import {
	buildScratchHandoffContext,
	buildScratchHandoffRecentContext,
	latestPersistedScratchHandoffPathSelection,
	renderScratchHandoffCloseoutMessage,
	renderScratchHandoffResumeMessage,
	resolveScratchContinuityState,
	resolveScratchHandoffPathSelection,
	SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
	SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS,
	SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
	scratchHandoffIsComplete,
	scratchHandoffRecentContextBudget,
} from "./scratch-handoff";
import type { SessionEntry } from "./session-entries";

describe("scratchHandoffIsComplete", () => {
	it("requires an open TODO, objective, and next action", () => {
		expect(
			scratchHandoffIsComplete(
				"* TODO Resume implementation\n- Objective: Finish compaction\n- Next action:\n  1. Run focused tests\n",
			),
		).toBe(true);
		expect(scratchHandoffIsComplete("- Objective: Missing TODO\n- Next action: Continue\n")).toBe(false);
		expect(scratchHandoffIsComplete("* TODO Missing next action\n- Objective: Continue\n")).toBe(false);
	});
});

describe("resolveScratchContinuityState", () => {
	const resumable = "* TODO Resume implementation\n- Objective: Finish compaction\n- Next action: Run focused tests\n";

	it("rejects a document without resumable state", () => {
		expect(
			resolveScratchContinuityState({
				scratchText: "notes without a TODO",
				closeoutWriteCompleted: true,
				hasRecordedWrite: true,
				hasDelta: false,
			}),
		).toBe("unusable");
	});

	it("verifies a closeout write and a write with no delta after it", () => {
		expect(
			resolveScratchContinuityState({
				scratchText: resumable,
				closeoutWriteCompleted: true,
				hasRecordedWrite: false,
				hasDelta: true,
			}),
		).toBe("verified");
		expect(
			resolveScratchContinuityState({
				scratchText: resumable,
				closeoutWriteCompleted: false,
				hasRecordedWrite: true,
				hasDelta: false,
			}),
		).toBe("verified");
	});

	it("treats resumable content with newer work as stale, not broken", () => {
		expect(
			resolveScratchContinuityState({
				scratchText: resumable,
				closeoutWriteCompleted: false,
				hasRecordedWrite: true,
				hasDelta: true,
			}),
		).toBe("stale");
		expect(
			resolveScratchContinuityState({
				scratchText: resumable,
				closeoutWriteCompleted: false,
				hasRecordedWrite: false,
				hasDelta: false,
			}),
		).toBe("stale");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function scratchReadEntry(id: string, path: string, parentPath?: string): SessionEntry {
	return {
		type: "custom_message",
		customType: SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
		content: "",
		details: { path, parentPath },
		display: false,
		attribution: "agent",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
	};
}

function scratchWriteEntry(id: string, scratchPath = "agent/current.org"): SessionEntry {
	return {
		type: "custom",
		customType: SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
		data: { path: scratchPath },
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
	};
}

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
		} as AgentMessage,
	};
}

function assistantEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			provider: "test",
			model: "test",
			stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
		} as AgentMessage,
	};
}

function assistantToolEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call-read",
					name: "read",
					arguments: { path: "src/file.ts" },
				},
			],
			provider: "test",
			model: "test",
			stopReason: "toolUse",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
		} as unknown as AgentMessage,
	};
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		summary: "Continue from the scratch handoff state preserved after this compaction.",
		shortSummary: "Scratch handoff",
		firstKeptEntryId,
		tokensBefore: 0,
	} as SessionEntry;
}

function toolResultEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-06-29T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text }],
			timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
		} as AgentMessage,
	};
}

function skillPromptMessage(text: string): AgentMessage {
	return {
		role: "custom",
		customType: SKILL_PROMPT_MESSAGE_TYPE,
		content: text,
		display: true,
		attribution: "user",
		details: { name: "investigate-issue", path: "skill://investigate-issue", lineCount: 1 },
		timestamp: Date.parse("2026-06-29T00:00:00.000Z"),
	};
}

describe("scratch handoff path selection", () => {
	it("reuses the latest persisted scratch path for a resumed successor session", () => {
		const entries: SessionEntry[] = [
			scratchReadEntry("old", "agent/20260629/Main-old-session.org"),
			scratchReadEntry("new", "agent/20260629/Main-original-session.org"),
		];

		expect(latestPersistedScratchHandoffPathSelection(entries)).toEqual({
			scratchFile: "agent/20260629/Main-original-session.org",
			parentScratchDisplayPath: undefined,
		});
		expect(resolveScratchHandoffPathSelection({ entries }).scratchFile).toBe(
			"agent/20260629/Main-original-session.org",
		);
	});

	it("lets an explicit scratch file override restored session state", () => {
		const entries = [scratchReadEntry("persisted", "agent/20260629/Main-original-session.org")];

		expect(
			resolveScratchHandoffPathSelection({
				entries,
				scratchFile: "agent/manual.org",
			}),
		).toEqual({
			scratchFile: "agent/manual.org",
			parentScratchDisplayPath: undefined,
		});
	});

	it("carries the persisted parent scratch path unless the caller supplies one", () => {
		const entries = [
			scratchReadEntry("sub", "agent/20260629/Sub-original-session.org", "agent/20260629/Main-original-session.org"),
		];

		expect(resolveScratchHandoffPathSelection({ entries })).toEqual({
			scratchFile: "agent/20260629/Sub-original-session.org",
			parentScratchDisplayPath: "agent/20260629/Main-original-session.org",
		});
		expect(
			resolveScratchHandoffPathSelection({
				entries,
				parentScratchDisplayPath: "agent/20260629/Main-current-session.org",
			}),
		).toEqual({
			scratchFile: undefined,
			parentScratchDisplayPath: "agent/20260629/Main-current-session.org",
		});
	});
});

describe("scratch handoff prompt", () => {
	it("keeps scratch maintenance internal and skips org wrapping", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scratch-handoff-"));
		try {
			const context = await buildScratchHandoffContext({
				cwd,
				sessionId: "Main-session",
				settings: { enabled: true, rootDir: "agent" },
				date: new Date("2026-06-30T00:00:00.000Z"),
			});

			expect(context?.scratchText).toContain("- Skill stack: ");
			expect(context?.prompt).toContain("minimal continuation dependency list, not session history");
			expect(context?.prompt).toContain("current open TODO or next concrete action");
			expect(context?.prompt).toContain("Leave it empty when no skill is currently required");
			expect(context?.prompt).toContain("NEVER mechanically replay the full field");
			expect(context?.prompt).not.toContain("load exactly the recorded `Skill stack:`");
			expect(context?.prompt).toContain("Org wrapping the scratch document is unnecessary");
			expect(context?.prompt).toContain("do not run a formatter solely for scratch-handoff text");
			expect(context?.prompt).toContain("Scratch continuity is internal maintenance, not task evidence.");
			expect(context?.prompt).toContain("do not report scratch state to the user");
			expect(context?.prompt).toContain("Do not update the scratch document during ordinary work.");
			expect(context?.prompt).toContain("unless the significant-work exception applies");
			expect(context?.prompt).toContain("trivial lookups, small edits, and routine status changes do not qualify");
			expect(context?.prompt).not.toContain("After orientation, write the first useful scratch delta");
			expect(context?.prompt).not.toContain("report one sentence saying it was already current");
			expect(context?.prompt).not.toContain("In the final response, mention whether the scratch file was updated");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("preserves an existing scratch document instead of resetting it", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scratch-handoff-"));
		try {
			const scratchFile = path.join(cwd, "agent/current.org");
			await fs.mkdir(path.dirname(scratchFile), { recursive: true });
			await fs.writeFile(scratchFile, "* TODO Existing work\n- Objective: keep me\n", "utf8");

			const context = await buildScratchHandoffContext({
				cwd,
				sessionId: "Main-session",
				scratchFile: "agent/current.org",
				settings: { enabled: true, rootDir: "agent" },
			});

			expect(context?.scratchText).toContain("Objective: keep me");
			expect(await fs.readFile(scratchFile, "utf8")).toBe("* TODO Existing work\n- Objective: keep me\n");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("puts pencils down after a complete threshold closeout snapshot", () => {
		const prompt = renderScratchHandoffCloseoutMessage("agent/current.org");

		expect(prompt).toContain("PENCILS DOWN");
		expect(prompt).toContain("scratch-handoff maintenance only");
		expect(prompt).toContain("completely and accurately");
		expect(prompt).toContain("full, comprehensive snapshot");
		expect(prompt).toContain("only skills required by the current open TODO or next concrete action");
		expect(prompt).toContain("skill stack is not session history");
		expect(prompt).toContain("leave it empty when none are required");
		expect(prompt).toContain("little to no warm-up");
		expect(prompt).toContain("Org-link artifacts");
		expect(prompt).toContain("Do not clear, recreate, truncate, rename, or replace");
		expect(prompt).toContain("END THE TURN immediately");
		expect(prompt).toContain("NEVER start or continue task work");
		expect(prompt).toContain("The next turn or agent resumes from the scratch");
		expect(prompt).toContain("do not reread or separately verify the file");
		expect(prompt).not.toContain("stop with a brief note");
	});
	it("resumes with judgment instead of replaying historical skills", () => {
		const message = renderScratchHandoffResumeMessage({
			displayPath: "agent/current.org",
			scratchText:
				"- Skill stack: orient -> investigate-issue -> write-review -> investigate-issue\n- Next action: fix parser",
		});

		expect(message).toContain("current open TODO and next action");
		expect(message).toContain("Load only relevant entries");
		expect(message).toContain("Skip clearly irrelevant, stale, historical, or duplicate entries");
		expect(message).toContain("apply normal skill matching");
		expect(message).toContain("NEVER mechanically replay the full field");
		expect(message).not.toContain("Before any other work");
		expect(message).toContain("supplied continuation state");
		expect(message).toContain("first executable step");
		expect(message).toContain("defer skills for later steps");
		expect(message).toContain("execute it in the same turn");
		expect(message).toContain("do not repeat repair or orientation");
		expect(message).not.toContain("load exactly");
		expect(message).toContain("- Skill stack: orient -> investigate-issue -> write-review -> investigate-issue");
	});
});

describe("scratch handoff recent context", () => {
	it("starts after the most recent scratch write marker", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [
				userEntry("user-old", "old user request"),
				scratchWriteEntry("write"),
				assistantEntry("after", "after scratch write"),
			],
			convertToLlm,
		});

		expect(context?.text).not.toContain("old user request");
		expect(context?.text).toContain("after scratch write");
	});

	it("ignores write markers for a different scratch target", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [
				userEntry("user-old", "old user request"),
				scratchWriteEntry("write", "agent/old.org"),
				assistantEntry("after", "after old scratch write"),
			],
			scratchPath: "agent/new.org",
			convertToLlm,
		});

		expect(context?.text).toContain("old user request");
		expect(context?.text).toContain("after old scratch write");
	});

	it("keeps the complete delta after the most recent scratch write", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [
				scratchWriteEntry("write"),
				assistantEntry("old-after", "old assistant context"),
				userEntry("user-new", "latest user request"),
				assistantEntry("new-after", "new assistant context"),
			],
			convertToLlm,
		});

		expect(context?.text).toContain("old assistant context");
		expect(context?.text).toContain("latest user request");
		expect(context?.text).toContain("new assistant context");
	});

	it("appends pending messages to the complete persisted delta", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [userEntry("user-old", "old persisted request"), assistantEntry("old-after", "old answer")],
			pendingMessages: [skillPromptMessage("fresh skill-read request")],
			convertToLlm,
		});

		expect(context?.text).toContain("old persisted request");
		expect(context?.text).toContain("old answer");
		expect(context?.text).toContain("fresh skill-read request");
	});

	it("serializes the post-write delta for SnapCompact", () => {
		const serializeSpy = vi.spyOn(snapcompact, "serializeConversation");

		const context = buildScratchHandoffRecentContext({
			entries: [
				scratchWriteEntry("write"),
				userEntry("user-new", "latest user request"),
				assistantToolEntry("assistant"),
				toolResultEntry("tool", "decisive tool result"),
			],
			convertToLlm,
		});

		expect(serializeSpy).toHaveBeenCalledTimes(1);
		expect(serializeSpy.mock.calls[0]?.[0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user" }),
				expect.objectContaining({ role: "assistant" }),
				expect.objectContaining({ role: "toolResult" }),
			]),
		);
		expect(context?.text).toContain("latest user request");
		expect(context?.text).toContain("read(");
		expect(context?.text).toContain("decisive tool result");
	});

	it("never reaches back across the latest compaction boundary", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [
				userEntry("user-old", "already compacted request"),
				scratchReadEntry("kept", "agent/current.org"),
				compactionEntry("compaction", "kept"),
				assistantEntry("after", "work after the boundary"),
			],
			scratchPath: "agent/current.org",
			convertToLlm,
		});

		expect(context?.text).not.toContain("already compacted request");
		expect(context?.text).toContain("work after the boundary");
	});

	it("bounds the inline delta while leaving the SnapCompact delta complete", () => {
		const entries = Array.from({ length: 40 }, (_, index) =>
			userEntry(`user-${index}`, `request ${index} ${"filler ".repeat(200)}`),
		);

		const context = buildScratchHandoffRecentContext({ entries, convertToLlm, maxTokens: 512 });

		// Inline text is re-billed on every request of the next segment, so it takes
		// the budget and says what it dropped.
		expect(context?.bounded).toContain("Older session context was dropped");
		expect(context?.bounded).toContain("re-derive it from the workspace");
		expect(context?.bounded).toContain("request 39");
		expect(context?.bounded).not.toContain("request 0 ");
		expect(countTokens(context?.bounded ?? "")).toBeLessThan(1_024);
		// SnapCompact frames carry their own bound and cost a fraction of the same
		// work, so the full delta stays available to them.
		expect(context?.text).toContain("request 0 ");
		expect(context?.text).toContain("request 39");
	});

	it("clamps a single oversized message to the inline budget", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [userEntry("huge", `head marker ${"filler ".repeat(20_000)} tail marker`)],
			convertToLlm,
			maxTokens: 256,
		});

		expect(context?.bounded).toContain("tail marker");
		expect(context?.bounded).not.toContain("head marker");
		expect(countTokens(context?.bounded ?? "")).toBeLessThan(512);
		expect(context?.text).toContain("head marker");
	});

	it("leaves a delta that already fits untouched", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [userEntry("small", "short request")],
			convertToLlm,
			maxTokens: 4_096,
		});

		expect(context?.bounded).toBe(context?.text);
		expect(context?.bounded).not.toContain("Older session context was dropped");
	});

	it("sizes the budget from the context window", () => {
		expect(scratchHandoffRecentContextBudget(200_000)).toBe(20_000);
		expect(scratchHandoffRecentContextBudget(8_000)).toBe(SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS);
		expect(scratchHandoffRecentContextBudget(0)).toBe(SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS);
	});

	it("renders the SnapCompact delta after the scratch body", () => {
		const message = renderScratchHandoffResumeMessage({
			displayPath: "agent/current.org",
			scratchText: "- Current objective: patch",
			recentContextSnapcompactFrames: 2,
		});

		expect(message).toContain("<scratch-handoff-context>");
		expect(message).toContain("<recent-session-context>");
		expect(message).toContain("2 attached SnapCompact frames");
		expect(message).not.toContain("Tool result bodies are intentionally omitted");
	});
});

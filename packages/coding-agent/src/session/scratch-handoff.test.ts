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
	renderScratchHandoffSyntheticRead,
	resolveScratchContinuityState,
	resolveScratchHandoffPathSelection,
	SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
	SCRATCH_HANDOFF_RECENT_CONTEXT_MIN_TOKENS,
	SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
	scratchHandoffBodyPreview,
	scratchHandoffIsComplete,
	scratchHandoffRecentContextBudget,
} from "./scratch-handoff";
import type { SessionEntry } from "./session-entries";
import { resolveAutoCompactionAction } from "./session-maintenance";

describe("scratchHandoffIsComplete", () => {
	it("requires one root TODO with its own objective and next action", () => {
		expect(
			scratchHandoffIsComplete(
				"* TODO Resume implementation\n- Objective: Finish compaction\n- Next action:\n  1. Run focused tests\n",
			),
		).toBe(true);
		expect(scratchHandoffIsComplete("- Objective: Missing TODO\n- Next action: Continue\n")).toBe(false);
		expect(scratchHandoffIsComplete("* TODO Missing next action\n- Objective: Continue\n")).toBe(false);
		expect(
			scratchHandoffIsComplete(
				"* TODO Empty current task\n- Objective: \n- Next action: \n* DONE Historical task\n- Objective: Old objective\n- Next action: Old action\n",
			),
		).toBe(false);
		expect(
			scratchHandoffIsComplete(
				"* TODO First task\n- Objective: First\n- Next action: Continue\n* TODO Ambiguous task\n- Objective: Second\n- Next action: Continue\n",
			),
		).toBe(false);
	});
});

describe("scratch handoff strategy", () => {
	it("is explicit and no longer changes ordinary handoff semantics", () => {
		expect(
			resolveAutoCompactionAction({
				strategy: "scratch-handoff",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: true,
			}),
		).toBe("scratch-handoff");
		expect(
			resolveAutoCompactionAction({
				strategy: "handoff",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: true,
			}),
		).toBe("handoff");
		expect(
			resolveAutoCompactionAction({
				strategy: "scratch-handoff",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: false,
			}),
		).toBe("context-full");
	});

	it("native-or-scratch prefers provider-native context-full when available", () => {
		const nativeModel = {
			id: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
		} as const;
		expect(
			resolveAutoCompactionAction({
				strategy: "native-or-scratch",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: true,
				model: nativeModel as never,
				remoteEnabled: true,
			}),
		).toBe("context-full");
	});

	it("native-or-scratch falls back to scratch when native is unavailable", () => {
		const copilotModel = {
			id: "grok-4.5",
			provider: "github-copilot",
			api: "openai-completions",
		} as const;
		expect(
			resolveAutoCompactionAction({
				strategy: "native-or-scratch",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: true,
				model: copilotModel as never,
				remoteEnabled: true,
			}),
		).toBe("scratch-handoff");
		expect(
			resolveAutoCompactionAction({
				strategy: "native-or-scratch",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: false,
				model: copilotModel as never,
				remoteEnabled: true,
			}),
		).toBe("context-full");
	});

	it("native-or-scratch respects remoteEnabled false", () => {
		const nativeModel = {
			id: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses",
		} as const;
		expect(
			resolveAutoCompactionAction({
				strategy: "native-or-scratch",
				reason: "threshold",
				suppressHandoff: false,
				hasScratchHandoff: true,
				model: nativeModel as never,
				remoteEnabled: false,
			}),
		).toBe("scratch-handoff");
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
	it("keeps scratch lazy and supplies concise maintenance rules", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-scratch-handoff-"));
		try {
			const context = await buildScratchHandoffContext({
				cwd,
				sessionId: "Main-session",
				settings: { enabled: true, rootDir: "agent" },
				date: new Date("2026-06-30T00:00:00.000Z"),
			});

			expect(context?.exists).toBe(false);
			expect(context?.scratchText).toBe("");
			expect(await Bun.file(path.join(cwd, "agent/20260630/Main-session.org")).exists()).toBe(false);
			expect(context?.prompt).toContain("File not created yet");
			expect(context?.prompt).toContain("Scratch = bounded current-state checkpoint");
			expect(context?.prompt).toContain("exactly one root `* TODO`");
			expect(context?.prompt).toContain("NEVER replay full stack");
			expect(context?.prompt).toContain("do not duplicate it in todo tool");
			expect(context?.prompt).toContain("No update needed? Leave unchanged");
			const synthetic = renderScratchHandoffSyntheticRead(context!);
			expect(synthetic).toContain("No scratch checkpoint exists yet");
			expect(synthetic).not.toContain("<scratch-handoff-context>");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);

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

			expect(context?.exists).toBe(true);
			expect(context?.scratchText).toContain("Objective: keep me");
			expect(await fs.readFile(scratchFile, "utf8")).toBe("* TODO Existing work\n- Objective: keep me\n");
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 15_000);

	it("forces edit for existing checkpoints and write only for lazy creation", () => {
		const editPrompt = renderScratchHandoffCloseoutMessage("agent/current.org");
		const createPrompt = renderScratchHandoffCloseoutMessage("agent/current.org", true);

		expect(editPrompt).toContain("PENCILS DOWN");
		expect(editPrompt).toContain("edit `agent/current.org` using the `edit` tool");
		expect(editPrompt).toContain("NEVER clear, recreate, rename, or replace");
		expect(editPrompt).toContain("exactly one active `* TODO`");
		expect(editPrompt).toContain("Remove completed-history subtrees");
		expect(editPrompt).toContain("END TURN immediately");
		expect(createPrompt).toContain("create `agent/current.org` using the `write` tool");
	});

	it("resumes with judgment instead of replaying historical skills", () => {
		const message = renderScratchHandoffResumeMessage({
			displayPath: "agent/current.org",
			scratchText:
				"- Skill stack: orient -> investigate-issue -> write-review -> investigate-issue\n- Next action: fix parser",
		});

		expect(message).toContain("Choose skills from active TODO + next action");
		expect(message).toContain("skip stale, historical, duplicate entries");
		expect(message).toContain("normal matching");
		expect(message).toContain("NEVER replay full stack");
		expect(message).toContain("continuation state");
		expect(message).toContain("first executable step");
		expect(message).toContain("execute in same turn");
		expect(message).toContain("Do not repeat startup repair");
		expect(message).toContain("- Skill stack: orient -> investigate-issue -> write-review -> investigate-issue");
	});

	it("injects a token-bounded checkpoint beginning and directs conditional full reads", () => {
		const scratchText = `* TODO Current\n- Objective: preserve beginning\n${"history ".repeat(20_000)}`;
		const preview = scratchHandoffBodyPreview(scratchText, 256);
		const message = renderScratchHandoffResumeMessage({
			displayPath: "agent/current.org",
			scratchText: preview.text,
			scratchTruncated: preview.truncated,
		});

		expect(preview.truncated).toBe(true);
		expect(countTokens(preview.text)).toBeLessThanOrEqual(256);
		expect(preview.text).toContain("preserve beginning");
		expect(message).toContain("Only checkpoint beginning is injected");
		expect(message).toContain("Read `agent/current.org` only if");
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
		expect(context?.bounded).toContain("Older session context dropped");
		expect(context?.bounded).toContain("Re-derive missing detail");
		expect(context?.bounded).toContain("request 39");
		expect(context?.bounded).not.toContain("request 0 ");
		expect(countTokens(context?.bounded ?? "")).toBeLessThanOrEqual(512);
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
		expect(countTokens(context?.bounded ?? "")).toBeLessThanOrEqual(256);
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

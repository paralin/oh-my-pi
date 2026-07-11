import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE } from "./messages";
import {
	buildScratchHandoffContext,
	buildScratchHandoffRecentContext,
	latestPersistedScratchHandoffPathSelection,
	renderScratchHandoffCloseoutMessage,
	renderScratchHandoffResumeMessage,
	resolveScratchHandoffPathSelection,
	SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
	SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
} from "./scratch-handoff";
import type { SessionEntry } from "./session-entries";

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

function scratchWriteEntry(id: string): SessionEntry {
	return {
		type: "custom",
		customType: SCRATCH_HANDOFF_WRITE_CUSTOM_TYPE,
		data: { path: "agent/current.org" },
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
			scratchFile: "agent/20260629/Sub-original-session.org",
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

	it("asks threshold closeout to write a comprehensive snapshot and link artifacts", () => {
		const prompt = renderScratchHandoffCloseoutMessage("agent/current.org");

		expect(prompt).toContain("full, comprehensive snapshot");
		expect(prompt).toContain("little to no warm-up");
		expect(prompt).toContain("Org-link artifacts");
		expect(prompt).toContain("Do not clear, recreate, truncate, rename, or replace");
		expect(prompt).toContain("stop without emitting a user-facing scratch status");
		expect(prompt).not.toContain("stop with a brief note");
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

		expect(context).not.toContain("old user request");
		expect(context).toContain("after scratch write");
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

		expect(context).toContain("old assistant context");
		expect(context).toContain("latest user request");
		expect(context).toContain("new assistant context");
	});

	it("appends pending messages to the complete persisted delta", () => {
		const context = buildScratchHandoffRecentContext({
			entries: [userEntry("user-old", "old persisted request"), assistantEntry("old-after", "old answer")],
			pendingMessages: [skillPromptMessage("fresh skill-read request")],
			convertToLlm,
		});

		expect(context).toContain("old persisted request");
		expect(context).toContain("old answer");
		expect(context).toContain("fresh skill-read request");
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
		expect(context).toContain("latest user request");
		expect(context).toContain("read(");
		expect(context).toContain("decisive tool result");
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

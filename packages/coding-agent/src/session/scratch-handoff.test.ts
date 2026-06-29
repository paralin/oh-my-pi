import { describe, expect, it } from "bun:test";

import {
	latestPersistedScratchHandoffPathSelection,
	resolveScratchHandoffPathSelection,
	SCRATCH_HANDOFF_READ_CUSTOM_TYPE,
} from "./scratch-handoff";
import type { SessionEntry } from "./session-entries";

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

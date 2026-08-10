import { describe, expect, test } from "bun:test";
import {
	decodeExternalSubagentProfile,
	EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES,
	type ExternalSubagentProfileV2,
	encodeExternalSubagentProfile,
} from "@oh-my-pi/pi-coding-agent/coordination/external-subagent-profile";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

function profile(): ExternalSubagentProfileV2 {
	return {
		schemaVersion: 2,
		runtime: "native",
		isolated: false,
		peerId: "reviewer-2",
		label: "Reviewer 2",
		assignment: "Review the durable mailbox.",
		batchContext: "Inspect the same backend contract.",
		parentToolCallId: "call-1",
		taskDepth: 1,
		agent: {
			name: "reviewer",
			source: "bundled",
			systemPrompt: "Review for correctness.",
			tools: ["read", "grep"],
			spawns: [],
			skills: ["post-work-review"],
		},
		effort: "hi",
		enableIrc: true,
		modelSelector: ["openai-codex/gpt-5.6-sol:high"],
		thinkingLevel: parseConfiguredThinkingLevel("high")!,
		maxRuntimeMs: 60_000,
		outputSchema: {
			schema: { type: "object" },
			source: "caller",
			mode: "strict",
		},
		workspaceRoots: ["/workspace", "/shared"],
	};
}

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe("external subagent profile", () => {
	test("round-trips deterministic canonical bytes and digest", () => {
		const first = encodeExternalSubagentProfile(profile());
		const second = encodeExternalSubagentProfile(profile());
		expect(first.bytes).toEqual(second.bytes);
		expect(first.digest).toBe(second.digest);
		expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(decodeExternalSubagentProfile(first.bytes, first.digest)).toEqual(profile());
	});

	test("rejects noncanonical input and digest mismatch", () => {
		const encoded = encodeExternalSubagentProfile(profile());
		const noncanonical = bytes(` ${new TextDecoder().decode(encoded.bytes)}`);
		expect(() => decodeExternalSubagentProfile(noncanonical, Bun.SHA256.hash(noncanonical, "hex"))).toThrow(
			"not canonical",
		);
		expect(() => decodeExternalSubagentProfile(encoded.bytes, "0".repeat(64))).toThrow("digest");
	});

	test("rejects unknown, missing, and invalid fence fields", () => {
		const base = JSON.parse(new TextDecoder().decode(encodeExternalSubagentProfile(profile()).bytes));
		for (const invalid of [
			{ ...base, unknown: true },
			Object.fromEntries(Object.entries(base).filter(([key]) => key !== "peerId")),
			{ ...base, schemaVersion: 1 },
			{ ...base, agent: { ...base.agent, readMode: "summary" } },
			{ ...base, runtime: "claude-code" },
			{ ...base, isolated: true },
		]) {
			const raw = bytes(JSON.stringify(invalid, Object.keys(invalid).sort()));
			expect(() => decodeExternalSubagentProfile(raw, Bun.SHA256.hash(raw, "hex"))).toThrow();
		}
	});

	test("enforces the one MiB bound", () => {
		const oversized = profile();
		oversized.agent.systemPrompt = "x".repeat(EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES);
		expect(() => encodeExternalSubagentProfile(oversized)).toThrow("exceeds");
		const raw = bytes("x".repeat(EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES + 1));
		expect(() => decodeExternalSubagentProfile(raw, Bun.SHA256.hash(raw, "hex"))).toThrow("1-1048576");
	});
});

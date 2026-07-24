import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildCompactionMeasurement, buildLlmUsageEvent, prefixIdentityHash } from "./measurement-events";

const usage = {
	input: 100,
	output: 25,
	cacheRead: 300,
	cacheWrite: 10,
	totalTokens: 435,
	orchestration: { input: 20 },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-5",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("measurement event replay", () => {
	it("attributes a deliberate prefix reset and preserves both token scales", () => {
		const first = buildLlmUsageEvent(message(), { fingerprint: "prefix-a", version: 4 });
		const second = buildLlmUsageEvent(
			message(),
			{ fingerprint: "prefix-a", version: 5 },
			first.stablePrefixHash,
			true,
		);
		const stream = JSON.parse(
			JSON.stringify([
				first,
				second,
				buildCompactionMeasurement({
					triggerTokens: 12_000,
					floorTokens: 8_000,
					mode: "snapcompact",
					tokensFreed: 4_000,
				}),
			]),
		);

		expect(stream[1]).toMatchObject({
			prefixBreakReason: "deliberate-reset",
			stablePrefixHash: prefixIdentityHash({ fingerprint: "prefix-a", version: 5 }),
			providerNative: { totalTokens: 435 },
			normalized: { contextTokens: 415, promptTokens: 410 },
		});
		expect(stream[2]).toEqual({
			type: "compaction_measurement",
			triggerTokens: 12_000,
			floorTokens: 8_000,
			mode: "snapcompact",
			tokensFreed: 4_000,
		});
	});

	it("labels a changed prefix without a reset as an unexpected miss", () => {
		const first = buildLlmUsageEvent(message(), { fingerprint: "prefix-a", version: 1 });
		const second = buildLlmUsageEvent(
			message(),
			{ fingerprint: "prefix-b", version: 1 },
			first.stablePrefixHash,
			false,
		);

		expect(second.prefixBreakReason).toBe("unexpected-miss");
	});
});

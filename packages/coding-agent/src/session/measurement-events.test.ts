import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import {
	buildCompactionMeasurement,
	buildLlmUsageEvent,
	buildPruneMeasurement,
	buildTimingMeasurement,
	prefixIdentityHash,
	replayTimingEnvelope,
} from "./measurement-events";

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

		expect(stream[1]).toMatchObject({
			route: { api: "openai-completions" },
			accountIdentity: { kind: "api-key-or-unresolved" },
			nativeUsageClasses: { orchestration: { input: 20 } },
			observation: { freshness: "live" },
			resetSemantics: "deliberate",
			terminalReceipt: { stopReason: "stop" },
		});
		expect(
			buildPruneMeasurement({
				sessionId: "session-1",
				pass: "stale-result",
				reach: "deeper",
				prunedCount: 3,
				tokensFreed: 900,
			}),
		).toEqual({
			type: "prune_measurement",
			sessionId: "session-1",
			pass: "stale-result",
			reach: "deeper",
			prunedCount: 3,
			tokensFreed: 900,
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
	it("proves paired timing states cover the session envelope", () => {
		const events = [
			buildTimingMeasurement({
				scope: "session",
				phase: "start",
				timingId: "envelope",
				state: "session_envelope",
				envelopeId: "envelope",
				timestampMs: 0,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "start",
				timingId: "human",
				state: "human_turn",
				envelopeId: "envelope",
				timestampMs: 0,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "end",
				timingId: "human",
				state: "human_turn",
				envelopeId: "envelope",
				timestampMs: 100,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "start",
				timingId: "queue",
				state: "provider_queue",
				envelopeId: "envelope",
				timestampMs: 100,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "end",
				timingId: "queue",
				state: "provider_queue",
				envelopeId: "envelope",
				timestampMs: 250,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "start",
				timingId: "generation",
				state: "model_generation",
				envelopeId: "envelope",
				timestampMs: 250,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "end",
				timingId: "generation",
				state: "model_generation",
				envelopeId: "envelope",
				timestampMs: 750,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "start",
				timingId: "process",
				state: "process_state",
				envelopeId: "envelope",
				timestampMs: 750,
			}),
			buildTimingMeasurement({
				scope: "phase",
				phase: "end",
				timingId: "process",
				state: "process_state",
				envelopeId: "envelope",
				timestampMs: 1000,
			}),
			buildTimingMeasurement({
				scope: "session",
				phase: "end",
				timingId: "envelope",
				state: "session_envelope",
				envelopeId: "envelope",
				timestampMs: 1000,
			}),
		];
		const replay = replayTimingEnvelope(JSON.parse(JSON.stringify(events)));

		expect(replay).toEqual({
			envelopeMs: 1000,
			stateDurationsMs: {
				human_turn: 100,
				provider_queue: 150,
				model_generation: 500,
				process_state: 250,
			},
			residualMs: 0,
		});
	});
});

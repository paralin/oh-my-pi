import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { AutoCompactionAction } from "../extensibility/shared-events";

function contextTokens(usage: Usage): number {
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

function promptTokens(usage: Usage): number {
	const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
	return prompt > 0 ? prompt : contextTokens(usage);
}

export interface PrefixIdentity {
	fingerprint: string;
	version: number;
}

export type PrefixBreakReason = "deliberate-reset" | "unexpected-miss";

export interface TokenScale {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

export interface LlmUsageEvent {
	type: "llm_usage";
	provider: string;
	model: string;
	providerNative: TokenScale;
	normalized: {
		contextTokens: number;
		promptTokens: number;
	};
	stablePrefixHash: string;
	prefixBreakReason?: PrefixBreakReason;
}

export interface CompactionMeasurementEvent {
	type: "compaction_measurement";
	triggerTokens?: number;
	floorTokens: number;
	mode: AutoCompactionAction;
	tokensFreed: number;
}

export function prefixIdentityHash(identity: PrefixIdentity): string {
	return `${identity.fingerprint}:${identity.version}`;
}

function providerNativeUsage(usage: Usage): TokenScale {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		totalTokens: usage.totalTokens,
	};
}

export function buildLlmUsageEvent(
	message: AssistantMessage,
	identity: PrefixIdentity,
	previousPrefixHash?: string,
	deliberateReset = false,
): LlmUsageEvent {
	const stablePrefixHash = prefixIdentityHash(identity);
	const event: LlmUsageEvent = {
		type: "llm_usage",
		provider: message.provider,
		model: message.model,
		providerNative: providerNativeUsage(message.usage),
		normalized: {
			contextTokens: contextTokens(message.usage),
			promptTokens: promptTokens(message.usage),
		},
		stablePrefixHash,
	};
	if (previousPrefixHash !== undefined && previousPrefixHash !== stablePrefixHash) {
		event.prefixBreakReason = deliberateReset ? "deliberate-reset" : "unexpected-miss";
	}
	return event;
}

export function buildCompactionMeasurement(
	input: Omit<CompactionMeasurementEvent, "type">,
): CompactionMeasurementEvent {
	return { type: "compaction_measurement", ...input };
}

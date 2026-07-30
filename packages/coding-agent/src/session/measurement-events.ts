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

export interface LlmUsageEventOptions {
	sessionId?: string;
	requestId?: string;
	route?: { requested: string; effective: string; api: string };
	accountIdentity?: {
		kind: "oauth" | "api-key-or-unresolved";
		accountId?: string;
		email?: string;
		projectId?: string;
	};
	window?: { id: string; contextWindow?: number | null };
	observedAtMs?: number;
	observationFreshness?: "live" | "delayed" | "replayed";
	inFlight?: { streaming: boolean; promptCount: number; pendingToolCalls: number };
	terminalReceipt?: {
		stopReason: AssistantMessage["stopReason"];
		responseId?: string;
		receivedAtMs: number;
	};
}

export interface LlmUsageEvent {
	type: "llm_usage";
	sessionId?: string;
	requestId: string;
	provider: string;
	model: string;
	route: { requested: string; effective: string; api: string };
	accountIdentity: NonNullable<LlmUsageEventOptions["accountIdentity"]>;
	window: { id: string; contextWindow?: number | null };
	providerNative: TokenScale;
	nativeUsageClasses: {
		orchestration?: Usage["orchestration"];
		reasoningTokens?: number;
		premiumRequests?: number;
		cacheWriteTtl?: Usage["cttl"];
		serverTools?: Usage["server"];
	};
	normalized: {
		contextTokens: number;
		promptTokens: number;
	};
	stablePrefixHash: string;
	prefixBreakReason?: PrefixBreakReason;
	resetSemantics: "none" | "deliberate" | "unexpected";
	observation: {
		observedAtMs: number;
		freshness: "live" | "delayed" | "replayed";
		source: "provider-final";
	};
	inFlight: { streaming: boolean; promptCount: number; pendingToolCalls: number };
	terminalReceipt: {
		stopReason: AssistantMessage["stopReason"];
		responseId?: string;
		receivedAtMs: number;
	};
}

export interface CompactionMeasurementEvent {
	type: "compaction_measurement";
	triggerTokens?: number;
	floorTokens: number;
	mode: AutoCompactionAction;
	tokensFreed: number;
}

export type TimingState = "model_generation" | "provider_queue" | "human_turn" | "process_state";
export type TimingBoundary = "start" | "end";

export interface TimingMeasurementEvent {
	type: "timing";
	scope: "session" | "phase";
	phase: TimingBoundary;
	timingId: string;
	state: TimingState | "session_envelope";
	sessionId?: string;
	envelopeId: string;
	timestampMs: number;
	durationMs?: number;
	processState?: "active" | "idle";
}

export interface PruneMeasurementEvent {
	type: "prune_measurement";
	sessionId?: string;
	pass: "stale-result" | "tool-output";
	reach: "tail-local" | "deeper";
	prunedCount: number;
	tokensFreed: number;
}

export type MeasurementEvent =
	| LlmUsageEvent
	| CompactionMeasurementEvent
	| TimingMeasurementEvent
	| PruneMeasurementEvent;

export interface TimingEnvelopeReplay {
	envelopeMs: number;
	stateDurationsMs: Record<TimingState, number>;
	residualMs: number;
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

function nativeUsageClasses(usage: Usage): LlmUsageEvent["nativeUsageClasses"] {
	return {
		orchestration: usage.orchestration,
		reasoningTokens: usage.reasoningTokens,
		premiumRequests: usage.premiumRequests,
		cacheWriteTtl: usage.cttl,
		serverTools: usage.server,
	};
}

export function buildLlmUsageEvent(
	message: AssistantMessage,
	identity: PrefixIdentity,
	previousPrefixHash?: string,
	deliberateReset = false,
	options: LlmUsageEventOptions = {},
): LlmUsageEvent {
	const stablePrefixHash = prefixIdentityHash(identity);
	const prefixBreakReason =
		previousPrefixHash !== undefined && previousPrefixHash !== stablePrefixHash
			? deliberateReset
				? "deliberate-reset"
				: "unexpected-miss"
			: undefined;
	const observedAtMs = options.observedAtMs ?? message.timestamp;
	return {
		type: "llm_usage",
		sessionId: options.sessionId,
		requestId: options.requestId ?? message.responseId ?? "unknown",
		provider: message.provider,
		model: message.model,
		route: options.route ?? {
			requested: `${message.provider}/${message.model}`,
			effective: `${message.provider}/${message.model}`,
			api: message.api,
		},
		accountIdentity: options.accountIdentity ?? { kind: "api-key-or-unresolved" },
		window: options.window ?? { id: "unknown" },
		providerNative: providerNativeUsage(message.usage),
		nativeUsageClasses: nativeUsageClasses(message.usage),
		normalized: {
			contextTokens: contextTokens(message.usage),
			promptTokens: promptTokens(message.usage),
		},
		stablePrefixHash,
		...(prefixBreakReason ? { prefixBreakReason } : {}),
		resetSemantics:
			prefixBreakReason === undefined
				? "none"
				: prefixBreakReason === "deliberate-reset"
					? "deliberate"
					: "unexpected",
		observation: {
			observedAtMs,
			freshness: options.observationFreshness ?? "live",
			source: "provider-final",
		},
		inFlight: options.inFlight ?? { streaming: false, promptCount: 0, pendingToolCalls: 0 },
		terminalReceipt: options.terminalReceipt ?? {
			stopReason: message.stopReason,
			...(message.responseId ? { responseId: message.responseId } : {}),
			receivedAtMs: observedAtMs,
		},
	};
}

export function buildCompactionMeasurement(
	input: Omit<CompactionMeasurementEvent, "type">,
): CompactionMeasurementEvent {
	return { type: "compaction_measurement", ...input };
}

export function buildTimingMeasurement(input: Omit<TimingMeasurementEvent, "type">): TimingMeasurementEvent {
	return { type: "timing", ...input };
}

export function buildPruneMeasurement(input: Omit<PruneMeasurementEvent, "type">): PruneMeasurementEvent {
	return { type: "prune_measurement", ...input };
}

export function replayTimingEnvelope(events: readonly TimingMeasurementEvent[]): TimingEnvelopeReplay {
	const starts = new Map<string, TimingMeasurementEvent>();
	const stateDurationsMs: Record<TimingState, number> = {
		model_generation: 0,
		provider_queue: 0,
		human_turn: 0,
		process_state: 0,
	};
	let envelopeMs = 0;
	for (const event of events) {
		if (event.phase === "start") {
			starts.set(event.timingId, event);
			continue;
		}
		const start = starts.get(event.timingId);
		if (!start) continue;
		const durationMs = Math.max(0, event.durationMs ?? event.timestampMs - start.timestampMs);
		if (event.state === "session_envelope") {
			envelopeMs += durationMs;
		} else {
			stateDurationsMs[event.state] += durationMs;
		}
		starts.delete(event.timingId);
	}
	const attributedMs = Object.values(stateDurationsMs).reduce((sum, durationMs) => sum + durationMs, 0);
	return { envelopeMs, stateDurationsMs, residualMs: envelopeMs - attributedMs };
}

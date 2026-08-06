import { countTokens } from "@oh-my-pi/pi-agent-core";

export interface PromptPayloadSize {
	readonly bytes: number;
	readonly tokens: number;
}

/** Measure UTF-8 payload text without imposing a size acceptance threshold. */
export function measurePromptText(parts: readonly string[]): PromptPayloadSize {
	let bytes = 0;
	let tokens = 0;
	for (const part of parts) {
		bytes += Buffer.byteLength(part, "utf8");
		tokens += countTokens(part);
	}
	return { bytes, tokens };
}

/** Measure the deterministic JSON representation used by a provider boundary. */
export function measurePromptJson(value: unknown): PromptPayloadSize {
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("Prompt payload is not JSON serializable");
	return measurePromptText([text]);
}

/** Attribute the signed payload growth between two independently measured fixtures. */
export function promptPayloadDelta(after: PromptPayloadSize, before: PromptPayloadSize): PromptPayloadSize {
	return { bytes: after.bytes - before.bytes, tokens: after.tokens - before.tokens };
}

import { describe, expect, test } from "bun:test";
import {
	measurePromptJson,
	measurePromptText,
	promptPayloadDelta,
} from "@oh-my-pi/pi-coding-agent/ipython/prompt-measurement";
import recordedBaseline from "./fixtures/ipython-provider-request.json" with { type: "json" };
import { captureIpythonProviderRequest } from "./prompt-baseline-fixture";

const PROVIDER_TOOL_NAMES = ["ipython"];

describe("provider prompt measurement", () => {
	test("measures UTF-8 text, JSON framing, and signed fixture deltas", () => {
		const before = measurePromptText(["one"]);
		const after = measurePromptText(["one", "😀"]);
		expect(after.bytes - before.bytes).toBe(4);
		expect(promptPayloadDelta(after, before)).toEqual({ bytes: 4, tokens: after.tokens - before.tokens });
		expect(measurePromptJson({ value: "one" }).bytes).toBe(Buffer.byteLength('{"value":"one"}', "utf8"));
	});

	test("captures the exclusive one-tool request and ordered prompt blocks", async () => {
		const current = await captureIpythonProviderRequest();

		expect(current.provider).toBe("anthropic-messages");
		expect(current.systemPromptParts).toBe(3);
		expect(current.toolNames).toEqual(PROVIDER_TOOL_NAMES);
		expect(current.toolConcurrency).toBe("exclusive");
		expect(current.toolSchema).toEqual({
			type: "object",
			properties: { code: { type: "string" } },
			required: ["code"],
			additionalProperties: false,
		});
		expect(current.runtimeInstructionIndex).toBe(0);
		expect(current.projectContextIndex).toBeGreaterThan(current.runtimeInstructionIndex);
		expect(current.volatileNoticeIndex).toBeGreaterThan(current.projectContextIndex);
		for (const measurement of Object.values(current.categories)) {
			expect(measurement.bytes).toBeGreaterThan(0);
			expect(measurement.tokens).toBeGreaterThan(0);
		}
		expect(current.totalFirstRequest.bytes).toBeGreaterThan(current.categories.toolSchemas.bytes);
		expect(current.bodySha256).toMatch(/^[a-f0-9]{64}$/);

		// The checked-in request is authoritative comparison evidence, not a size limit.
		expect(current).toEqual(recordedBaseline as unknown as typeof current);
	});
});

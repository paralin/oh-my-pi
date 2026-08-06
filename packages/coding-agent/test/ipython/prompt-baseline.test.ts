import { describe, expect, test } from "bun:test";
import {
	measurePromptJson,
	measurePromptText,
	promptPayloadDelta,
} from "@oh-my-pi/pi-coding-agent/ipython/prompt-measurement";
import recordedBaseline from "./fixtures/pre-ipython-provider-baseline.json" with { type: "json" };
import { capturePreIpythonPromptBaseline } from "./prompt-baseline-fixture";

const PRE_IPYTHON_TOOL_NAMES = ["read", "bash", "edit", "eval", "glob", "grep", "task", "todo", "web_search", "write"];

describe("provider prompt measurement", () => {
	test("measures UTF-8 text, JSON framing, and signed fixture deltas", () => {
		const before = measurePromptText(["one"]);
		const after = measurePromptText(["one", "😀"]);
		expect(after.bytes - before.bytes).toBe(4);
		expect(promptPayloadDelta(after, before)).toEqual({ bytes: 4, tokens: after.tokens - before.tokens });
		expect(measurePromptJson({ value: "one" }).bytes).toBe(Buffer.byteLength('{"value":"one"}', "utf8"));
	});

	test("captures a hermetic pre-cutover first request without making size a CI threshold", async () => {
		const current = await capturePreIpythonPromptBaseline();

		expect(current.provider).toBe("anthropic-messages");
		expect(current.systemPromptParts).toBeGreaterThan(1);
		expect(current.toolNames).toEqual(PRE_IPYTHON_TOOL_NAMES);
		for (const measurement of Object.values(current.categories)) {
			expect(measurement.bytes).toBeGreaterThan(0);
			expect(measurement.tokens).toBeGreaterThan(0);
		}
		expect(current.totalFirstRequest.bytes).toBeGreaterThan(current.categories.toolSchemas.bytes);
		expect(current.bodySha256).toMatch(/^[a-f0-9]{64}$/);

		// The checked-in values are comparison evidence, not numeric pass/fail limits.
		expect(recordedBaseline.sourceRevision).toBe("6c079d5149b177258e20adb12c00399cda5ce548");
		expect(recordedBaseline.provider).toBe(current.provider);
		expect(recordedBaseline.toolNames).toEqual(PRE_IPYTHON_TOOL_NAMES);
		expect(recordedBaseline.bodySha256).toMatch(/^[a-f0-9]{64}$/);
	});
});

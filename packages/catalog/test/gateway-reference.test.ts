import { describe, expect, test } from "bun:test";
import { getBundledModelReferenceIndex } from "../src/identity/bundled";
import { inheritReferenceThinking, resolveModelReference } from "../src/identity/reference";

describe("Portkey gateway model references", () => {
	test("@modal ids do not fuzzy-match bundled catalog entries", () => {
		const index = getBundledModelReferenceIndex();
		expect(resolveModelReference("@modal/GLM-5-2-FP8", index)).toBeUndefined();
	});

	test("cross-provider references do not inherit wire routing thinking", () => {
		const index = getBundledModelReferenceIndex();
		const devinGlm = resolveModelReference("glm-5-2", index);
		expect(devinGlm?.provider).toBe("devin");
		expect(inheritReferenceThinking(undefined, devinGlm, "gateway")).toBeUndefined();
	});
});

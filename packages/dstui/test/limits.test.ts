import { describe, expect, test } from "bun:test";
import { DEFAULT_LIMITS, resolveLimits } from "../src/limits";

describe("resolveLimits", () => {
	test("returns the default object when no overlay is provided", () => {
		const limits = resolveLimits();
		expect(limits).toBe(DEFAULT_LIMITS);
	});

	test("merges overlay onto defaults without mutating the default", () => {
		const limits = resolveLimits({ maxTimers: 2 });
		expect(limits.maxTimers).toBe(2);
		expect(limits.maxParseDepth).toBe(DEFAULT_LIMITS.maxParseDepth);
		expect(DEFAULT_LIMITS.maxTimers).not.toBe(2);
	});

	test("default cap shapes are reasonable for a hostile module", () => {
		// Sanity check: defaults must not be Infinity / 0 anywhere.
		for (const key in DEFAULT_LIMITS) {
			const value = (DEFAULT_LIMITS as Record<string, number>)[key];
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});

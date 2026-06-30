import { afterEach, describe, expect, test, vi } from "bun:test";
import { DEFAULT_COMPACTION_SETTINGS, resolveThresholdTokens, shouldCompact } from "@oh-my-pi/pi-agent-core/compaction";
import * as logger from "@oh-my-pi/pi-utils/logger";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("resolveThresholdTokens", () => {
	test("clamps fixed thresholds to 50k tokens below the model context window", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const threshold = resolveThresholdTokens(
			272_000,
			{
				...DEFAULT_COMPACTION_SETTINGS,
				thresholdPercent: -1,
				thresholdTokens: 300_000,
			},
			{ warnOnClamp: true },
		);

		expect(threshold).toBe(222_000);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy).toHaveBeenCalledWith("compaction.thresholdTokens exceeds model context headroom; clamping", {
			thresholdTokens: 300_000,
			contextWindow: 272_000,
			maxThresholdTokens: 222_000,
			reserveTokens: 50_000,
		});
	});

	test("warns from compaction decisions that clamp fixed thresholds", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		expect(
			shouldCompact(223_000, 272_000, {
				...DEFAULT_COMPACTION_SETTINGS,
				thresholdPercent: -1,
				thresholdTokens: 300_000,
			}),
		).toBe(true);

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("keeps fixed thresholds below the headroom limit without warning", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const threshold = resolveThresholdTokens(272_000, {
			...DEFAULT_COMPACTION_SETTINGS,
			thresholdPercent: -1,
			thresholdTokens: 200_000,
		});

		expect(threshold).toBe(200_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("preserves small-window thresholds below the legacy one-token reserve", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const threshold = resolveThresholdTokens(8_000, {
			...DEFAULT_COMPACTION_SETTINGS,
			thresholdPercent: -1,
			thresholdTokens: 7_000,
		});

		expect(threshold).toBe(7_000);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});

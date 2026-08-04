import { shouldUseProviderNativeCompaction } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { getEnumValues, type SettingValue } from "../config/settings-schema";

export function resolveCompactionStrategy(enabled: boolean, strategy: unknown): SettingValue<"compaction.strategy"> {
	if (!enabled) return "off";
	const values = getEnumValues("compaction.strategy");
	return typeof strategy === "string" && values?.some(value => value === strategy)
		? (strategy as SettingValue<"compaction.strategy">)
		: "context-full";
}

/** Configured strategies that may select scratch-handoff maintenance. */
export function isScratchCapableStrategy(strategy: unknown): boolean {
	return strategy === "scratch-handoff" || strategy === "native-or-scratch";
}

/**
 * Whether the active model should run scratch-handoff maintenance for this
 * configured strategy (closeout steers, pre-provider stops, mid-turn closeout).
 *
 * `scratch-handoff` always does. `native-or-scratch` does only when provider-native
 * compaction is unavailable for the current model/settings.
 */
export function shouldRunScratchHandoffMaintenance(input: {
	strategy: unknown;
	model?: Model;
	remoteEnabled?: boolean;
	remoteStreamingV2Enabled?: boolean;
}): boolean {
	if (input.strategy === "scratch-handoff") return true;
	if (input.strategy !== "native-or-scratch") return false;
	if (!input.model) return true;
	return !shouldUseProviderNativeCompaction(input.model, {
		remoteEnabled: input.remoteEnabled,
		remoteStreamingV2Enabled: input.remoteStreamingV2Enabled,
	});
}

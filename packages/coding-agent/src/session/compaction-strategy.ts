import { getEnumValues, type SettingValue } from "../config/settings-schema";

export function resolveCompactionStrategy(enabled: boolean, strategy: unknown): SettingValue<"compaction.strategy"> {
	if (!enabled) return "off";
	const values = getEnumValues("compaction.strategy");
	return typeof strategy === "string" && values?.some(value => value === strategy)
		? (strategy as SettingValue<"compaction.strategy">)
		: "context-full";
}

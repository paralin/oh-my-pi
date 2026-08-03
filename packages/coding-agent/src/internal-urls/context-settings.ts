import type { SettingPath } from "../config/settings-schema";
import type { ResolveContext } from "./types";

/** Read a boolean setting from caller-supplied internal URL context. */
export function booleanSettingFromContext(context: ResolveContext | undefined, path: SettingPath): boolean | undefined {
	if (!context?.settings || typeof context.settings !== "object") return undefined;
	try {
		const get = Reflect.get(context.settings, "get");
		if (typeof get !== "function") return undefined;
		const value = Reflect.apply(get, context.settings, [path]);
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

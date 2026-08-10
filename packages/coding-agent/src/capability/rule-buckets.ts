/**
 * Rule bucketing
 *
 * Single funnel that every discovered rule passes through on its way into a
 * session. It applies the user's disable levers, registers TTSR rules with the
 * manager, and splits the rest into the always-apply and rulebook buckets.
 *
 * Bucket precedence (matches docs/rulebook-matching-pipeline.md §5):
 *   1. TTSR — non-empty `condition` that `TtsrManager.addRule` accepts
 *   2. always   — `alwaysApply === true`
 *   3. rulebook — has a `description`
 */
import type { TtsrManager } from "../export/ttsr";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "./rule";

export interface RuleBuckets {
	rulebookRules: Rule[];
	alwaysApplyRules: Rule[];
}

export interface BucketRulesOptions {
	/** Rule names to drop entirely (bundled defaults and user rules alike). */
	disabledRules?: readonly string[];
	/** When false, drop every rule from the bundled `builtin-defaults` provider. */
	builtinRules?: boolean;
}

/**
 * Filter and bucket rules, registering TTSR rules on `ttsrManager` as a side
 * effect. Provider gates run on the already deduplicated capability result, so
 * a higher-priority same-name rule keeps first-wins precedence before either
 * public or Aperture defaults are filtered.
 */
export function bucketRules(
	rules: readonly Rule[],
	ttsrManager: TtsrManager,
	options: BucketRulesOptions = {},
): RuleBuckets {
	const includeBuiltin = options.builtinRules !== false;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}
	const rulebookRules: Rule[] = [];
	const alwaysApplyRules: Rule[] = [];

	for (const rule of rules) {
		if (disabled.has(rule.name)) continue;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) continue;

		const hasTtsrCondition = (rule.condition?.length ?? 0) > 0;
		const isTtsrRule = hasTtsrCondition ? ttsrManager.addRule(rule) : false;
		if (isTtsrRule) continue;
		if (rule.alwaysApply === true) {
			alwaysApplyRules.push(rule);
			continue;
		}
		if (rule.description) {
			rulebookRules.push(rule);
		}
	}

	return { rulebookRules, alwaysApplyRules };
}

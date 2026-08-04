/**
 * The empty embedded registry provides a stable provider id while no Aperture
 * rules are present.
 */
import { registerProvider } from "../capability";
import { APERTURE_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult } from "../capability/types";
import { buildRuleFromMarkdown, createSourceMeta } from "./helpers";

export interface ApertureRuleSource {
	name: string;
	content: string;
}

/** Embedded Aperture rule registry. */
export const APERTURE_RULE_SOURCES: readonly ApertureRuleSource[] = [];

/** Validate the namespace reserved for embedded Aperture rules. */
export function validateApertureRuleSources(sources: readonly ApertureRuleSource[]): void {
	for (const source of sources) {
		if (source.name.trim().length === 0) {
			throw new Error("Aperture rule names must be non-empty");
		}
		if (!source.name.startsWith("aperture-")) {
			throw new Error(`Aperture rule name must start with aperture-: ${source.name}`);
		}
	}
}

validateApertureRuleSources(APERTURE_RULE_SOURCES);

const DISPLAY_NAME = "Aperture Defaults";
const PRIORITY = 2;

async function loadRules(_ctx: LoadContext): Promise<LoadResult<Rule>> {
	validateApertureRuleSources(APERTURE_RULE_SOURCES);
	const items = APERTURE_RULE_SOURCES.map(({ name, content }) => {
		const virtualPath = `${APERTURE_DEFAULTS_PROVIDER_ID}:${name}.md`;
		const source = createSourceMeta(APERTURE_DEFAULTS_PROVIDER_ID, virtualPath, "user");
		return buildRuleFromMarkdown(name, content, virtualPath, source, { ruleName: name });
	});
	return { items };
}

registerProvider<Rule>(ruleCapability.id, {
	id: APERTURE_DEFAULTS_PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Embedded Aperture rules (disabled by default)",
	priority: PRIORITY,
	load: loadRules,
});

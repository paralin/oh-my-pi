import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { APERTURE_DEFAULTS_PROVIDER_ID, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import {
	APERTURE_RULE_SOURCES,
	validateApertureRuleSources,
} from "@oh-my-pi/pi-coding-agent/discovery/aperture-defaults";
import "@oh-my-pi/pi-coding-agent/discovery";

describe("aperture-defaults rule provider", () => {
	it("registers the empty provider at priority 2 and keeps it off by default", async () => {
		const capability = getCapability(ruleCapability.id);
		if (!capability) throw new Error("rules capability missing");
		const provider = capability.providers.find(p => p.id === APERTURE_DEFAULTS_PROVIDER_ID);
		expect(provider).toBeDefined();
		expect(provider?.priority).toBe(2);
		const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
		expect((await provider!.load(ctx)).items).toEqual([]);
		expect(APERTURE_RULE_SOURCES).toHaveLength(0);
	});

	it("rejects company registry names outside the aperture namespace", () => {
		expect(() => validateApertureRuleSources([{ name: "aperture-example", content: "body" }])).not.toThrow();
		expect(() => validateApertureRuleSources([{ name: "public-rule", content: "body" }])).toThrow(/aperture-/);
	});
});

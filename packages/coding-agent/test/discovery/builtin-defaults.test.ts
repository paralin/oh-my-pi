/** Embedded builtin rules remain regex TTSR rules scoped to IPython code. */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
import "@oh-my-pi/pi-coding-agent/discovery";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

async function loadBuiltinRules(): Promise<Rule[]> {
	const capability = getCapability(ruleCapability.id);
	if (!capability) throw new Error("rules capability missing");
	const provider = capability.providers.find(candidate => candidate.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	const context: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	return (await provider.load(context)).items as Rule[];
}

describe("builtin-defaults rule provider", () => {
	it("loads unique regex rules attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(new Set(rules.map(rule => rule.name)).size).toBe(rules.length);
		for (const rule of rules) {
			expect(rule._source.provider, rule.name).toBe(BUILTIN_DEFAULTS_PROVIDER_ID);
			expect(rule.condition?.length, rule.name).toBeGreaterThan(0);
			expect(rule.scope, rule.name).toEqual(["tool:ipython"]);
			expect(rule.interruptMode, rule.name).toBe("never");
		}
	});

	it("matches a bundled rule on an IPython stream", async () => {
		const rule = (await loadBuiltinRules()).find(candidate => candidate.name === "ts-no-any");
		if (!rule) throw new Error("ts-no-any rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		expect(
			manager.checkDelta("const x: any = 1", { source: "tool", toolName: "ipython" }).map(item => item.name),
		).toEqual(["ts-no-any"]);
	});

	it("does not match an IPython-scoped rule on prose", async () => {
		const rule = (await loadBuiltinRules()).find(candidate => candidate.name === "ts-no-any");
		if (!rule) throw new Error("ts-no-any rule missing");
		const manager = new TtsrManager();
		manager.addRule(rule);
		expect(manager.checkDelta("const x: any = 1", { source: "text" })).toEqual([]);
	});
});

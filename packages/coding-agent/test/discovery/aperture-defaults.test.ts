import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { APERTURE_DEFAULTS_PROVIDER_ID, ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { bucketRules } from "@oh-my-pi/pi-coding-agent/capability/rule-buckets";
import { evaluateSemanticRule } from "@oh-my-pi/pi-coding-agent/capability/rule-semantic";
import type { LoadContext, Provider } from "@oh-my-pi/pi-coding-agent/capability/types";
import {
	APERTURE_RULE_SOURCES,
	validateApertureRuleSources,
} from "@oh-my-pi/pi-coding-agent/discovery/aperture-defaults";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import "@oh-my-pi/pi-coding-agent/discovery";

const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };

async function loadApertureRules(): Promise<Rule[]> {
	const capability = getCapability(ruleCapability.id);
	if (!capability) throw new Error("rules capability missing");
	const provider = capability.providers.find(p => p.id === APERTURE_DEFAULTS_PROVIDER_ID) as
		| Provider<Rule>
		| undefined;
	if (!provider) throw new Error("aperture-defaults provider missing");
	const result = await provider.load(ctx);
	return result.items;
}

interface CorpusFixture {
	name: string;
	lang: "go" | "ts";
	path: string;
	positive: string;
	canonicalException: string;
	wrongPath: string;
}

const fixtures: CorpusFixture[] = [
	{
		name: "aperture-go-control-flow",
		lang: "go",
		path: "pkg/file.go",
		positive: "package p\nfunc f(ok bool) error { if !ok { return nil } else { return work() } }",
		canonicalException: "package p\nfunc f(ok bool) error { if !ok { return nil }; return work() }",
		wrongPath: "pkg/file.ts",
	},
	{
		name: "aperture-go-error-shape",
		lang: "go",
		path: "pkg/file.go",
		positive:
			'package p\nfunc f(err error) error { return fmt.Errorf("failed: %v", err) }\n/* fmt.Errorf("comment") */',
		canonicalException:
			'package p\nfunc f(err error) error { return errors.Wrap(err, "failed") }\n/*\nfunc g() error { return fmt.Errorf("comment") }\n*/',
		wrongPath: "pkg/file.ts",
	},
	{
		name: "aperture-go-forbidden-packages",
		lang: "go",
		path: "pkg/file.go",
		positive: 'package p\nimport "log"\nfunc f() { log.Println("value") }\n/* log.Println("comment") */',
		canonicalException: 'package p\nimport "log"\nfunc f() {}\n/*\nlog.Println("comment")\n*/',
		wrongPath: "pkg/file.ts",
	},
	{
		name: "aperture-go-struct-contract",
		lang: "go",
		path: "pkg/file.go",
		positive: "package p\ntype State struct {\n\tmu sync.Mutex\n}\n/* type Fake struct { mu sync.Mutex } */",
		canonicalException:
			"package p\ntype State struct {\n\tmtx sync.Mutex\n}\nfunc f() { var mu sync.Mutex; _ = mu }\n/*\ntype Fake struct {\n\tmu sync.Mutex\n}\n*/",
		wrongPath: "pkg/file.ts",
	},
	{
		name: "aperture-go-tests",
		lang: "go",
		path: "pkg/file_test.go",
		positive:
			'package p\nimport "github.com/stretchr/testify/assert"\nfunc TestThing(t *testing.T) { assert.Equal(t, 1, 2) }\n/* assert.Equal(t, 1, 2) */',
		canonicalException:
			'package p\nimport "github.com/stretchr/testify/assert"\nfunc TestThing(t *testing.T) {}\n/*\nassert.Equal(t, 1, 2)\n*/',
		wrongPath: "pkg/file.go",
	},
	{
		name: "aperture-ts-async-lifecycle",
		lang: "ts",
		path: "src/View.tsx",
		positive: "function View() { useEffect(async () => { await load(); }, []); }",
		canonicalException: "function View() { useEffect(() => { void load(); }, []); }",
		wrongPath: "src/View.go",
	},
	{
		name: "aperture-ts-cn",
		lang: "ts",
		path: "src/View.tsx",
		positive: `const view = <div className={\`base \${active ? "on" : "off"}\`} />;\n/* const ignored = <div className={active ? "on" : "off"} />; */`,
		canonicalException: [
			'const view = <div className="base" />;',
			"/*",
			"const ignored = <div className={`base $" + '{active ? "on" : "off"}`} />;',
			"*/",
		].join("\n"),
		wrongPath: "src/View.go",
	},
	{
		name: "aperture-ts-doctor",
		lang: "ts",
		path: "src/View.tsx",
		positive: "// eslint-disable-next-line no-giant-component\nfunction View() {}",
		canonicalException:
			"// eslint-disable-next-line no-giant-component -- the generated field matrix must remain contiguous\nfunction View() {}",
		wrongPath: "src/View.go",
	},
	{
		name: "aperture-ts-file-contract",
		lang: "ts",
		path: "src/View.tsx",
		positive:
			"import { helper } from './helper';\nexport const View = () => <div>{helper()}</div>;\n/* import { ignored } from './ignored'; */",
		canonicalException:
			"import { type Model } from './model';\nimport { helper } from './helper.js';\nexport const VERSION = () => 1;\nexport function View() { return <div>{helper()}</div>; }\n/*\nimport { ignored } from './ignored';\nexport const Ignored = () => <div />;\n*/",
		wrongPath: "src/View.go",
	},
];

describe("aperture-defaults rule provider", () => {
	it("registers deterministic company sources with the reserved namespace", () => {
		validateApertureRuleSources(APERTURE_RULE_SOURCES);
		expect(APERTURE_RULE_SOURCES.map(source => source.name)).toEqual(
			[...APERTURE_RULE_SOURCES].map(source => source.name).sort(),
		);
		expect(APERTURE_RULE_SOURCES).toHaveLength(fixtures.length);
	});

	it("loads every rule with provider attribution and non-interrupting mode", async () => {
		const rules = await loadApertureRules();
		expect(rules.map(rule => rule.name)).toEqual(fixtures.map(fixture => fixture.name));
		for (const rule of rules) {
			expect(rule._source.provider, rule.name).toBe(APERTURE_DEFAULTS_PROVIDER_ID);
			expect(rule.interruptMode, rule.name).toBe("never");
			expect(rule.semanticCondition?.length, rule.name).toBeGreaterThan(0);
			expect(rule.condition, rule.name).toBeUndefined();
			expect(rule.astCondition, rule.name).toBeUndefined();
		}
	});

	it("keeps the provider off by default and includes it only when gated on", async () => {
		const rules = await loadApertureRules();
		const offManager = new TtsrManager();
		const off = bucketRules(rules, offManager, { apertureRules: false });
		expect(off.rulebookRules).toEqual([]);
		expect(off.alwaysApplyRules).toEqual([]);
		expect(offManager.hasRules()).toBe(false);

		const onManager = new TtsrManager();
		const on = bucketRules(rules, onManager, { apertureRules: true });
		expect(on.rulebookRules).toEqual([]);
		expect(on.alwaysApplyRules).toEqual([]);
		expect(onManager.hasRules()).toBe(true);
	});

	it.each(fixtures)("covers positive, canonical exception, and path scope for $name", async fixture => {
		const rules = await loadApertureRules();
		const rule = rules.find(candidate => candidate.name === fixture.name);
		if (!rule) throw new Error(`missing fixture rule ${fixture.name}`);
		const positive = await evaluateSemanticRule(rule, fixture.positive, fixture.lang);
		expect(
			positive.candidates.some(candidate => candidate.status === "matched"),
			`${fixture.name} positive`,
		).toBe(true);
		const canonical = await evaluateSemanticRule(rule, fixture.canonicalException, fixture.lang);
		expect(
			canonical.candidates.some(candidate => candidate.status === "matched"),
			`${fixture.name} canonical`,
		).toBe(false);

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		expect(manager.getEligibleSemanticRules(fixture.path, "edit").map(candidate => candidate.name)).toEqual([
			fixture.name,
		]);
		expect(manager.getEligibleSemanticRules(fixture.wrongPath, "edit")).toEqual([]);
	});

	it("rejects non-Aperture registry names", () => {
		expect(() => validateApertureRuleSources([{ name: "aperture-example", content: "body" }])).not.toThrow();
		expect(() => validateApertureRuleSources([{ name: "public-rule", content: "body" }])).toThrow(/aperture-/);
	});
});

/**
 * The bundled `builtin-defaults` rule provider ships a curated default rule set
 * embedded into the binary. These tests defend that the whole set loads and
 * parses, and that the provider sits at the lowest priority so any user/project
 * rule of the same name overrides a bundled default (first-wins dedup).
 */
import { describe, expect, it } from "bun:test";
import { getCapability } from "@oh-my-pi/pi-coding-agent/capability";
import {
	BUILTIN_DEFAULTS_PROVIDER_ID,
	compileRuleCondition,
	type Rule,
	ruleCapability,
} from "@oh-my-pi/pi-coding-agent/capability/rule";
import type { LoadContext } from "@oh-my-pi/pi-coding-agent/capability/types";
// Register all discovery providers as a side effect.
import "@oh-my-pi/pi-coding-agent/discovery";
import { evaluateSemanticRule } from "@oh-my-pi/pi-coding-agent/capability/rule-semantic";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";

function ruleProvider() {
	const cap = getCapability(ruleCapability.id);
	if (!cap) throw new Error("rules capability missing");
	const provider = cap.providers.find(p => p.id === BUILTIN_DEFAULTS_PROVIDER_ID);
	if (!provider) throw new Error("builtin-defaults provider missing");
	return { cap, provider };
}

async function loadBuiltinRules(): Promise<Rule[]> {
	const { provider } = ruleProvider();
	const ctx: LoadContext = { cwd: "/tmp", home: "/tmp/home", repoRoot: null };
	const result = await (provider.load as (ctx: LoadContext) => Promise<{ items: Rule[] }>)(ctx);
	return result.items;
}

describe("builtin-defaults rule provider", () => {
	it("loads the bundled default rule set, all attributed to the provider", async () => {
		const rules = await loadBuiltinRules();
		expect(rules.length).toBeGreaterThan(0);
		expect(rules.every(r => r._source.provider === BUILTIN_DEFAULTS_PROVIDER_ID)).toBe(true);
		const names = rules.map(r => r.name);
		// Name-based dedup is first-wins, so a duplicate would be silently shadowed.
		expect(new Set(names).size).toBe(names.length);
	});

	it("parses every bundled rule as a scoped TTSR rule", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			const conditionCount =
				(rule.condition?.length ?? 0) + (rule.astCondition?.length ?? 0) + (rule.semanticCondition?.length ?? 0);
			expect(conditionCount, `${rule.name} conditions`).toBeGreaterThan(0);
			expect(rule.scope?.length, `${rule.name} scope`).toBeGreaterThan(0);
		}
	});

	it("bundles ast-grep conditions for the redundant-clear-guard rule", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-redundant-clear-guard");
		expect(rule?.condition).toBeUndefined();
		expect(rule?.astCondition?.length).toBeGreaterThan(0);
	});

	it("parses YAML list-form conditions from the embedded text", async () => {
		const rules = await loadBuiltinRules();
		const lazylock = rules.find(r => r.name === "rs-lazylock");
		// Frontmatter declares two condition patterns as a YAML sequence.
		expect(lazylock?.condition).toHaveLength(2);
	});

	it("forces every bundled rule to warn without interrupting", async () => {
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			expect(rule.interruptMode, rule.name).toBe("never");
		}
	});

	it("fires the no-test-timers rule on real timers in *.test.ts but not plain *.ts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-test-timers");
		if (!rule) throw new Error("ts-no-test-timers rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of ["await Bun.sleep(10)", "setTimeout(fn, 0)", "setInterval(fn, 5)"]) {
			manager.resetBuffer();
			const matches = manager.checkDelta(snippet, {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/test/foo.test.ts"],
			});
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-test-timers"]);
		}

		// Same content in a non-test file is out of scope.
		manager.resetBuffer();
		expect(
			manager.checkDelta("await Bun.sleep(10)", {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-local-is-record on local function and lambda definitions", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-local-is-record");
		if (!rule) throw new Error("ts-no-local-is-record rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		for (const snippet of [
			'function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object"; }',
			'const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object";',
			'const isRecord = function (value: unknown): value is Record<string, unknown> { return typeof value === "object"; };',
		]) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, {
					source: "tool",
					toolName: "write",
					filePaths: ["packages/x/src/foo.ts"],
				}),
			).toHaveLength(1);
		}

		manager.resetBuffer();
		expect(
			manager.checkDelta('import { isRecord } from "@oh-my-pi/pi-utils";', {
				source: "tool",
				toolName: "write",
				filePaths: ["packages/x/src/foo.ts"],
			}),
		).toEqual([]);
	});

	it("fires ts-no-inline-cast-access on inline cast-and-access but not named-type casts", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-inline-cast-access");
		if (!rule) throw new Error("ts-no-inline-cast-access rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		// AST conditions only run on edit/write streams, with the language inferred from the path.
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		// Inline object-type assertion immediately read — every access form is flagged.
		const violations = [
			"const a = (value as { content: unknown }).content;",
			"const b = (value as { content: unknown })?.content;",
			'const c = (opts as { enabled: boolean })["enabled"];',
			"const d = (value as unknown as { content: unknown }).content;",
		];
		for (const snippet of violations) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(
				matches.map(r => r.name),
				snippet,
			).toEqual(["ts-no-inline-cast-access"]);
		}

		// A cast to a named type, plain member access, and a bare cast (no read) are all left alone.
		const allowed = [
			"const e = (value as Foo).bar;",
			"const f = obj.content;",
			"const g = value as { content: unknown };",
		];
		for (const snippet of allowed) {
			manager.resetBuffer();
			const matches = await manager.checkAstSnapshot(snippet, ctx);
			expect(matches, snippet).toEqual([]);
		}

		// Out of scope: the same violation in a non-TS file never reaches the matcher.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot("const h = (value as { content: unknown }).content;", {
				source: "tool",
				toolName: "edit",
				filePaths: ["src/foo.js"],
			}),
		).toEqual([]);
	});
	it("opens every bundled regex condition that uses a bare line anchor with the multiline inline flag", async () => {
		// Without the (?m) inline flag a bare ^ or $ anchors to the absolute
		// start/end of input, so a rule whose condition is anchored to a line
		// silently stops matching in real files (see #6890). Enforce the pairing
		// at load time so the failure class stays closed.
		const rules = await loadBuiltinRules();
		for (const rule of rules) {
			for (const condition of rule.condition ?? []) {
				const outsideCharClasses = condition.replace(/\[[^\]]*\]/g, "");
				const hasBareAnchor = /(^|[^\\])[\^$]/.test(outsideCharClasses);
				const hasMultilineSemantics = compileRuleCondition(condition).multiline;
				expect(
					hasBareAnchor ? hasMultilineSemantics : true,
					`${rule.name}: a condition with a bare ^ or $ anchor must open with the multiline inline flag`,
				).toBe(true);
			}
		}
	});

	it("fires ts-no-tiny-functions on one-line arrow functions even with a trailing newline", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "ts-no-tiny-functions");
		if (!rule) throw new Error("ts-no-tiny-functions rule missing");

		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["src/foo.ts"] };

		// Real files end with a newline, so the arrow alternative must match
		// before the line terminator, not only at the absolute end of input.
		const hits = [
			"const getName = (u) => u.profile.name;\n",
			"const getName = (u) => u.profile.name;",
			"const a = 1;\nconst getName = (u) => u.profile.name;\nconst b = 2;",
		];
		for (const snippet of hits) {
			manager.resetBuffer();
			expect(
				manager.checkDelta(snippet, ctx).map(m => m.name),
				snippet,
			).toEqual(["ts-no-tiny-functions"]);
		}

		// Multi-statement functions (block bodies) are not tiny wrappers.
		const misses = ["function f(v) { const x = v.a; return x; }", "const f = (v) => { const x = v.a; return x; };"];
		for (const snippet of misses) {
			manager.resetBuffer();
			expect(manager.checkDelta(snippet, ctx), snippet).toEqual([]);
		}
	});

	it("go-new-expr matches value→pointer helpers (named + generic) but not real functions, only on *.go", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-new-expr");
		if (!rule) throw new Error("go-new-expr rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] };

		const hits = [
			"package p\nfunc boolPtr(v bool) *bool { return &v }",
			"package p\nfunc Ptr[T any](v T) *T { return &v }",
		];
		for (const snippet of hits) {
			manager.resetBuffer();
			expect(
				(await manager.checkAstSnapshot(snippet, ctx)).map(m => m.name),
				snippet,
			).toEqual(["go-new-expr"]);
		}

		const misses = [
			"package p\nfunc add(a int, b int) *int { return &a }",
			"package p\nfunc (s *S) Get() *int { return &s.x }",
		];
		for (const snippet of misses) {
			manager.resetBuffer();
			expect(await manager.checkAstSnapshot(snippet, ctx), snippet).toEqual([]);
		}

		// AST conditions never reach a non-go path.
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(hits[0], { source: "tool", toolName: "edit", filePaths: ["pkg/foo.ts"] }),
		).toEqual([]);
	});

	it("go-bench-loop fires on a *testing.B b.N loop but not an ordinary .N counter", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-bench-loop");
		if (!rule) throw new Error("go-bench-loop rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);
		const ctx: TtsrMatchContext = { source: "tool", toolName: "edit", filePaths: ["pkg/foo_test.go"] };

		const bench =
			"package p\nfunc BenchmarkX(b *testing.B) {\n\tsetup()\n\tfor i := 0; i < b.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect((await manager.checkAstSnapshot(bench, ctx)).map(m => m.name)).toEqual(["go-bench-loop"]);

		// A `.N` selector on something that is not the benchmark receiver must not fire.
		const helper =
			"package p\nfunc TestThing(t *testing.T) {\n\treq := build()\n\tfor i := 0; i < req.N; i++ {\n\t\twork()\n\t}\n}";
		manager.resetBuffer();
		expect(await manager.checkAstSnapshot(helper, ctx)).toEqual([]);
	});

	it("go-range-int fires only on *.go, never on a same-named non-go path", async () => {
		const rules = await loadBuiltinRules();
		const rule = rules.find(r => r.name === "go-range-int");
		if (!rule) throw new Error("go-range-int rule missing");
		const manager = new TtsrManager();
		expect(manager.addRule(rule)).toBe(true);

		const loop = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i++ {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			(await manager.checkAstSnapshot(loop, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] })).map(
				m => m.name,
			),
		).toEqual(["go-range-int"]);
		// A step-2 loop is not equivalent to range-over-int and must not fire.
		const step2 = "package p\nfunc f(n int) {\n\tfor i := 0; i < n; i += 2 {\n\t\tuse(i)\n\t}\n}";
		manager.resetBuffer();
		expect(
			await manager.checkAstSnapshot(step2, { source: "tool", toolName: "edit", filePaths: ["pkg/foo.go"] }),
		).toEqual([]);
	});

	it("normalizes and exercises semantic public corpus rules without interrupting", async () => {
		const rules = await loadBuiltinRules();
		const cases = [
			{
				name: "ts-no-tiny-functions",
				lang: "ts",
				path: "src/helper.ts",
				positive: [
					"function local(value: string) { return value.trim(); }",
					"const localArrow = (value: string) => value.trim();",
					"const localBlock = (value: string) => { return value.trim(); }",
					"const bareArrow = value => value.trim();",
				],
				exception:
					"// Code generated by a tool; DO NOT EDIT.\nexport function Stable(value: string) { return value.trim(); }",
				wrongPath: "src/helper.go",
				clauses: 5,
				max: 2,
			},
			{
				name: "go-no-tiny-functions",
				lang: "go",
				path: "pkg/helper.go",
				positive: ["package p\nfunc local(value string) string { return strings.TrimSpace(value) }"],
				exception: "package p\nfunc NewValue(value string) string { return value }",
				wrongPath: "pkg/helper.ts",
				clauses: 1,
				max: 1,
			},
			{
				name: "go-slices-clone",
				lang: "go",
				path: "pkg/copy.go",
				positive: ["package p\nfunc copyValues(s []string) []string { return append([]string(nil), s...) }"],
				exception: "package p\nfunc reuse(dst, src []string) []string { return append(dst[:0], src...) }",
				wrongPath: "pkg/copy.ts",
				clauses: 1,
			},
			{
				name: "go-message-clone",
				lang: "go",
				path: "pkg/message.go",
				positive: [
					"package p\nfunc cloneMessage(value *Message) *Message {\n\tif value == nil { return nil }\n\treturn value.CloneVT()\n}\n/* func cloneMessage(value *Message) *Message { if value == nil { return nil }; return value.CloneVT() } */",
				],
				exception:
					"package p\nfunc cloneMessage(value *Message) *Message {\n\tif value == nil { return nil }\n\tvalue.Kind = 0\n\treturn value.CloneVT()\n}",
				wrongPath: "pkg/message.ts",
				clauses: 1,
			},
			{
				name: "go-message-equal",
				lang: "go",
				path: "pkg/message.go",
				positive: [
					"package p\nfunc messagesEqual(left, right *Message) bool {\n\treturn left.EqualVT(right)\n}\n/* func messagesEqual(left, right *Message) bool { return left.EqualVT(right) } */",
				],
				exception: "package p\nfunc messagesEqual(left, right *Message) bool {\n\treturn left.ID == right.ID\n}",
				wrongPath: "pkg/message.ts",
				clauses: 1,
			},
			{
				name: "go-sort-compact",
				lang: "go",
				path: "pkg/keys.go",
				positive: [
					'package p\nfunc uniqueSortedKeys(keys []string) []string { sort.Strings(keys); out := keys[:0]; var prev string; for _, key := range keys { if key == "" || key == prev { continue }; out = append(out, key); prev = key }; return out }',
				],
				exception:
					"package p\nfunc stableUnique(keys []string) []string { seen := map[string]bool{}; out := keys[:0]; for _, key := range keys { if !seen[key] { seen[key] = true; out = append(out, key) } }; return out }",
				wrongPath: "pkg/keys.ts",
				clauses: 1,
			},
		] as const;

		for (const fixture of cases) {
			const rule = rules.find(candidate => candidate.name === fixture.name);
			if (!rule) throw new Error(`${fixture.name} rule missing`);
			expect(rule.interruptMode, fixture.name).toBe("never");
			expect(rule.semanticCondition, fixture.name).toHaveLength(fixture.clauses);
			if ("max" in fixture) {
				for (const clause of rule.semanticCondition ?? []) {
					expect(clause.references).toMatchObject({ capture: "NAME", min: 1, max: fixture.max });
				}
			}

			const manager = new TtsrManager();
			expect(manager.addRule(rule)).toBe(true);
			expect(
				manager.checkDelta(fixture.positive[0] ?? "", {
					source: "tool",
					toolName: "edit",
					filePaths: [fixture.path],
				}),
			).toEqual([]);
			expect(manager.getEligibleSemanticRules(fixture.path, "edit").map(candidate => candidate.name)).toEqual([
				fixture.name,
			]);
			expect(manager.getEligibleSemanticRules(fixture.wrongPath, "edit")).toEqual([]);

			for (const source of fixture.positive) {
				const positive = await evaluateSemanticRule(rule, source, fixture.lang);
				expect(
					positive.candidates.some(candidate => candidate.status === "matched"),
					fixture.name,
				).toBe(true);
			}
			const exception = await evaluateSemanticRule(rule, fixture.exception, fixture.lang);
			expect(
				exception.candidates.every(candidate => candidate.status !== "matched"),
				fixture.name,
			).toBe(true);
		}
	});
	it("ignores source-shaped block comments in code regex semantic rules", async () => {
		const rules = await loadBuiltinRules();
		const cases = [
			{
				name: "go-message-clone",
				source:
					"package p\n/*\nfunc cloneMessage(value *Message) *Message {\n\tif value == nil { return nil }\n\treturn value.CloneVT()\n}\n*/",
			},
			{
				name: "go-message-equal",
				source:
					"package p\n/*\nfunc messagesEqual(left, right *Message) bool {\n\treturn left.EqualVT(right)\n}\n*/",
			},
		];
		for (const fixture of cases) {
			const rule = rules.find(candidate => candidate.name === fixture.name);
			if (!rule) throw new Error(`${fixture.name} rule missing`);
			const report = await evaluateSemanticRule(rule, fixture.source, "go");
			expect(
				report.candidates.some(candidate => candidate.status === "matched"),
				fixture.name,
			).toBe(false);
		}
	});
	it("is the lowest-priority rule provider so user/project rules override defaults", () => {
		const { cap, provider } = ruleProvider();
		const others = cap.providers.filter(p => p.id !== BUILTIN_DEFAULTS_PROVIDER_ID);
		expect(others.length).toBeGreaterThan(0);
		expect(others.every(p => p.priority > provider.priority)).toBe(true);
	});
});

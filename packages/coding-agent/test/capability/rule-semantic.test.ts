import { afterEach, describe, expect, it } from "bun:test";
import { resetActiveRulesForTests, setActiveRules } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { evaluateSemanticRule } from "@oh-my-pi/pi-coding-agent/capability/rule-semantic";
import { buildRuleFromMarkdown, createSourceMeta } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { RuleProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/rule-protocol";

function loadRule(frontmatter: string, name = "semantic-fixture") {
	const path = `${name}.md`;
	return buildRuleFromMarkdown(
		path,
		`---\n${frontmatter}\n---\nUse the direct expression.`,
		path,
		createSourceMeta("test", path, "project"),
		{ ruleName: name },
	);
}

afterEach(() => {
	resetActiveRulesForTests();
});

describe("semantic rule conditions", () => {
	it("loads and evaluates a TypeScript AST candidate with its range and captures", async () => {
		const rule = loadRule(`semanticCondition:\n  candidate:\n    ast: 'function $NAME($$$ARGS) { return $VALUE; }'`);
		const source = "const prefix = 1;\nfunction isEmpty(value) { return value.length === 0; }\n";

		expect(rule.semanticCondition).toEqual([{ candidate: { ast: "function $NAME($$$ARGS) { return $VALUE; }" } }]);
		const report = await evaluateSemanticRule(rule, source, "ts");

		expect(report.ruleName).toBe("semantic-fixture");
		expect(report.candidates).toHaveLength(1);
		expect(report.candidates[0]).toMatchObject({
			clause: 1,
			status: "matched",
			reason: "local predicates matched",
			range: {
				byteStart: 18,
				byteEnd: 72,
				startLine: 2,
				startColumn: 1,
				endLine: 2,
				endColumn: 55,
			},
			captures: { NAME: "isEmpty" },
		});
	});

	it("composes alternative clauses and conjunctive capture and file predicates", async () => {
		const rule = loadRule(`semanticCondition:
  - candidate:
      ast: 'function $NAME($$$ARGS) { return $VALUE; }'
    captures:
      NAME:
        regex: '^[a-z]'
        notRegex: '^keep'
    file:
      required:
        ast: 'const $ID = $VALUE'
        regex: 'const sentinel'
      forbidden:
        ast: 'debugger'
        regex: '@generated'
  - candidate:
      regex: 'const\\s+(?<NAME>[a-zA-Z_]\\w*)\\s*=\\s*\\([^)]*\\)\\s*=>\\s*[^;]+;'
    captures:
      NAME:
        regex: '^is'`);
		const source = [
			"const sentinel = true;",
			"function isEmpty(value) { return value.length === 0; }",
			"const isReady = (value) => value.ready;",
		].join("\n");

		const report = await evaluateSemanticRule(rule, source, "ts");

		expect(report.candidates).toHaveLength(2);
		expect(report.candidates.map(candidate => [candidate.clause, candidate.status, candidate.captures.NAME])).toEqual(
			[
				[1, "matched", "isEmpty"],
				[2, "matched", "isReady"],
			],
		);
	});

	it("reports candidates rejected by capture and whole-file predicates", async () => {
		const captureRule = loadRule(`semanticCondition:
  candidate:
    ast: 'function $NAME($$$ARGS) { return $VALUE; }'
  captures:
    NAME:
      regex: '^[a-z]'`);
		const captureReport = await evaluateSemanticRule(
			captureRule,
			"function Exported(value) { return value.ready; }",
			"ts",
		);
		expect(captureReport.candidates[0]).toMatchObject({
			status: "rejected",
			reason: "capture NAME regex 1 did not match",
			captures: { NAME: "Exported" },
		});

		const fileRule = loadRule(`semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)'
  file:
    required:
      regex: 'const sentinel'
    forbidden:
      regex: '@generated'`);
		const fileReport = await evaluateSemanticRule(fileRule, "// @generated\nfunction local() {}", "ts");
		expect(fileReport.candidates[0]).toMatchObject({
			status: "rejected",
			reason: "required file regex 1 did not match",
			captures: { NAME: "local" },
		});

		const forbiddenRegexReport = await evaluateSemanticRule(
			fileRule,
			"const sentinel = true;\n// @generated\nfunction local() {}",
			"ts",
		);
		expect(forbiddenRegexReport.candidates[0]).toMatchObject({
			status: "rejected",
			reason: "forbidden file regex 1 matched",
		});

		const requiredAstRule = loadRule(`semanticCondition:
  candidate:
    regex: 'function'
  file:
    required:
      ast: 'const sentinel = true'`);
		const requiredAstReport = await evaluateSemanticRule(requiredAstRule, "function local() {}", "ts");
		expect(requiredAstReport.candidates[0]).toMatchObject({
			status: "rejected",
			reason: "required file AST 1 did not match",
		});

		const forbiddenAstRule = loadRule(`semanticCondition:
  candidate:
    regex: 'function'
  file:
    forbidden:
      ast: 'debugger'`);
		const forbiddenAstReport = await evaluateSemanticRule(forbiddenAstRule, "function local() {}\ndebugger;", "ts");
		expect(forbiddenAstReport.candidates[0]).toMatchObject({
			status: "rejected",
			reason: "forbidden file AST 1 matched",
		});
	});

	it("rejects ambiguous and malformed clauses with the rule, clause, and field", () => {
		expect(() =>
			loadRule(
				`semanticCondition:
  candidate:
    ast: 'function $NAME() {}'
    regex: 'function'`,
				"ambiguous-rule",
			),
		).toThrow('Rule "ambiguous-rule" semanticCondition clause 1 field "candidate"');

		expect(() =>
			loadRule(
				`semanticCondition:
  - candidate:
      regex: 'function'
  - candidate:
      regex: 'const'
    unexpected: true`,
				"unknown-field-rule",
			),
		).toThrow('Rule "unknown-field-rule" semanticCondition clause 2 field "clause.unexpected"');

		expect(() =>
			loadRule(
				`semanticCondition:
  candidate:
    regex: '('`,
				"invalid-regex-rule",
			),
		).toThrow('Rule "invalid-regex-rule" semanticCondition clause 1 field "candidate.regex"');
	});

	it("rejects a regex candidate that matches an empty source range", async () => {
		const rule = loadRule(
			`semanticCondition:
  candidate:
    regex: '(?=function)'`,
			"zero-width-rule",
		);

		await expect(evaluateSemanticRule(rule, "function local() {}", "ts")).rejects.toThrow(
			'Rule "zero-width-rule" semanticCondition clause 1 field "candidate.regex": candidate matched an empty source range',
		);
	});
	it("renders normalized semantic conditions through rule://", async () => {
		const rule = loadRule(`semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)'
  captures:
    NAME:
      regex:
        - '^[a-z]'
        - 'Name$'`);
		setActiveRules([rule]);

		const resource = await new RuleProtocolHandler().resolve(
			Object.assign(new URL("rule://semantic-fixture"), { rawHost: "semantic-fixture" }),
		);

		const fenceStart = resource.content.indexOf("```json\n") + "```json\n".length;
		const fenceEnd = resource.content.indexOf("\n```", fenceStart);
		expect(resource.content).toContain("## Semantic conditions");
		expect(JSON.parse(resource.content.slice(fenceStart, fenceEnd))).toEqual(rule.semanticCondition);
		expect(resource.content).toContain("Use the direct expression.");
		expect(resource.notes).toEqual(["provider: test", "providerName: test", "enabled: true"]);
	});
});

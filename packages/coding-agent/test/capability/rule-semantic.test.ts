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
			captureRanges: {
				NAME: { startLine: 2, startColumn: 10, endLine: 2, endColumn: 17 },
			},
		});
	});

	it("preserves distinct AST capture positions when source text repeats", async () => {
		const rule = loadRule(`semanticCondition:
  candidate:
    ast: 'function $NAME($ARG) { return $ARG; }'
  references:
    capture: NAME
    max: 1`);
		const report = await evaluateSemanticRule(rule, "function helper(helper) { return helper; }", "ts");
		expect(report.candidates[0]?.captureRanges).toMatchObject({
			NAME: { byteStart: 9, byteEnd: 15, startLine: 1, startColumn: 10 },
			ARG: { byteStart: 33, byteEnd: 39, startLine: 1, startColumn: 34 },
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
		expect(report.candidates[1]?.captureRanges.NAME).toMatchObject({
			startLine: 3,
			startColumn: 7,
			endLine: 3,
			endColumn: 14,
		});
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

	it("normalizes project-reference bounds for one capture", () => {
		const rule = loadRule(`semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)'
  references:
    capture: NAME
    min: 1
    max: 2`);
		expect(rule.semanticCondition?.[0]?.references).toEqual({ capture: "NAME", min: 1, max: 2 });
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

		expect(() =>
			loadRule(
				`semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)'
  references:
    capture: NAME`,
				"missing-reference-bound",
			),
		).toThrow('Rule "missing-reference-bound" semanticCondition clause 1 field "references"');

		expect(() =>
			loadRule(
				`semanticCondition:
  candidate:
    regex: 'function\\s+(?<NAME>\\w+)'
  references:
    capture: NAME
    min: 2
    max: 1`,
				"inverted-reference-bound",
			),
		).toThrow('"min" must not exceed "max"');

		expect(() =>
			loadRule(
				`semanticCondition:
  candidate:
    regex: 'function'
  references:
    capture: NAME
    max: 1`,
				"uncaptured-reference",
			),
		).toThrow('Rule "uncaptured-reference" semanticCondition clause 1 field "references.capture"');
	});

	it("records candidate evaluation failures per clause without discarding prior evidence", async () => {
		const rule = loadRule(
			`semanticCondition:
  - candidate:
      regex: 'function\\s+(?<NAME>\\w+)'
  - candidate:
      regex: '(?=function)'`,
			"clause-failure-rule",
		);
		const report = await evaluateSemanticRule(rule, "function local() {}", "ts");
		expect(report.candidates).toMatchObject([{ clause: 1, status: "matched", captures: { NAME: "local" } }]);
		expect(report.skipped).toMatchObject([
			{
				clause: 2,
				reason: expect.stringContaining(
					'Rule "clause-failure-rule" semanticCondition clause 2 field "candidate.regex"',
				),
			},
		]);

		const zeroWidth = loadRule(
			`semanticCondition:
  candidate:
    regex: '(?=function)'`,
			"zero-width-rule",
		);
		const zeroWidthReport = await evaluateSemanticRule(zeroWidth, "function local() {}", "ts");
		expect(zeroWidthReport.candidates).toEqual([]);
		expect(zeroWidthReport.skipped[0]).toMatchObject({
			clause: 1,
			reason: expect.stringContaining("candidate matched an empty source range"),
		});
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

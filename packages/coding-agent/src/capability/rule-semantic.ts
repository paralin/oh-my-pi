import type * as BabelParser from "@babel/parser";
import { type AstMatchResult, AstMatchStrictness, astMatch } from "@oh-my-pi/pi-natives";
import {
	compileRuleCondition,
	type Rule,
	type SemanticConditionClause,
	type SemanticFilePredicates,
	type SemanticMatcherSet,
} from "./rule";

const AST_MATCH_PAGE_SIZE = 100;

export interface SemanticSourceRange {
	byteStart: number;
	byteEnd: number;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface SemanticCandidateReport {
	clause: number;
	status: "matched" | "rejected" | "skipped";
	reason: string;
	range: SemanticSourceRange;
	captures: Record<string, string>;
	captureRanges: Record<string, SemanticSourceRange>;
	referenceEvidence?: SemanticReferenceEvidence;
}

export interface SemanticReferenceEvidence {
	capture: string;
	count: number;
	serverName: string;
}

export interface SemanticClauseSkipReport {
	clause: number;
	reason: string;
}

export interface SemanticEvaluationReport {
	ruleName: string;
	candidates: SemanticCandidateReport[];
	skipped: SemanticClauseSkipReport[];
}

interface LocalCandidate {
	range: SemanticSourceRange;
	captures: Record<string, string>;
	captureRanges: Record<string, SemanticSourceRange>;
}

interface LocalPredicateResult {
	matched: boolean;
	reason: string;
}

function semanticEvaluationError(rule: Rule, clause: number, field: string, message: string): Error {
	return new Error(`Rule "${rule.name}" semanticCondition clause ${clause} field "${field}": ${message}`);
}

async function astPatternMatches(
	rule: Rule,
	clause: number,
	field: string,
	pattern: string,
	source: string,
	lang: string,
	limit: number,
	offset = 0,
	includeMeta = false,
): Promise<AstMatchResult> {
	const result = await astMatch({
		patterns: [pattern],
		source,
		lang,
		strictness: AstMatchStrictness.Smart,
		limit,
		offset,
		includeMeta,
	});
	if (result.parseErrors && result.parseErrors.length > 0) {
		throw semanticEvaluationError(rule, clause, field, result.parseErrors.join("; "));
	}
	return result;
}

async function findAstCandidates(
	rule: Rule,
	clause: number,
	pattern: string,
	source: string,
	lang: string,
): Promise<LocalCandidate[]> {
	const candidates: LocalCandidate[] = [];
	let offset = 0;
	for (;;) {
		const result = await astPatternMatches(
			rule,
			clause,
			"candidate.ast",
			pattern,
			source,
			lang,
			AST_MATCH_PAGE_SIZE,
			offset,
			true,
		);
		for (const match of result.matches) {
			candidates.push({
				range: {
					byteStart: match.byteStart,
					byteEnd: match.byteEnd,
					startLine: match.startLine,
					startColumn: match.startColumn,
					endLine: match.endLine,
					endColumn: match.endColumn,
				},
				captures: match.metaVariables ?? {},
				captureRanges: Object.fromEntries(
					Object.entries(match.metaVariableRanges ?? {}).map(([name, capture]) => [
						name,
						{
							byteStart: capture.byteStart,
							byteEnd: capture.byteEnd,
							startLine: capture.startLine,
							startColumn: capture.startColumn,
							endLine: capture.endLine,
							endColumn: capture.endColumn,
						},
					]),
				),
			});
		}
		if (!result.limitReached || result.matches.length === 0) break;
		offset += result.matches.length;
	}
	return candidates;
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lastLineStart = 0;
	for (let index = source.indexOf("\n"); index >= 0 && index < offset; index = source.indexOf("\n", index + 1)) {
		line++;
		lastLineStart = index + 1;
	}
	return { line, column: offset - lastLineStart + 1 };
}

function regexRange(source: string, start: number, end: number): SemanticSourceRange {
	const startPosition = lineAndColumn(source, start);
	const endPosition = lineAndColumn(source, end);
	return {
		byteStart: Buffer.byteLength(source.slice(0, start), "utf8"),
		byteEnd: Buffer.byteLength(source.slice(0, end), "utf8"),
		startLine: startPosition.line,
		startColumn: startPosition.column,
		endLine: endPosition.line,
		endColumn: endPosition.column,
	};
}

interface SourceSpan {
	start: number;
	end: number;
}

let babelParser: Promise<typeof BabelParser> | undefined;

function loadBabelParser(): Promise<typeof BabelParser> {
	babelParser ??= import("@babel/parser");
	return babelParser;
}

async function excludedCodeRegexSpans(rule: Rule, clause: number, source: string, lang: string): Promise<SourceSpan[]> {
	const normalizedLang = lang.toLowerCase().replace(/^\./, "");
	if (normalizedLang === "go") {
		const spans: SourceSpan[] = [];
		for (let index = 0; index < source.length; ) {
			const start = index;
			const char = source[index];
			const next = source[index + 1];
			if (char === "/" && next === "/") {
				index += 2;
				while (index < source.length && source[index] !== "\n") index++;
				spans.push({ start, end: index });
				continue;
			}
			if (char === "/" && next === "*") {
				index += 2;
				while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
				index = Math.min(source.length, index + 2);
				spans.push({ start, end: index });
				continue;
			}
			if (char !== '"' && char !== "'" && char !== "`") {
				index++;
				continue;
			}

			const quote = char;
			index++;
			while (index < source.length) {
				const current = source[index];
				if (current === quote) {
					index++;
					break;
				}
				if (current === "\\" && quote !== "`") {
					index = Math.min(source.length, index + 2);
					continue;
				}
				if (current === "\n" && quote !== "`") break;
				index++;
			}
			spans.push({ start, end: index });
		}
		return spans;
	}

	if (!["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"].includes(normalizedLang)) {
		throw semanticEvaluationError(rule, clause, "candidate.codeRegex", `unsupported language "${lang}"`);
	}
	try {
		const parser = await loadBabelParser();
		const plugins: BabelParser.ParserPlugin[] = [];
		if (["ts", "tsx", "mts", "cts"].includes(normalizedLang)) plugins.push("typescript");
		if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(normalizedLang)) plugins.push("jsx");
		const parsed = parser.parse(source, {
			sourceType: "unambiguous",
			errorRecovery: true,
			tokens: true,
			plugins,
		});
		const spans: SourceSpan[] = [];
		for (const comment of parsed.comments ?? []) {
			if (comment.start !== undefined && comment.end !== undefined) {
				spans.push({ start: comment.start, end: comment.end });
			}
		}
		for (const token of parsed.tokens ?? []) {
			if (["string", "regexp", "template", "jsxText"].includes(token.type.label)) {
				spans.push({ start: token.start, end: token.end });
			}
		}
		return spans.sort((left, right) => left.start - right.start);
	} catch (error) {
		throw semanticEvaluationError(
			rule,
			clause,
			"candidate.codeRegex",
			`could not tokenize source: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function findRegexCandidates(
	rule: Rule,
	clause: number,
	pattern: string,
	source: string,
	codeOnly = false,
	lang = "",
): Promise<LocalCandidate[]> {
	const compiled = compileRuleCondition(pattern);
	const flags = Array.from(new Set(`${compiled.flags}gd`)).join("");
	const regex = new RegExp(compiled.source, flags);
	const candidates: LocalCandidate[] = [];
	const excludedSpans = codeOnly ? await excludedCodeRegexSpans(rule, clause, source, lang) : [];
	let excludedIndex = 0;
	for (let match = regex.exec(source); match; match = regex.exec(source)) {
		const field = codeOnly ? "candidate.codeRegex" : "candidate.regex";
		if (match[0].length === 0) {
			throw semanticEvaluationError(rule, clause, field, "candidate matched an empty source range");
		}
		const start = match.index;
		const end = start + match[0].length;
		while (excludedIndex < excludedSpans.length && excludedSpans[excludedIndex].end <= start) excludedIndex++;
		const excluded = excludedSpans[excludedIndex];
		if (excluded && excluded.start <= start && start < excluded.end) continue;
		const groups = match.groups ?? {};
		const indices = (
			match as RegExpExecArray & {
				indices?: { groups?: Record<string, [number, number] | undefined> };
			}
		).indices?.groups;
		const captureRanges: Record<string, SemanticSourceRange> = {};
		for (const name of Object.keys(groups)) {
			const range = indices?.[name];
			if (range) captureRanges[name] = regexRange(source, range[0], range[1]);
		}
		candidates.push({
			range: regexRange(source, start, end),
			captures: groups,
			captureRanges,
		});
	}
	return candidates;
}

async function matcherSetFailure(
	rule: Rule,
	clause: number,
	kind: "required" | "forbidden",
	matchers: SemanticMatcherSet | undefined,
	source: string,
	lang: string,
): Promise<LocalPredicateResult | undefined> {
	if (!matchers) return undefined;
	for (const [index, pattern] of (matchers.regex ?? []).entries()) {
		const matched = compileRuleCondition(pattern).test(source);
		if ((kind === "required" && !matched) || (kind === "forbidden" && matched)) {
			return {
				matched: false,
				reason: `${kind} file regex ${index + 1} ${matched ? "matched" : "did not match"}`,
			};
		}
	}
	for (const [index, pattern] of (matchers.ast ?? []).entries()) {
		const result = await astPatternMatches(rule, clause, `file.${kind}.ast[${index}]`, pattern, source, lang, 1);
		const matched = result.totalMatches > 0;
		if ((kind === "required" && !matched) || (kind === "forbidden" && matched)) {
			return {
				matched: false,
				reason: `${kind} file AST ${index + 1} ${matched ? "matched" : "did not match"}`,
			};
		}
	}
	return undefined;
}

async function evaluateFilePredicates(
	rule: Rule,
	clause: number,
	predicates: SemanticFilePredicates | undefined,
	source: string,
	lang: string,
): Promise<LocalPredicateResult> {
	const requiredFailure = await matcherSetFailure(rule, clause, "required", predicates?.required, source, lang);
	if (requiredFailure) return requiredFailure;
	const forbiddenFailure = await matcherSetFailure(rule, clause, "forbidden", predicates?.forbidden, source, lang);
	if (forbiddenFailure) return forbiddenFailure;
	return { matched: true, reason: "local predicates matched" };
}

function evaluateCapturePredicates(clause: SemanticConditionClause, candidate: LocalCandidate): LocalPredicateResult {
	for (const [name, predicate] of Object.entries(clause.captures ?? {})) {
		const value = candidate.captures[name];
		if (value === undefined) return { matched: false, reason: `capture ${name} is missing` };
		for (const [index, pattern] of (predicate.regex ?? []).entries()) {
			if (!compileRuleCondition(pattern).test(value)) {
				return { matched: false, reason: `capture ${name} regex ${index + 1} did not match` };
			}
		}
		for (const [index, pattern] of (predicate.notRegex ?? []).entries()) {
			if (compileRuleCondition(pattern).test(value)) {
				return { matched: false, reason: `capture ${name} forbidden regex ${index + 1} matched` };
			}
		}
	}
	return { matched: true, reason: "local predicates matched" };
}

async function evaluateClause(
	rule: Rule,
	clause: SemanticConditionClause,
	clauseNumber: number,
	source: string,
	lang: string,
	changedRanges?: readonly { startLine: number; endLine: number }[],
): Promise<SemanticCandidateReport[]> {
	const candidates =
		"ast" in clause.candidate
			? await findAstCandidates(rule, clauseNumber, clause.candidate.ast, source, lang)
			: "regex" in clause.candidate
				? await findRegexCandidates(rule, clauseNumber, clause.candidate.regex, source)
				: await findRegexCandidates(rule, clauseNumber, clause.candidate.codeRegex, source, true, lang);
	const changed = changedRanges
		? candidates.filter(candidate =>
				changedRanges.some(
					range => candidate.range.startLine <= range.endLine && range.startLine <= candidate.range.endLine,
				),
			)
		: candidates;
	if (changed.length === 0) return [];
	const fileResult = await evaluateFilePredicates(rule, clauseNumber, clause.file, source, lang);
	return changed.map(candidate => {
		const result = fileResult.matched ? evaluateCapturePredicates(clause, candidate) : fileResult;
		return {
			clause: clauseNumber,
			status: result.matched ? "matched" : "rejected",
			reason: result.reason,
			range: candidate.range,
			captures: candidate.captures,
			captureRanges: candidate.captureRanges,
		};
	});
}

export async function evaluateSemanticRule(
	rule: Rule,
	source: string,
	lang: string,
	changedRanges?: readonly { startLine: number; endLine: number }[],
): Promise<SemanticEvaluationReport> {
	const candidates: SemanticCandidateReport[] = [];
	const skipped: SemanticClauseSkipReport[] = [];
	for (const [index, clause] of (rule.semanticCondition ?? []).entries()) {
		const clauseNumber = index + 1;
		try {
			candidates.push(...(await evaluateClause(rule, clause, clauseNumber, source, lang, changedRanges)));
		} catch (error) {
			skipped.push({
				clause: clauseNumber,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return { ruleName: rule.name, candidates, skipped };
}

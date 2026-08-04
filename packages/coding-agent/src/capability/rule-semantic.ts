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
	status: "matched" | "rejected";
	reason: string;
	range: SemanticSourceRange;
	captures: Record<string, string>;
}

export interface SemanticEvaluationReport {
	ruleName: string;
	candidates: SemanticCandidateReport[];
}

interface LocalCandidate {
	range: SemanticSourceRange;
	captures: Record<string, string>;
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

function findRegexCandidates(rule: Rule, clause: number, pattern: string, source: string): LocalCandidate[] {
	const compiled = compileRuleCondition(pattern);
	const regex = new RegExp(compiled.source, compiled.flags.includes("g") ? compiled.flags : `${compiled.flags}g`);
	const candidates: LocalCandidate[] = [];
	for (let match = regex.exec(source); match; match = regex.exec(source)) {
		if (match[0].length === 0) {
			throw semanticEvaluationError(rule, clause, "candidate.regex", "candidate matched an empty source range");
		}
		const start = match.index;
		const end = start + match[0].length;
		candidates.push({
			range: regexRange(source, start, end),
			captures: match.groups ?? {},
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
			: findRegexCandidates(rule, clauseNumber, clause.candidate.regex, source);
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
	for (const [index, clause] of (rule.semanticCondition ?? []).entries()) {
		candidates.push(...(await evaluateClause(rule, clause, index + 1, source, lang, changedRanges)));
	}
	return { ruleName: rule.name, candidates };
}

/**
 * Rules Capability
 *
 * Project-specific rules from Cursor (.mdc), Windsurf (.md), and Cline formats.
 * Translated to a canonical shape regardless of source format.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

const CONDITION_GLOB_SCOPE_TOOLS = ["edit", "write"] as const;

/**
 * Provider id for the bundled default rules shipped with the agent.
 * Lowest priority, so any user/project/tool rule of the same name overrides
 * a bundled default. Also used to gate the whole bundled set via
 * `ttsr.builtinRules`.
 */
export const BUILTIN_DEFAULTS_PROVIDER_ID = "builtin-defaults";
/**
 * Provider id for the embedded Aperture company rules.
 *
 * The provider is registered even while its embedded registry is empty so
 * settings and provider inspection have a stable target.
 */
export const APERTURE_DEFAULTS_PROVIDER_ID = "aperture-defaults";

export type SemanticCandidateMatcher = { ast: string } | { regex: string };

export interface SemanticCapturePredicate {
	regex?: string[];
	notRegex?: string[];
}

export interface SemanticMatcherSet {
	ast?: string[];
	regex?: string[];
}

export interface SemanticFilePredicates {
	required?: SemanticMatcherSet;
	forbidden?: SemanticMatcherSet;
}

export interface SemanticReferencePredicate {
	capture: string;
	min?: number;
	max?: number;
}

export interface SemanticConditionClause {
	candidate: SemanticCandidateMatcher;
	captures?: Record<string, SemanticCapturePredicate>;
	file?: SemanticFilePredicates;
	references?: SemanticReferencePredicate;
}

/**
 * Parsed frontmatter from rule files.
 */
export interface RuleFrontmatter {
	description?: string;
	globs?: string[];
	alwaysApply?: boolean;
	/** New key for TTSR match conditions. */
	condition?: string | string[];
	/** TTSR match condition(s) expressed as ast-grep patterns (edit/write streams only). */
	astCondition?: string | string[];
	/** Declarative post-edit candidate and local semantic predicates. */
	semanticCondition?: unknown;
	/** New key for TTSR stream scope. */
	scope?: string | string[];
	/** Per-rule TTSR interrupt mode override. */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	[key: string]: unknown;
}

/**
 * A rule providing project-specific guidance and constraints.
 */
export interface Rule {
	/** Rule name (derived from filename) */
	name: string;
	/** Absolute path to rule file */
	path: string;
	/** Rule content (after frontmatter stripped) */
	content: string;
	/** Globs this rule applies to (if any) */
	globs?: string[];
	/** Whether to always include this rule */
	alwaysApply?: boolean;
	/** Description (for agent-requested rules) */
	description?: string;
	/** Regex condition(s) that can trigger TTSR interruption. */
	condition?: string[];
	/** ast-grep pattern condition(s) that can trigger TTSR interruption (edit/write streams only). */
	astCondition?: string[];
	/** Normalized declarative post-edit semantic clauses. */
	semanticCondition?: SemanticConditionClause[];
	/** Optional stream scope tokens (for example: text, thinking, tool:edit(*.ts)). */
	scope?: string[];
	/** Per-rule TTSR interrupt mode override (falls back to global ttsr.interruptMode). */
	interruptMode?: "never" | "prose-only" | "tool-only" | "always";
	/** Source metadata */
	_source: SourceMeta;
}

function normalizeRuleField(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const token = value.trim();
		return token.length > 0 ? [token] : undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	const tokens = value
		.filter((item): item is string => typeof item === "string")
		.map(item => item.trim())
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}

	return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (quote) {
			current += char;
			if (char === quote && value[i - 1] !== "\\") {
				quote = undefined;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "(") {
			parenDepth++;
			current += char;
			continue;
		}
		if (char === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
			current += char;
			continue;
		}
		if (char === "[") {
			bracketDepth++;
			current += char;
			continue;
		}
		if (char === "]") {
			bracketDepth = Math.max(0, bracketDepth - 1);
			current += char;
			continue;
		}
		if (char === "{") {
			braceDepth++;
			current += char;
			continue;
		}
		if (char === "}") {
			braceDepth = Math.max(0, braceDepth - 1);
			current += char;
			continue;
		}
		if (char === "," && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			const token = current.trim();
			if (token.length > 0) {
				tokens.push(token);
			}
			current = "";
			continue;
		}
		current += char;
	}

	const tail = current.trim();
	if (tail.length > 0) {
		tokens.push(tail);
	}

	return tokens;
}
function normalizeScopeField(value: unknown): string[] | undefined {
	const normalized = normalizeRuleField(value);
	if (!normalized) {
		return undefined;
	}

	const tokens = normalized
		.flatMap(splitScopeTokens)
		.map(token => {
			// Tolerate malformed frontmatter (e.g. `scope: "text","thinking"`) whose
			// YAML-fallback parse leaves per-token quotes intact (issue #4796).
			const quote = token[0];
			if (token.length >= 2 && (quote === '"' || quote === "'") && token[token.length - 1] === quote) {
				return token.slice(1, -1).trim();
			}
			return token;
		})
		.filter(item => item.length > 0);
	if (tokens.length === 0) {
		return undefined;
	}
	return Array.from(new Set(tokens));
}
/**
 * Heuristic for condition shorthand that looks like a file glob (for example `*.rs`).
 */
function isLikelyFileGlob(value: string): boolean {
	const token = value.trim();
	if (token.length === 0) {
		return false;
	}
	if (/[\\^$+|()]/.test(token)) {
		return false;
	}
	if (!/[?*[\]{}]/.test(token)) {
		return false;
	}
	if (token.includes("/")) {
		return true;
	}
	return /^\*\.[^\s/]+$/.test(token);
}

/**
 * Parse `condition` + `scope` from rule frontmatter.
 *
 * - `condition` accepts string or string[]
 * - `scope` accepts string or string[]
 * - legacy `ttsr_trigger` / `ttsrTrigger` are accepted as a `condition` fallback
 * - condition tokens that look like file globs become scope shorthands:
 *   `*.rs` => `tool:edit(*.rs)`, `tool:write(*.rs)` and a catch-all condition `.*`
 * - `astCondition` holds ast-grep patterns and is kept verbatim (no glob inference)
 */
export function parseRuleConditionAndScope(
	frontmatter: RuleFrontmatter,
): Pick<Rule, "condition" | "astCondition" | "scope"> {
	const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
	const parsedCondition = normalizeRuleField(rawCondition);
	const astCondition = normalizeRuleField(frontmatter.astCondition);
	const parsedScope = normalizeScopeField(frontmatter.scope);

	const inferredScope: string[] = [];
	const condition: string[] = [];
	for (const token of parsedCondition ?? []) {
		if (isLikelyFileGlob(token)) {
			for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
				inferredScope.push(`tool:${toolName}(${token})`);
			}
			continue;
		}
		condition.push(token);
	}

	if (condition.length === 0 && inferredScope.length > 0) {
		condition.push(".*");
	}

	const scope = [...(parsedScope ?? []), ...inferredScope];
	return {
		condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
		astCondition,
		scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
	};
}

/** Leading PCRE-style inline flag group, e.g. `(?i)` or `(?ims)`. */
const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

/** Inline flags that map cleanly onto native `RegExp` flags. */
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

/**
 * Compile a rule `condition` into a `RegExp`, translating a leading PCRE-style
 * inline flag group into native `RegExp` flags.
 *
 * JS/Bun `RegExp` rejects inline flag prefixes such as `(?i)`, so a rule written
 * `condition: "(?i)pre.existing"` would otherwise throw at compile time and be
 * silently dropped (see issue #4796). Only a *leading* group of `i`/`m`/`s`
 * flags is translated; anything else — mid-pattern groups, unsupported flags —
 * is passed through verbatim so the native error still surfaces for genuinely
 * invalid patterns.
 */
export function compileRuleCondition(pattern: string): RegExp {
	const match = INLINE_FLAG_PREFIX.exec(pattern);
	if (match && TRANSLATABLE_INLINE_FLAGS.test(match[1])) {
		const flags = Array.from(new Set(match[1])).join("");
		return new RegExp(pattern.slice(match[0].length), flags);
	}
	return new RegExp(pattern);
}

function semanticConditionError(ruleName: string, clause: number, field: string, message: string): Error {
	return new Error(`Rule "${ruleName}" semanticCondition clause ${clause} field "${field}": ${message}`);
}

function rejectUnknownSemanticFields(
	ruleName: string,
	clause: number,
	field: string,
	value: Record<string, unknown>,
	allowed: readonly string[],
): void {
	const unknown = Object.keys(value).find(key => !allowed.includes(key));
	if (unknown) {
		throw semanticConditionError(ruleName, clause, `${field}.${unknown}`, "unknown field");
	}
}

function normalizeSemanticPatterns(
	ruleName: string,
	clause: number,
	field: string,
	value: unknown,
): string[] | undefined {
	if (value === undefined) return undefined;
	const values = typeof value === "string" ? [value] : value;
	if (!Array.isArray(values) || values.length === 0) {
		throw semanticConditionError(ruleName, clause, field, "expected a non-empty string or string array");
	}
	const patterns = values.map((entry, index) => {
		if (typeof entry !== "string" || entry.trim().length === 0) {
			throw semanticConditionError(ruleName, clause, `${field}[${index}]`, "expected a non-empty string");
		}
		return entry.trim();
	});
	return Array.from(new Set(patterns));
}

function validateSemanticRegex(ruleName: string, clause: number, field: string, patterns: readonly string[]): void {
	for (const pattern of patterns) {
		try {
			compileRuleCondition(pattern);
		} catch (error) {
			throw semanticConditionError(
				ruleName,
				clause,
				field,
				`invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
}

function parseSemanticMatcherSet(ruleName: string, clause: number, field: string, value: unknown): SemanticMatcherSet {
	if (!isRecord(value)) {
		throw semanticConditionError(ruleName, clause, field, "expected an object");
	}
	rejectUnknownSemanticFields(ruleName, clause, field, value, ["ast", "regex"]);
	const ast = normalizeSemanticPatterns(ruleName, clause, `${field}.ast`, value.ast);
	const regex = normalizeSemanticPatterns(ruleName, clause, `${field}.regex`, value.regex);
	if (!ast && !regex) {
		throw semanticConditionError(ruleName, clause, field, 'expected at least one "ast" or "regex" predicate');
	}
	if (regex) validateSemanticRegex(ruleName, clause, `${field}.regex`, regex);
	return { ...(ast ? { ast } : {}), ...(regex ? { regex } : {}) };
}

function parseSemanticReferences(ruleName: string, clause: number, value: unknown): SemanticReferencePredicate {
	if (!isRecord(value)) {
		throw semanticConditionError(ruleName, clause, "references", "expected an object");
	}
	rejectUnknownSemanticFields(ruleName, clause, "references", value, ["capture", "min", "max"]);
	if (typeof value.capture !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.capture)) {
		throw semanticConditionError(ruleName, clause, "references.capture", "expected a capture name");
	}
	const parseBound = (field: "min" | "max"): number | undefined => {
		const bound = value[field];
		if (bound === undefined) return undefined;
		if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 0) {
			throw semanticConditionError(ruleName, clause, `references.${field}`, "expected a non-negative integer");
		}
		return bound;
	};
	const min = parseBound("min");
	const max = parseBound("max");
	if (min === undefined && max === undefined) {
		throw semanticConditionError(ruleName, clause, "references", 'expected at least one "min" or "max" bound');
	}
	if (min !== undefined && max !== undefined && min > max) {
		throw semanticConditionError(ruleName, clause, "references", '"min" must not exceed "max"');
	}
	return { capture: value.capture, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

function semanticCandidateCaptures(candidate: SemanticCandidateMatcher): Set<string> {
	const captures = new Set<string>();
	const pattern = "regex" in candidate ? candidate.regex : candidate.ast;
	const matcher = "regex" in candidate ? /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g : /\${1,3}([A-Za-z_][A-Za-z0-9_]*)/g;
	for (const match of pattern.matchAll(matcher)) {
		if (match[1]) captures.add(match[1]);
	}
	return captures;
}

function parseSemanticClause(ruleName: string, clause: number, value: unknown): SemanticConditionClause {
	if (!isRecord(value)) {
		throw semanticConditionError(ruleName, clause, "clause", "expected an object");
	}
	rejectUnknownSemanticFields(ruleName, clause, "clause", value, ["candidate", "captures", "file", "references"]);

	if (!isRecord(value.candidate)) {
		throw semanticConditionError(ruleName, clause, "candidate", "expected an object");
	}
	rejectUnknownSemanticFields(ruleName, clause, "candidate", value.candidate, ["ast", "regex"]);
	const ast = normalizeSemanticPatterns(ruleName, clause, "candidate.ast", value.candidate.ast);
	const regex = normalizeSemanticPatterns(ruleName, clause, "candidate.regex", value.candidate.regex);
	if ((ast?.length ?? 0) + (regex?.length ?? 0) !== 1) {
		throw semanticConditionError(
			ruleName,
			clause,
			"candidate",
			'expected exactly one non-empty "ast" or "regex" pattern',
		);
	}
	if (regex) validateSemanticRegex(ruleName, clause, "candidate.regex", regex);
	const candidate: SemanticCandidateMatcher = ast ? { ast: ast[0] } : { regex: regex![0] };

	let captures: Record<string, SemanticCapturePredicate> | undefined;
	if (value.captures !== undefined) {
		if (!isRecord(value.captures) || Object.keys(value.captures).length === 0) {
			throw semanticConditionError(ruleName, clause, "captures", "expected a non-empty object");
		}
		captures = {};
		for (const [capture, rawPredicate] of Object.entries(value.captures)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(capture)) {
				throw semanticConditionError(ruleName, clause, `captures.${capture}`, "invalid capture name");
			}
			if (!isRecord(rawPredicate)) {
				throw semanticConditionError(ruleName, clause, `captures.${capture}`, "expected an object");
			}
			rejectUnknownSemanticFields(ruleName, clause, `captures.${capture}`, rawPredicate, ["regex", "notRegex"]);
			const captureRegex = normalizeSemanticPatterns(
				ruleName,
				clause,
				`captures.${capture}.regex`,
				rawPredicate.regex,
			);
			const captureNotRegex = normalizeSemanticPatterns(
				ruleName,
				clause,
				`captures.${capture}.notRegex`,
				rawPredicate.notRegex,
			);
			if (!captureRegex && !captureNotRegex) {
				throw semanticConditionError(
					ruleName,
					clause,
					`captures.${capture}`,
					'expected at least one "regex" or "notRegex" predicate',
				);
			}
			if (captureRegex) validateSemanticRegex(ruleName, clause, `captures.${capture}.regex`, captureRegex);
			if (captureNotRegex) {
				validateSemanticRegex(ruleName, clause, `captures.${capture}.notRegex`, captureNotRegex);
			}
			captures[capture] = {
				...(captureRegex ? { regex: captureRegex } : {}),
				...(captureNotRegex ? { notRegex: captureNotRegex } : {}),
			};
		}
	}

	const references =
		value.references === undefined ? undefined : parseSemanticReferences(ruleName, clause, value.references);
	if (references && !semanticCandidateCaptures(candidate).has(references.capture)) {
		throw semanticConditionError(
			ruleName,
			clause,
			"references.capture",
			`candidate does not capture ${references.capture}`,
		);
	}

	let file: SemanticFilePredicates | undefined;
	if (value.file !== undefined) {
		if (!isRecord(value.file)) {
			throw semanticConditionError(ruleName, clause, "file", "expected an object");
		}
		rejectUnknownSemanticFields(ruleName, clause, "file", value.file, ["required", "forbidden"]);
		const required =
			value.file.required === undefined
				? undefined
				: parseSemanticMatcherSet(ruleName, clause, "file.required", value.file.required);
		const forbidden =
			value.file.forbidden === undefined
				? undefined
				: parseSemanticMatcherSet(ruleName, clause, "file.forbidden", value.file.forbidden);
		if (!required && !forbidden) {
			throw semanticConditionError(
				ruleName,
				clause,
				"file",
				'expected at least one "required" or "forbidden" predicate',
			);
		}
		file = { ...(required ? { required } : {}), ...(forbidden ? { forbidden } : {}) };
	}

	return {
		candidate,
		...(captures ? { captures } : {}),
		...(file ? { file } : {}),
		...(references ? { references } : {}),
	};
}

export function parseSemanticCondition(ruleName: string, value: unknown): SemanticConditionClause[] | undefined {
	if (value === undefined) return undefined;
	const clauses = Array.isArray(value) ? value : [value];
	if (clauses.length === 0) {
		throw semanticConditionError(ruleName, 1, "semanticCondition", "expected a non-empty clause or clause array");
	}
	return clauses.map((clause, index) => parseSemanticClause(ruleName, index + 1, clause));
}

let activeRules: readonly Rule[] = [];

/**
 * Process-global snapshot of rules the active session loaded.
 * Read by internal URL protocol handlers (rule://).
 */
export function getActiveRules(): readonly Rule[] {
	return activeRules;
}

/** Replace the active rule snapshot. Called once per top-level session. */
export function setActiveRules(value: readonly Rule[]): void {
	activeRules = value;
}

/** Reset the active rule snapshot. Test-only. */
export function resetActiveRulesForTests(): void {
	activeRules = [];
}

export const ruleCapability = defineCapability<Rule>({
	id: "rules",
	displayName: "Rules",
	description: "Project-specific rules and constraints (Cursor MDC, Windsurf, Cline formats)",
	key: rule => rule.name,
	toExtensionId: rule => `rule:${rule.name}`,
	validate: rule => {
		if (!rule.name) return "Missing rule name";
		if (!rule.path) return "Missing rule path";
		if (!rule.content || typeof rule.content !== "string") return "Rule must have content";
		return undefined;
	},
});

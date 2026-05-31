/**
 * Structured error types for the DSL runtime.
 *
 * Errors are designed to be safe to surface to an agent loop: the message
 * names the failure mode in one sentence, optional `span` carries source
 * coordinates from the parser, and `kind` lets callers branch on the failure
 * class without string matching.
 */

/** 1-indexed source coordinates. `length` measures the highlighted token. */
export interface SourceSpan {
	/** 1-indexed line of the failure. */
	line: number;
	/** 1-indexed column of the failure. */
	column: number;
	/** 0-indexed byte offset into the source. */
	offset: number;
	/** Length of the highlighted token in code units (≥ 0). */
	length: number;
}

/** Reason class for a {@link DstuiError}. */
export type DstuiErrorKind = "parse" | "parse-limit" | "compile" | "compile-limit" | "eval" | "eval-limit" | "runtime";

/** Single base class for every error thrown by this package. */
export class DstuiError extends Error {
	readonly kind: DstuiErrorKind;
	readonly span?: SourceSpan;

	constructor(kind: DstuiErrorKind, message: string, span?: SourceSpan) {
		super(message);
		this.name = "DstuiError";
		this.kind = kind;
		this.span = span;
	}
}

/** Thrown when source bytes / nesting depth / node count exceeds {@link DstuiLimits}. */
export class ParseLimitError extends DstuiError {
	constructor(message: string, span?: SourceSpan) {
		super("parse-limit", message, span);
		this.name = "ParseLimitError";
	}
}

/** Thrown when the parser sees malformed source (unterminated string/list, stray `)`, etc.). */
export class ParseError extends DstuiError {
	constructor(message: string, span?: SourceSpan) {
		super("parse", message, span);
		this.name = "ParseError";
	}
}

/** Thrown when a `defcomponent` / `defview` form is structurally invalid or exceeds caps. */
export class CompileError extends DstuiError {
	constructor(message: string, span?: SourceSpan) {
		super("compile", message, span);
		this.name = "CompileError";
	}
}

/** Thrown when a component declares more state/bindings/timers/params than {@link DstuiLimits} allow. */
export class CompileLimitError extends DstuiError {
	constructor(message: string) {
		super("compile-limit", message);
		this.name = "CompileLimitError";
	}
}

/** Thrown when DSL code attempts a forbidden operation (prototype key access, etc.). */
export class EvaluationError extends DstuiError {
	constructor(message: string) {
		super("eval", message);
		this.name = "EvaluationError";
	}
}

/** Thrown when the evaluator exhausts its step / depth budget. */
export class EvalLimitError extends DstuiError {
	constructor(message: string) {
		super("eval-limit", message);
		this.name = "EvalLimitError";
	}
}

/** Thrown for runtime misuse of the public API (e.g. unknown component). */
export class RuntimeError extends DstuiError {
	constructor(message: string) {
		super("runtime", message);
		this.name = "RuntimeError";
	}
}

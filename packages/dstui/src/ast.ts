/**
 * S-expression AST types used by the parser, compiler, and evaluator.
 *
 * The DSL has three atomic kinds beyond the JS primitives: `Sym` (bare
 * identifiers like `flex-row`), `Kw` (keyword args like `:gap`), and `null`
 * (the literal `nil`). Anything else is a list (`SExpr[]`).
 *
 * Source spans live on the nodes themselves — `Sym` / `Kw` carry an optional
 * `span` field, and lists are tagged via {@link SPAN_KEY}. Use
 * {@link getSpan} to read whichever shape the node uses without branching at
 * the call site.
 */

import type { SourceSpan } from "./errors";

/** Symbol property used to tag a list (`SExpr[]`) with its source span. */
export const SPAN_KEY: unique symbol = Symbol("dstui.span");

/** Bare identifier in the DSL (e.g. `flex-row`, `set!`, `cursor`). */
export class Sym {
	readonly name: string;
	span?: SourceSpan;
	constructor(name: string, span?: SourceSpan) {
		this.name = name;
		this.span = span;
	}
	toString(): string {
		return this.name;
	}
}

/** Keyword argument in the DSL (e.g. `:gap`, `:accent`). */
export class Kw {
	readonly name: string;
	span?: SourceSpan;
	constructor(name: string, span?: SourceSpan) {
		this.name = name;
		this.span = span;
	}
	toString(): string {
		return `:${this.name}`;
	}
}

/** Anything that can appear at a leaf of the AST. */
export type Atom = number | string | boolean | null | Sym | Kw;

/** A parsed S-expression: an atom or a list of nested expressions. */
export type SExpr = Atom | SExpr[];

/** List augmented with the symbol-keyed span tag. Use via {@link tagSpan}. */
interface SpannedList extends Array<SExpr> {
	[SPAN_KEY]?: SourceSpan;
}

/** Attach a {@link SourceSpan} to a parsed list node. */
export function tagSpan(list: SExpr[], span: SourceSpan): void {
	(list as SpannedList)[SPAN_KEY] = span;
}

/** Read a {@link SourceSpan} off any AST node, or `undefined` if none was attached. */
export function getSpan(node: SExpr): SourceSpan | undefined {
	if (node instanceof Sym || node instanceof Kw) return node.span;
	if (Array.isArray(node)) return (node as SpannedList)[SPAN_KEY];
	return undefined;
}

/** Type guard: is `value` a {@link Sym}? Optionally narrow to a specific name. */
export function isSym(value: unknown, name?: string): value is Sym {
	return value instanceof Sym && (name === undefined || value.name === name);
}

/** Type guard: is `value` a {@link Kw}? Optionally narrow to a specific name. */
export function isKw(value: unknown, name?: string): value is Kw {
	return value instanceof Kw && (name === undefined || value.name === name);
}

/** Type guard: is `value` an S-expression list? */
export function isList(value: unknown): value is SExpr[] {
	return Array.isArray(value);
}

/**
 * S-expression parser for the DSL.
 *
 * The parser is bounded by {@link DstuiLimits}: it rejects oversized source
 * before tokenization, caps nesting depth and AST node count during the walk,
 * and rejects every malformed shape (unterminated list, unterminated string,
 * stray `)`) with a {@link ParseError} whose {@link SourceSpan} points at the
 * exact failure column.
 *
 * The original upstream parser silently accepted partial lists/strings; this
 * port surfaces the same situations as hard errors so an agent loop can fix
 * the source instead of trying to render half a tree.
 */

import { type Atom, Kw, type SExpr, Sym, tagSpan } from "./ast";
import { ParseError, ParseLimitError, type SourceSpan } from "./errors";
import { DEFAULT_LIMITS, type DstuiLimits, resolveLimits } from "./limits";

/** Result of a successful parse. */
export interface ParseResult {
	/** Top-level S-expressions, in source order. */
	exprs: SExpr[];
}

/** Optional parser overrides. */
export interface ParseOptions {
	/** Overlay onto {@link DEFAULT_LIMITS}; missing fields fall back to defaults. */
	limits?: Partial<DstuiLimits>;
}

const TAB = "\t";
const NL = "\n";
const CR = "\r";

/** Parse `source` into an S-expression tree. Spans are tagged on the nodes themselves. */
export function parse(source: string, options: ParseOptions = {}): ParseResult {
	const limits = resolveLimits(options.limits);

	if (typeof source !== "string") {
		throw new ParseError("source must be a string");
	}
	if (source.length > limits.maxSourceBytes) {
		throw new ParseLimitError(`source exceeds maxSourceBytes (${source.length} > ${limits.maxSourceBytes})`);
	}

	let nodeCount = 0;
	let pos = 0;
	let line = 1;
	let column = 1;

	const trackChar = (ch: string): void => {
		if (ch === NL) {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	};

	const peek = (): string => source[pos] ?? "";
	const consume = (): string => {
		const ch = source[pos] ?? "";
		pos += 1;
		trackChar(ch);
		return ch;
	};

	const here = (length = 1): SourceSpan => ({
		line,
		column,
		offset: pos,
		length,
	});

	const bumpNodeCount = (span: SourceSpan): void => {
		nodeCount += 1;
		if (nodeCount > limits.maxAstNodes) {
			throw new ParseLimitError(`AST node count exceeds maxAstNodes (${limits.maxAstNodes})`, span);
		}
	};

	const isWhitespace = (ch: string): boolean => ch === " " || ch === TAB || ch === NL || ch === CR;
	const isSymbolChar = (ch: string): boolean =>
		ch !== "" && !isWhitespace(ch) && ch !== "(" && ch !== ")" && ch !== '"' && ch !== ";";

	const skipTrivia = (): void => {
		while (pos < source.length) {
			const ch = peek();
			if (isWhitespace(ch)) {
				consume();
				continue;
			}
			if (ch === ";") {
				while (pos < source.length && peek() !== NL) consume();
				continue;
			}
			break;
		}
	};

	const readString = (): { value: string; span: SourceSpan } => {
		const startLine = line;
		const startColumn = column;
		const startOffset = pos;
		consume(); // opening quote
		let out = "";
		while (pos < source.length && peek() !== '"') {
			if (out.length > limits.maxStringLength) {
				throw new ParseLimitError(`string literal exceeds maxStringLength (${limits.maxStringLength})`, {
					line: startLine,
					column: startColumn,
					offset: startOffset,
					length: pos - startOffset,
				});
			}
			if (peek() === "\\") {
				consume();
				if (pos >= source.length) {
					throw new ParseError("unterminated escape sequence", {
						line,
						column,
						offset: pos,
						length: 1,
					});
				}
				const ch = consume();
				if (ch === "n") out += NL;
				else if (ch === "t") out += TAB;
				else if (ch === "r") out += CR;
				else if (ch === "\\" || ch === '"') out += ch;
				else out += ch;
			} else {
				out += consume();
			}
		}
		if (peek() !== '"') {
			throw new ParseError("unterminated string literal", {
				line: startLine,
				column: startColumn,
				offset: startOffset,
				length: pos - startOffset,
			});
		}
		consume(); // closing quote
		return {
			value: out,
			span: {
				line: startLine,
				column: startColumn,
				offset: startOffset,
				length: pos - startOffset,
			},
		};
	};

	const readAtom = (): { value: Atom; span: SourceSpan } => {
		if (peek() === '"') {
			const { value, span } = readString();
			return { value, span };
		}
		const startLine = line;
		const startColumn = column;
		const startOffset = pos;
		let token = "";
		while (isSymbolChar(peek())) token += consume();
		const span: SourceSpan = {
			line: startLine,
			column: startColumn,
			offset: startOffset,
			length: token.length,
		};
		if (token.length === 0) {
			throw new ParseError(`unexpected character '${peek() || "<eof>"}'`, span);
		}
		if (token === "true") return { value: true, span };
		if (token === "false") return { value: false, span };
		if (token === "nil") return { value: null, span };
		if (/^-?\d+(?:\.\d+)?$/.test(token)) return { value: Number(token), span };
		if (token.startsWith(":") && token.length > 1) return { value: new Kw(token.slice(1), span), span };
		return { value: new Sym(token, span), span };
	};

	let depth = 0;

	const readExpr = (): { value: SExpr; span: SourceSpan } => {
		skipTrivia();
		if (pos >= source.length) {
			throw new ParseError("unexpected end of source", here(0));
		}
		const ch = peek();
		if (ch === ")") {
			throw new ParseError("unexpected ')'", here(1));
		}
		if (ch === "(") {
			depth += 1;
			if (depth > limits.maxParseDepth) {
				throw new ParseLimitError(`nesting depth exceeds maxParseDepth (${limits.maxParseDepth})`, here(1));
			}
			const startLine = line;
			const startColumn = column;
			const startOffset = pos;
			consume(); // '('
			const list: SExpr[] = [];
			while (true) {
				skipTrivia();
				if (pos >= source.length) {
					throw new ParseError("unterminated list (expected ')')", {
						line: startLine,
						column: startColumn,
						offset: startOffset,
						length: pos - startOffset,
					});
				}
				if (peek() === ")") {
					consume();
					break;
				}
				const { value } = readExpr();
				list.push(value);
			}
			depth -= 1;
			const span: SourceSpan = {
				line: startLine,
				column: startColumn,
				offset: startOffset,
				length: pos - startOffset,
			};
			tagSpan(list, span);
			bumpNodeCount(span);
			return { value: list, span };
		}
		if (ch === "'") {
			const startLine = line;
			const startColumn = column;
			const startOffset = pos;
			consume(); // "'"
			const quoted = readExpr();
			const list: SExpr[] = [new Sym("quote"), quoted.value];
			const span: SourceSpan = {
				line: startLine,
				column: startColumn,
				offset: startOffset,
				length: pos - startOffset,
			};
			tagSpan(list, span);
			bumpNodeCount(span);
			return { value: list, span };
		}
		const atom = readAtom();
		bumpNodeCount(atom.span);
		return { value: atom.value, span: atom.span };
	};

	const exprs: SExpr[] = [];
	while (true) {
		skipTrivia();
		if (pos >= source.length) break;
		const { value } = readExpr();
		exprs.push(value);
	}

	return { exprs };
}

import { describe, expect, test } from "bun:test";
import { getSpan, isSym, Kw, Sym } from "../src/ast";
import { ParseError, ParseLimitError } from "../src/errors";
import { parse } from "../src/parser";

describe("parse", () => {
	test("parses primitives and quote shorthand", () => {
		const { exprs } = parse(`123 "hi" :kw foo 'bar`);
		expect(exprs[0]).toBe(123);
		expect(exprs[1]).toBe("hi");
		expect(exprs[2]).toBeInstanceOf(Kw);
		expect(exprs[3]).toBeInstanceOf(Sym);
		const quoted = exprs[4];
		expect(Array.isArray(quoted)).toBe(true);
		const list = quoted as unknown[];
		expect(isSym(list[0], "quote")).toBe(true);
	});

	test("attaches spans to symbol/keyword/list nodes", () => {
		const { exprs } = parse(`(text "hi" :accent)`);
		const list = exprs[0] as unknown[];
		const span = getSpan(list as never);
		expect(span?.line).toBe(1);
		expect(span?.column).toBe(1);
		expect(span?.length).toBeGreaterThan(0);
	});

	test("rejects unterminated list with span at opening paren", () => {
		try {
			parse('(text "hi"');
			throw new Error("expected ParseError");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			expect((err as ParseError).span?.line).toBe(1);
			expect((err as ParseError).span?.column).toBe(1);
		}
	});

	test("rejects unterminated string with span at opening quote", () => {
		try {
			parse('(text "broken');
			throw new Error("expected ParseError");
		} catch (err) {
			expect(err).toBeInstanceOf(ParseError);
			expect((err as ParseError).message).toContain("unterminated string");
		}
	});

	test("rejects stray closing paren", () => {
		expect(() => parse(") foo")).toThrow(ParseError);
	});

	test("enforces maxSourceBytes", () => {
		const large = "x".repeat(2000);
		expect(() => parse(large, { limits: { maxSourceBytes: 100 } })).toThrow(ParseLimitError);
	});

	test("enforces maxParseDepth", () => {
		const deep = `${"(".repeat(200)}1${")".repeat(200)}`;
		expect(() => parse(deep, { limits: { maxParseDepth: 16 } })).toThrow(ParseLimitError);
	});

	test("enforces maxAstNodes", () => {
		const many = `(${"x ".repeat(1000)})`;
		expect(() => parse(many, { limits: { maxAstNodes: 64 } })).toThrow(ParseLimitError);
	});

	test("supports line comments", () => {
		const { exprs } = parse(`; lead\n42 ; trailing\n`);
		expect(exprs[0]).toBe(42);
	});
});

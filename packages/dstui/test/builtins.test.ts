import { describe, expect, test } from "bun:test";
import { installBuiltins, safeFieldRead } from "../src/builtins";
import { EvalLimitError, EvaluationError } from "../src/errors";
import { Budget, Env, evaluate } from "../src/evaluator";
import { DEFAULT_LIMITS } from "../src/limits";
import { parse } from "../src/parser";

function run(source: string, limits = DEFAULT_LIMITS): unknown {
	const env = new Env();
	installBuiltins(env, limits);
	const budget = new Budget(limits);
	const { exprs } = parse(source, { limits });
	let result: unknown = null;
	for (const expr of exprs) result = evaluate(expr, env, budget);
	return result;
}

describe("builtins", () => {
	test("string helpers", () => {
		expect(run(`(str "a" 1 :kw)`)).toBe("a1:kw");
		expect(run(`(join ", " (list 1 2 3))`)).toBe("1, 2, 3");
		expect(run(`(repeat "ab" 3)`)).toBe("ababab");
		expect(run(`(pad "x" 4)`)).toBe("   x");
		expect(run(`(pad-end "x" 4 "-")`)).toBe("x---");
	});

	test("list helpers", () => {
		expect(run(`(len (list 1 2 3))`)).toBe(3);
		expect(run(`(nth (list "a" "b" "c") 1)`)).toBe("b");
		expect(run(`(append (list 1 2) 3)`)).toEqual([1, 2, 3]);
		expect(run(`(slice (list 0 1 2 3 4) 1 4)`)).toEqual([1, 2, 3]);
		expect(run(`(swap (list "a" "b" "c") 0 2)`)).toEqual(["c", "b", "a"]);
		expect(run(`(splice-move (list "a" "b" "c") 0 2)`)).toEqual(["b", "c", "a"]);
	});

	test("math helpers", () => {
		expect(run(`(clamp 5 0 10)`)).toBe(5);
		expect(run(`(clamp 15 0 10)`)).toBe(10);
		expect(run(`(ratio 50 0 100)`)).toBe(0.5);
		expect(run(`(ratio 5 5 5)`)).toBe(1);
		expect(run(`(mod 10 3)`)).toBe(1);
		expect(run(`(mod 10 0)`)).toBe(0);
		expect(run(`(/ 10 0)`)).toBe(0);
	});

	test("safeFieldRead rejects prototype keys and rejects arrays", () => {
		const obj: Record<string, unknown> = { foo: 1, bar: 2 };
		expect(safeFieldRead(obj, "foo")).toBe(1);
		expect(safeFieldRead(obj, "missing")).toBe(undefined);
		expect(() => safeFieldRead(obj, "__proto__")).toThrow(EvaluationError);
		expect(() => safeFieldRead(obj, "prototype")).toThrow(EvaluationError);
		expect(() => safeFieldRead(obj, "constructor")).toThrow(EvaluationError);
		expect(safeFieldRead([1, 2, 3], "0")).toBe(undefined);
	});

	test("repeat enforces maxStringLength", () => {
		expect(() => run(`(repeat "abcdef" 10000)`, { ...DEFAULT_LIMITS, maxStringLength: 100 })).toThrow(EvalLimitError);
	});

	test("list builtin enforces maxListLength", () => {
		const source = `(list ${"1 ".repeat(2000)})`;
		expect(() => run(source, { ...DEFAULT_LIMITS, maxListLength: 50, maxAstNodes: 8192 })).toThrow(EvalLimitError);
	});
});

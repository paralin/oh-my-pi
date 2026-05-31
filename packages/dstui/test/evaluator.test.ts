import { describe, expect, test } from "bun:test";
import { installBuiltins } from "../src/builtins";
import { EvalLimitError, EvaluationError } from "../src/errors";
import { assertSafeKey, Budget, CANCEL_SLOT, EMIT_SLOT, Env, evaluate, FORBIDDEN_KEYS } from "../src/evaluator";
import { DEFAULT_LIMITS } from "../src/limits";
import { parse } from "../src/parser";

function run(source: string, limits = DEFAULT_LIMITS): unknown {
	const env = new Env();
	installBuiltins(env, limits);
	const budget = new Budget(limits);
	const { exprs } = parse(source, { limits });
	let result: unknown = null;
	for (const expr of exprs) {
		result = evaluate(expr, env, budget);
	}
	return result;
}

describe("evaluator", () => {
	test("evaluates math and comparisons", () => {
		expect(run("(+ 1 2 3)")).toBe(6);
		expect(run("(- 10 1 2)")).toBe(7);
		expect(run("(* 2 3 4)")).toBe(24);
		expect(run("(< 1 2)")).toBe(true);
		expect(run("(= 1 1.0)")).toBe(true);
	});

	test("supports let, do, set!, if, cond, when", () => {
		expect(run(`(let ((x 2) (y 3)) (+ x y))`)).toBe(5);
		expect(run(`(do (+ 1 2) (+ 3 4))`)).toBe(7);
		expect(run(`(let ((x 1)) (set! x 99) x)`)).toBe(99);
		expect(run(`(if true 1 2)`)).toBe(1);
		expect(run(`(if false 1 2)`)).toBe(2);
		expect(run(`(when false 99)`)).toBe(null);
		expect(run(`(cond ((= 1 2) 9) ((= 2 2) 10) (else 11))`)).toBe(10);
	});

	test("supports user-defined functions", () => {
		expect(run(`(let ((sq (fn (x) (* x x)))) (sq 5))`)).toBe(25);
	});

	test("emit/cancel route through env slots", () => {
		const env = new Env();
		installBuiltins(env, DEFAULT_LIMITS);
		const budget = new Budget(DEFAULT_LIMITS);
		let emitted: unknown = "unset";
		let cancelled = false;
		env.set(EMIT_SLOT, (v: unknown) => {
			emitted = v;
		});
		env.set(CANCEL_SLOT, () => {
			cancelled = true;
		});
		evaluate(parse("(emit 42)").exprs[0] as never, env, budget);
		evaluate(parse("(cancel)").exprs[0] as never, env, budget);
		expect(emitted).toBe(42);
		expect(cancelled).toBe(true);
	});

	test("set! on forbidden key throws", () => {
		expect(() => run("(set! __proto__ 1)")).toThrow(EvaluationError);
		expect(() => run("(set! constructor 1)")).toThrow(EvaluationError);
	});

	test("assertSafeKey rejects every forbidden key", () => {
		for (const key in FORBIDDEN_KEYS) {
			expect(() => assertSafeKey(key)).toThrow(EvaluationError);
		}
		expect(() => assertSafeKey("safe")).not.toThrow();
	});

	test("evaluator step budget fires on runaway recursion", () => {
		const limits = { ...DEFAULT_LIMITS, maxEvalSteps: 50 };
		const source = `(let ((loop (fn (n) (loop (+ n 1))))) (loop 0))`;
		expect(() => run(source, limits)).toThrow(EvalLimitError);
	});

	test("evaluator depth budget fires on deep recursion", () => {
		const limits = { ...DEFAULT_LIMITS, maxEvalDepth: 8, maxEvalSteps: 100_000 };
		const source = `(let ((deep (fn (n) (if (= n 0) 1 (deep (- n 1)))))) (deep 100))`;
		expect(() => run(source, limits)).toThrow(EvalLimitError);
	});

	test("no host realm access via Sym lookup", () => {
		// globalThis is not bound — looking it up returns undefined; calling it errors.
		expect(() => run("(globalThis)")).toThrow(EvaluationError);
		expect(() => run("(eval 1)")).toThrow(EvaluationError);
		expect(() => run("(Function 1)")).toThrow(EvaluationError);
	});
});

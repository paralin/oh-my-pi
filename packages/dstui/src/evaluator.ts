/**
 * Safe evaluator for the DSL.
 *
 * Every call into {@link evaluate} is bookended by {@link Budget.enter} /
 * {@link Budget.leave} so the host can cap recursion depth and total step
 * count per render or input cycle. The budget is meant to be reset at the
 * start of each cycle by the runtime — see `runtime.ts`.
 *
 * The evaluator never reaches into the host realm:
 *
 * - No `globalThis`, no `eval`, no `Function`, no dynamic import.
 * - Dynamic key access (the `field` builtin and DSL named-arg parsing) denies
 *   `__proto__`, `prototype`, and `constructor`.
 * - User-visible records use `Object.create(null)` so prototype pollution
 *   through `__proto__` assignment is impossible.
 *
 * Special forms supported: `quote`, `if`, `cond`, `when`, `let`, `do`,
 * `set!`, `fn`, `emit`, `cancel`. Anything else is dispatched as a function
 * call against the resolved head.
 */

import { isList, isSym, Kw, type SExpr, Sym } from "./ast";
import { EvalLimitError, EvaluationError } from "./errors";
import type { DstuiLimits } from "./limits";

/**
 * Lexical environment. `set` always writes into the local frame; `update`
 * mutates the nearest binding (matching Scheme's `set!`). `get` walks the
 * parent chain.
 */
export class Env {
	#values: Map<string, unknown>;
	#parent?: Env;

	constructor(parent?: Env) {
		this.#values = new Map();
		this.#parent = parent;
	}

	has(name: string): boolean {
		if (this.#values.has(name)) return true;
		return this.#parent?.has(name) ?? false;
	}

	get(name: string): unknown {
		if (this.#values.has(name)) return this.#values.get(name);
		return this.#parent?.get(name);
	}

	set(name: string, value: unknown): void {
		this.#values.set(name, value);
	}

	update(name: string, value: unknown): boolean {
		if (this.#values.has(name)) {
			this.#values.set(name, value);
			return true;
		}
		return this.#parent?.update(name, value) ?? false;
	}

	/** Iterate the local frame's own bindings (excludes parents). */
	ownBindings(): IterableIterator<[string, unknown]> {
		return this.#values.entries();
	}
}

/** Per-cycle resource accountant. Reused across renders/inputs after {@link reset}. */
export class Budget {
	#steps = 0;
	#depth = 0;
	#limits: Readonly<DstuiLimits>;

	constructor(limits: Readonly<DstuiLimits>) {
		this.#limits = limits;
	}

	get steps(): number {
		return this.#steps;
	}

	get depth(): number {
		return this.#depth;
	}

	get limits(): Readonly<DstuiLimits> {
		return this.#limits;
	}

	reset(): void {
		this.#steps = 0;
		this.#depth = 0;
	}

	tick(): void {
		this.#steps += 1;
		if (this.#steps > this.#limits.maxEvalSteps) {
			throw new EvalLimitError(`evaluation steps exceeded maxEvalSteps (${this.#limits.maxEvalSteps})`);
		}
	}

	enter(): void {
		this.#depth += 1;
		if (this.#depth > this.#limits.maxEvalDepth) {
			throw new EvalLimitError(`evaluation depth exceeded maxEvalDepth (${this.#limits.maxEvalDepth})`);
		}
	}

	leave(): void {
		this.#depth -= 1;
	}
}

/** Keys that must never be read or written through DSL-controlled access. */
const FORBIDDEN_KEY_TABLE = Object.freeze({
	["__proto__"]: true,
	prototype: true,
	constructor: true,
} as const);
export const FORBIDDEN_KEYS: Readonly<Record<string, true>> = FORBIDDEN_KEY_TABLE as Readonly<Record<string, true>>;

/** Throw if `key` would let DSL code reach an object's prototype chain. */
export function assertSafeKey(key: string): void {
	if (Object.hasOwn(FORBIDDEN_KEYS, key)) {
		throw new EvaluationError(`forbidden key: ${key}`);
	}
}

/**
 * Special slot names the runtime uses to inject `emit` / `cancel`. Owned by
 * this module so callers cannot stomp them from DSL code without going
 * through the public `(emit ...)` / `(cancel)` forms.
 */
export const EMIT_SLOT = "__dstui:emit__";
export const CANCEL_SLOT = "__dstui:cancel__";

/** Evaluate an S-expression against `env`, accounting for `budget`. */
export function evaluate(expr: SExpr, env: Env, budget: Budget): unknown {
	budget.tick();
	if (expr === null) return null;
	if (typeof expr === "number" || typeof expr === "boolean" || typeof expr === "string") return expr;
	if (expr instanceof Sym) return env.get(expr.name);
	if (expr instanceof Kw) return expr;
	if (!isList(expr) || expr.length === 0) return null;

	const head = expr[0];

	// Special forms ----------------------------------------------------------
	if (isSym(head, "quote")) return expr[1] ?? null;

	if (isSym(head, "if")) {
		const test = evaluate(expr[1] ?? null, env, budget);
		const branch = test ? (expr[2] ?? null) : (expr[3] ?? null);
		budget.enter();
		try {
			return evaluate(branch, env, budget);
		} finally {
			budget.leave();
		}
	}

	if (isSym(head, "cond")) {
		for (let i = 1; i < expr.length; i++) {
			const clause = expr[i];
			if (!isList(clause) || clause.length < 2) continue;
			const isElse = isSym(clause[0], "else");
			if (isElse || evaluate(clause[0] ?? null, env, budget)) {
				let result: unknown = null;
				for (let j = 1; j < clause.length; j++) {
					result = evaluate(clause[j] ?? null, env, budget);
				}
				return result;
			}
		}
		return null;
	}

	if (isSym(head, "when")) {
		const test = evaluate(expr[1] ?? null, env, budget);
		if (!test) return null;
		let result: unknown = null;
		for (let i = 2; i < expr.length; i++) {
			result = evaluate(expr[i] ?? null, env, budget);
		}
		return result;
	}

	if (isSym(head, "let")) {
		const child = new Env(env);
		const bindings = expr[1];
		if (isList(bindings)) {
			for (const binding of bindings) {
				if (isList(binding) && binding.length >= 2 && isSym(binding[0])) {
					assertSafeKey(binding[0].name);
					child.set(binding[0].name, evaluate(binding[1] ?? null, child, budget));
				}
			}
		}
		let result: unknown = null;
		budget.enter();
		try {
			for (let i = 2; i < expr.length; i++) {
				result = evaluate(expr[i] ?? null, child, budget);
			}
		} finally {
			budget.leave();
		}
		return result;
	}

	if (isSym(head, "do")) {
		let result: unknown = null;
		for (let i = 1; i < expr.length; i++) {
			result = evaluate(expr[i] ?? null, env, budget);
		}
		return result;
	}

	if (isSym(head, "set!")) {
		const target = expr[1];
		if (!isSym(target)) {
			throw new EvaluationError("set! target must be a symbol");
		}
		assertSafeKey(target.name);
		const value = evaluate(expr[2] ?? null, env, budget);
		if (!env.update(target.name, value)) {
			env.set(target.name, value);
		}
		return value;
	}

	if (isSym(head, "fn")) {
		const paramList = expr[1];
		const paramNames: string[] = [];
		if (isList(paramList)) {
			for (const p of paramList) {
				if (p instanceof Sym) {
					assertSafeKey(p.name);
					paramNames.push(p.name);
				}
			}
		}
		const body = expr.slice(2);
		const closureEnv = env;
		return (...args: unknown[]): unknown => {
			const child = new Env(closureEnv);
			for (let i = 0; i < paramNames.length; i++) {
				child.set(paramNames[i] ?? "_", args[i]);
			}
			let result: unknown = null;
			budget.enter();
			try {
				for (const form of body) {
					result = evaluate(form, child, budget);
				}
			} finally {
				budget.leave();
			}
			return result;
		};
	}

	if (isSym(head, "emit")) {
		const emit = env.get(EMIT_SLOT) as ((value: unknown) => void) | undefined;
		const value = evaluate(expr[1] ?? null, env, budget);
		emit?.(value);
		return value;
	}

	if (isSym(head, "cancel")) {
		const cancel = env.get(CANCEL_SLOT) as (() => void) | undefined;
		cancel?.();
		return null;
	}

	// General application ----------------------------------------------------
	budget.enter();
	try {
		const fn = evaluate(head ?? null, env, budget);
		const args: unknown[] = new Array(expr.length - 1);
		for (let i = 1; i < expr.length; i++) {
			args[i - 1] = evaluate(expr[i] ?? null, env, budget);
		}
		if (typeof fn !== "function") {
			if (isSym(head)) {
				throw new EvaluationError(`not a function: ${head.name}`);
			}
			throw new EvaluationError("call target is not a function");
		}
		return fn(...args);
	} finally {
		budget.leave();
	}
}

/** Convenience: evaluate against a fresh budget, no host injection. */
export function evaluateStandalone(expr: SExpr, env: Env, limits: Readonly<DstuiLimits>): unknown {
	return evaluate(expr, env, new Budget(limits));
}

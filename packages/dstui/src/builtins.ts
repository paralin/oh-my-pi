/**
 * DSL builtins.
 *
 * Every builtin enforces {@link DstuiLimits} on its output size so a hostile
 * call sequence (`(repeat "x" 1e9)`, `(slice list 0 -1)`, etc.) cannot
 * exhaust memory before the {@link Budget} step counter catches up. Object
 * access goes through {@link safeFieldRead} so prototype keys are blocked
 * regardless of how the input was constructed.
 */

import { isList, Kw, Sym } from "./ast";
import { EvalLimitError, EvaluationError } from "./errors";
import { assertSafeKey, type Env } from "./evaluator";
import type { DstuiLimits } from "./limits";

const toNumber = (value: unknown): number => {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
};

const toStringSafe = (value: unknown, limits: Readonly<DstuiLimits>): string => {
	const raw = stringifyAtom(value);
	if (raw.length > limits.maxStringLength) {
		throw new EvalLimitError(`string length exceeded maxStringLength (${limits.maxStringLength})`);
	}
	return raw;
};

const stringifyAtom = (value: unknown): string => {
	if (value === null || value === undefined) return "";
	if (value instanceof Sym) return value.name;
	if (value instanceof Kw) return `:${value.name}`;
	if (Array.isArray(value)) return value.map(stringifyAtom).join("");
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
	return String(value);
};

const checkListLength = (n: number, limits: Readonly<DstuiLimits>): void => {
	if (n > limits.maxListLength) {
		throw new EvalLimitError(`list length exceeded maxListLength (${limits.maxListLength})`);
	}
};

const checkStringLength = (n: number, limits: Readonly<DstuiLimits>): void => {
	if (n > limits.maxStringLength) {
		throw new EvalLimitError(`string length exceeded maxStringLength (${limits.maxStringLength})`);
	}
};

/**
 * Read `key` off `obj`, returning `undefined` if the key is forbidden, the
 * key is not an own property of `obj`, or `obj` is not a plain dictionary.
 */
export function safeFieldRead(obj: unknown, key: string): unknown {
	assertSafeKey(key);
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
	if (!Object.hasOwn(obj as Record<string, unknown>, key)) return undefined;
	return (obj as Record<string, unknown>)[key];
}

/** Install the DSL's built-in functions onto `env`. */
export function installBuiltins(env: Env, limits: Readonly<DstuiLimits>): void {
	// Math ----------------------------------------------------------------
	env.set("+", (...args: unknown[]) => args.reduce((sum: number, v) => sum + toNumber(v), 0));
	env.set("-", (...args: unknown[]) => {
		if (args.length === 0) return 0;
		if (args.length === 1) return -toNumber(args[0]);
		let acc = toNumber(args[0]);
		for (let i = 1; i < args.length; i++) acc -= toNumber(args[i]);
		return acc;
	});
	env.set("*", (...args: unknown[]) => args.reduce((prod: number, v) => prod * toNumber(v), 1));
	env.set("/", (a: unknown, b: unknown) => {
		const denom = toNumber(b);
		return denom === 0 ? 0 : toNumber(a) / denom;
	});
	env.set("mod", (a: unknown, b: unknown) => {
		const denom = toNumber(b);
		return denom === 0 ? 0 : toNumber(a) % denom;
	});
	env.set("abs", (a: unknown) => Math.abs(toNumber(a)));
	env.set("round", (a: unknown) => Math.round(toNumber(a)));
	env.set("floor", (a: unknown) => Math.floor(toNumber(a)));
	env.set("ceil", (a: unknown) => Math.ceil(toNumber(a)));
	env.set("min", (...args: unknown[]) => (args.length === 0 ? 0 : Math.min(...args.map(toNumber))));
	env.set("max", (...args: unknown[]) => (args.length === 0 ? 0 : Math.max(...args.map(toNumber))));
	env.set("clamp", (v: unknown, lo: unknown, hi: unknown) => {
		const minV = toNumber(lo);
		const maxV = toNumber(hi);
		return Math.max(minV, Math.min(maxV, toNumber(v)));
	});
	env.set("ratio", (v: unknown, lo: unknown, hi: unknown) => {
		const minV = toNumber(lo);
		const maxV = toNumber(hi);
		const span = maxV - minV;
		return span === 0 ? 1 : (toNumber(v) - minV) / span;
	});

	// Compare -------------------------------------------------------------
	env.set("<", (a: unknown, b: unknown) => toNumber(a) < toNumber(b));
	env.set(">", (a: unknown, b: unknown) => toNumber(a) > toNumber(b));
	env.set("<=", (a: unknown, b: unknown) => toNumber(a) <= toNumber(b));
	env.set(">=", (a: unknown, b: unknown) => toNumber(a) >= toNumber(b));
	env.set("=", (a: unknown, b: unknown) => {
		if (a === b) return true;
		if (typeof a === "number" || typeof b === "number") return toNumber(a) === toNumber(b);
		return false;
	});
	env.set("not", (a: unknown) => !a);
	env.set("and", (...args: unknown[]) => args.every(Boolean));
	env.set("or", (...args: unknown[]) => args.find(Boolean) ?? false);

	// Strings -------------------------------------------------------------
	env.set("str", (...args: unknown[]) => {
		let out = "";
		for (const arg of args) {
			out += stringifyAtom(arg);
			checkStringLength(out.length, limits);
		}
		return out;
	});
	env.set("join", (sep: unknown, list: unknown) => {
		if (!Array.isArray(list)) return "";
		const sepStr = stringifyAtom(sep);
		let out = "";
		for (let i = 0; i < list.length; i++) {
			if (i > 0) out += sepStr;
			out += stringifyAtom(list[i]);
			checkStringLength(out.length, limits);
		}
		return out;
	});
	env.set("repeat", (s: unknown, count: unknown) => {
		const text = stringifyAtom(s);
		const n = Math.max(0, Math.floor(toNumber(count)));
		const total = text.length * n;
		checkStringLength(total, limits);
		return text.repeat(n);
	});
	env.set("pad", (s: unknown, width: unknown, fill?: unknown) => {
		const target = Math.max(0, Math.floor(toNumber(width)));
		checkStringLength(target, limits);
		const fillStr = fill === undefined ? " " : stringifyAtom(fill);
		return toStringSafe(s, limits).padStart(target, fillStr || " ");
	});
	env.set("pad-end", (s: unknown, width: unknown, fill?: unknown) => {
		const target = Math.max(0, Math.floor(toNumber(width)));
		checkStringLength(target, limits);
		const fillStr = fill === undefined ? " " : stringifyAtom(fill);
		return toStringSafe(s, limits).padEnd(target, fillStr || " ");
	});

	// Lists ---------------------------------------------------------------
	env.set("len", (value: unknown) => {
		if (Array.isArray(value)) return value.length;
		if (typeof value === "string") return value.length;
		return 0;
	});
	env.set("nth", (list: unknown, index: unknown) => {
		if (!Array.isArray(list)) return undefined;
		const i = Math.floor(toNumber(index));
		if (i < 0 || i >= list.length) return undefined;
		return list[i];
	});
	env.set("list", (...args: unknown[]) => {
		checkListLength(args.length, limits);
		return args;
	});
	env.set("append", (list: unknown, item: unknown) => {
		if (!Array.isArray(list)) return [item];
		checkListLength(list.length + 1, limits);
		return [...list, item];
	});
	env.set("slice", (list: unknown, start: unknown, end?: unknown) => {
		if (!isList(list)) return [];
		const startIdx = Math.floor(toNumber(start));
		const endIdx = end === undefined ? list.length : Math.floor(toNumber(end));
		const out = list.slice(startIdx, endIdx);
		checkListLength(out.length, limits);
		return out;
	});
	env.set("swap", (list: unknown, a: unknown, b: unknown) => {
		if (!Array.isArray(list)) return list;
		checkListLength(list.length, limits);
		const out = list.slice();
		const i = Math.floor(toNumber(a));
		const j = Math.floor(toNumber(b));
		if (i >= 0 && i < out.length && j >= 0 && j < out.length) {
			const tmp = out[i];
			out[i] = out[j];
			out[j] = tmp;
		}
		return out;
	});
	env.set("splice-move", (list: unknown, from: unknown, to: unknown) => {
		if (!Array.isArray(list)) return list;
		checkListLength(list.length, limits);
		const out = list.slice();
		const i = Math.floor(toNumber(from));
		const j = Math.floor(toNumber(to));
		if (i < 0 || i >= out.length || j < 0 || j >= out.length || i === j) return out;
		const [item] = out.splice(i, 1);
		out.splice(j, 0, item);
		return out;
	});

	// Objects -------------------------------------------------------------
	env.set("field", (obj: unknown, key: unknown) => {
		const keyStr = stringifyAtom(key);
		try {
			return safeFieldRead(obj, keyStr);
		} catch (err) {
			if (err instanceof EvaluationError) return undefined;
			throw err;
		}
	});
}

export { stringifyAtom };

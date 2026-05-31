/**
 * Module compiler.
 *
 * `compileModule(source)` parses the DSL source and lowers every
 * `defcomponent` / `defview` form into a typed definition usable by the
 * runtime. Per-form caps from {@link DstuiLimits} fire as
 * {@link CompileLimitError} so a hostile module cannot register hundreds of
 * timers or bindings before instantiation.
 */

import { isKw, isList, isSym, type SExpr, Sym } from "./ast";
import { CompileError, CompileLimitError } from "./errors";
import { assertSafeKey } from "./evaluator";
import { DEFAULT_LIMITS, type DstuiLimits, resolveLimits } from "./limits";
import { parse } from "./parser";

/** Compiled `defview` form: a pure layout fragment. */
export interface ViewDef {
	name: string;
	params: string[];
	body: SExpr;
}

/** Compiled `defcomponent` form: interactive UI with state, view, bindings, and timers. */
export interface ComponentDef {
	name: string;
	params: string[];
	stateDefs: Array<{ name: string; expr: SExpr }>;
	viewExpr: SExpr;
	bindings: Array<{ key: string; body: SExpr }>;
	timers: Array<{ ms: SExpr; body: SExpr }>;
}

/** Compiled module: every `defcomponent` and `defview` in source order. */
export interface ModuleDef {
	components: ComponentDef[];
	views: ViewDef[];
}

/** Options for {@link compileModule}. */
export interface CompileOptions {
	/** Overlay onto {@link DEFAULT_LIMITS}. */
	limits?: Partial<DstuiLimits>;
}

function readParams(expr: SExpr | undefined, limits: Readonly<DstuiLimits>): string[] {
	if (!isList(expr)) return [];
	const out: string[] = [];
	for (const p of expr) {
		if (!(p instanceof Sym)) continue;
		assertSafeKey(p.name);
		out.push(p.name);
		if (out.length > limits.maxParams) {
			throw new CompileLimitError(`parameter count exceeded maxParams (${limits.maxParams})`);
		}
	}
	return out;
}

function compileComponentForm(expr: SExpr[], limits: Readonly<DstuiLimits>): ComponentDef {
	const name = isSym(expr[1]) ? expr[1].name : null;
	if (!name) {
		throw new CompileError("defcomponent must have a name symbol");
	}
	assertSafeKey(name);
	const params = readParams(expr[2], limits);

	const stateDefs: ComponentDef["stateDefs"] = [];
	let viewExpr: SExpr = [new Sym("col")];
	const bindings: ComponentDef["bindings"] = [];
	const timers: ComponentDef["timers"] = [];

	for (let i = 3; i < expr.length; i++) {
		const form = expr[i];
		if (!isList(form) || form.length === 0) continue;
		const head = form[0];
		if (isSym(head, "state")) {
			for (let j = 1; j < form.length; j++) {
				const binding = form[j];
				if (isList(binding) && binding.length >= 2 && isSym(binding[0])) {
					assertSafeKey(binding[0].name);
					stateDefs.push({ name: binding[0].name, expr: binding[1] ?? null });
					if (stateDefs.length > limits.maxState) {
						throw new CompileLimitError(`state slot count exceeded maxState (${limits.maxState})`);
					}
				}
			}
			continue;
		}
		if (isSym(head, "view")) {
			viewExpr = form.length === 2 ? (form[1] ?? null) : [new Sym("col"), ...form.slice(1)];
			continue;
		}
		if (isSym(head, "bind")) {
			const keyForm = form[1];
			let key: string | null = null;
			if (isKw(keyForm)) key = keyForm.name;
			else if (typeof keyForm === "string") key = keyForm;
			else if (isSym(keyForm)) key = keyForm.name;
			if (!key) {
				throw new CompileError("bind requires a keyword key (e.g. :enter)");
			}
			bindings.push({
				key,
				body: form.length === 3 ? (form[2] ?? null) : [new Sym("do"), ...form.slice(2)],
			});
			if (bindings.length > limits.maxBindings) {
				throw new CompileLimitError(`binding count exceeded maxBindings (${limits.maxBindings})`);
			}
			continue;
		}
		if (isSym(head, "every")) {
			if (form.length < 3) {
				throw new CompileError("every requires (every MS BODY...)");
			}
			timers.push({
				ms: form[1] ?? 0,
				body: form.length === 3 ? (form[2] ?? null) : [new Sym("do"), ...form.slice(2)],
			});
			if (timers.length > limits.maxTimers) {
				throw new CompileLimitError(`timer count exceeded maxTimers (${limits.maxTimers})`);
			}
		}
		// Unknown form inside defcomponent: ignored, per the original DSL's tolerance.
	}

	return { name, params, stateDefs, viewExpr, bindings, timers };
}

function compileViewForm(expr: SExpr[], limits: Readonly<DstuiLimits>): ViewDef {
	const name = isSym(expr[1]) ? expr[1].name : null;
	if (!name) {
		throw new CompileError("defview must have a name symbol");
	}
	assertSafeKey(name);
	const params = readParams(expr[2], limits);
	const body: SExpr = expr.length === 4 ? (expr[3] ?? null) : [new Sym("col"), ...expr.slice(3)];
	return { name, params, body };
}

/** Compile DSL source into a {@link ModuleDef}. Throws on malformed source. */
export function compileModule(source: string, options: CompileOptions = {}): ModuleDef {
	const limits = resolveLimits(options.limits);
	const { exprs } = parse(source, { limits });
	const components: ComponentDef[] = [];
	const views: ViewDef[] = [];

	for (const expr of exprs) {
		if (!isList(expr) || expr.length === 0) continue;
		const head = expr[0];
		if (isSym(head, "defcomponent")) {
			components.push(compileComponentForm(expr, limits));
			if (components.length > limits.maxComponentsPerModule) {
				throw new CompileLimitError(
					`component count exceeded maxComponentsPerModule (${limits.maxComponentsPerModule})`,
				);
			}
		} else if (isSym(head, "defview")) {
			views.push(compileViewForm(expr, limits));
			if (views.length > limits.maxViewsPerModule) {
				throw new CompileLimitError(`view count exceeded maxViewsPerModule (${limits.maxViewsPerModule})`);
			}
		}
	}

	if (components.length === 0 && views.length === 0) {
		throw new CompileError("module must declare at least one (defcomponent ...) or (defview ...)");
	}

	return { components, views };
}

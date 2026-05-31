/**
 * Component runtime.
 *
 * `instantiate(def, config, options)` materializes a {@link ComponentDef}
 * into a live overlay-ready {@link ComponentInstance}. The instance owns its
 * environment, its evaluation {@link Budget}, every `(every ...)` timer, and
 * the settle state. `emit` / `cancel` are idempotent and tear down timers on
 * the first call. `dispose()` is safe at any moment.
 *
 * The runtime is deliberately UI-agnostic. The chunk-2 `@oh-my-pi/pi-tui`
 * adapter calls `instance.render(width)` and `instance.handleInput(data)`
 * from inside an `ExtensionUIContext.custom` factory and forwards the
 * settle promise back to the agent loop.
 */

import { isList, isSym, type SExpr } from "./ast";
import { installBuiltins } from "./builtins";
import type { ComponentDef, ModuleDef, ViewDef } from "./compiler";
import { CompileLimitError, RuntimeError } from "./errors";
import { assertSafeKey, Budget, CANCEL_SLOT, EMIT_SLOT, Env, evaluate } from "./evaluator";
import { isCancelKey, matchKey } from "./keys";
import { buildLayout, flatten, renderNode, type ViewLookup } from "./layout";
import { DEFAULT_LIMITS, type DstuiLimits, resolveLimits } from "./limits";

/** Settle reasons returned to the host. */
export type SettleReason = "emit" | "cancel";

/** Notification fired exactly once per instance lifetime. */
export interface SettleEvent {
	reason: SettleReason;
	/** Value passed to `(emit ...)`, or `null` on `(cancel)`. */
	value: unknown;
}

/** Optional callbacks passed into {@link instantiate}. */
export interface InstanceOptions {
	/** Overlay onto {@link DEFAULT_LIMITS}. */
	limits?: Partial<DstuiLimits>;
	/** Called whenever timers or bindings mutate state and the host should re-render. */
	onRender?: () => void;
	/** Called when the component settles (`emit` / `cancel`). Fires exactly once. */
	onSettled?: (event: SettleEvent) => void;
	/** Called when DSL evaluation throws. Defaults to silent drop so a misbehaving timer cannot kill the loop. */
	onError?: (error: unknown) => void;
	/** Optional clock for tests — defaults to globalThis `setInterval` / `clearInterval`. */
	clock?: TimerClock;
}

/** Platform timer handle. */
type TimerHandle = ReturnType<typeof setInterval>;

/** Pluggable timer clock for tests. */
export interface TimerClock {
	setInterval(handler: () => void, intervalMs: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
}

const DEFAULT_CLOCK: TimerClock = {
	setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
	clearInterval: handle => clearInterval(handle),
};

/** Live overlay-ready component instance. */
export interface ComponentInstance {
	/** Render the current view at `width`. Resets the per-cycle eval budget. */
	render(width: number): string[];
	/** Feed a key sequence (raw or normalized) to the active component. */
	handleInput(data: string): void;
	/** True if the instance has already settled via `emit` or `cancel`. */
	isSettled(): boolean;
	/** Settle reason + value once settled; `undefined` before settle. */
	settleResult(): SettleEvent | undefined;
	/** Synchronously stop timers and release event listeners. Idempotent. */
	dispose(): void;
}

function buildViewLookup(views: ViewDef[]): ViewLookup {
	const byName: Record<string, ViewDef> = Object.create(null);
	for (const view of views) {
		assertSafeKey(view.name);
		byName[view.name] = view;
	}
	return (name: string): ViewDef | undefined => {
		if (!Object.hasOwn(byName, name)) return undefined;
		return byName[name];
	};
}

/** Materialize a single {@link ComponentDef} into a live instance. */
export function instantiate(
	def: ComponentDef,
	config: Readonly<Record<string, unknown>>,
	views: ReadonlyArray<ViewDef>,
	options: InstanceOptions = {},
): ComponentInstance {
	const limits = resolveLimits(options.limits);
	if (def.timers.length > limits.maxTimers) {
		throw new CompileLimitError(`timer count exceeded maxTimers (${limits.maxTimers})`);
	}

	const onRender = options.onRender ?? (() => {});
	const onSettled = options.onSettled;
	const onError = options.onError ?? (() => {});
	const clock = options.clock ?? DEFAULT_CLOCK;
	const lookup = buildViewLookup([...views]);

	const env = new Env();
	const budget = new Budget(limits);
	installBuiltins(env, limits);

	// Params first; `null` for any missing config entry. snake_case and
	// camelCase aliases for kebab-case DSL names so model-authored configs
	// can pass `selected-index`, `selected_index`, or `selectedIndex` without
	// thinking about it.
	for (const param of def.params) {
		const snake = param.replace(/-/g, "_");
		const camel = param.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
		const value = readConfigValue(config, param, snake, camel);
		env.set(param, value);
	}

	for (const slot of def.stateDefs) {
		env.set(slot.name, evaluate(slot.expr, env, budget));
	}

	let settled: SettleEvent | undefined;
	let disposed = false;
	const timers: TimerHandle[] = [];

	const teardownTimers = (): void => {
		for (const handle of timers) clock.clearInterval(handle);
		timers.length = 0;
	};

	const finish = (reason: SettleReason, value: unknown): void => {
		if (settled || disposed) return;
		settled = { reason, value };
		teardownTimers();
		if (onSettled) {
			try {
				onSettled(settled);
			} catch (err) {
				onError(err);
			}
		}
	};

	const emit = (value: unknown): void => finish("emit", value);
	const cancel = (): void => finish("cancel", null);

	env.set(EMIT_SLOT, emit);
	env.set(CANCEL_SLOT, cancel);

	// Timers: clamp to the minimum interval, cap count via maxTimers (already
	// checked at the top), catch every body error so a misbehaving DSL timer
	// cannot kill the host loop.
	for (const timer of def.timers) {
		budget.reset();
		const requested = Math.floor(Number(evaluate(timer.ms, env, budget)) || 0);
		const intervalMs = Math.max(limits.minTimerIntervalMs, requested);
		const handle = clock.setInterval(() => {
			if (settled || disposed) return;
			try {
				budget.reset();
				evaluate(timer.body, env, budget);
				if (!settled && !disposed) onRender();
			} catch (err) {
				onError(err);
			}
		}, intervalMs);
		timers.push(handle);
	}

	const render = (width: number): string[] => {
		if (disposed) return [];
		try {
			budget.reset();
			const root = buildLayout(def.viewExpr, env, budget, lookup);
			const grid = renderNode(root, env, budget, lookup, width);
			return flatten(grid, width, limits);
		} catch (err) {
			onError(err);
			return [];
		}
	};

	const handleInput = (data: string): void => {
		if (disposed || settled) return;
		if (isCancelKey(data)) {
			cancel();
			return;
		}
		for (const binding of def.bindings) {
			if (!matchKey(data, binding.key)) continue;
			try {
				budget.reset();
				evaluate(binding.body, env, budget);
				if (!settled && !disposed) onRender();
			} catch (err) {
				onError(err);
			}
			return;
		}
	};

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		teardownTimers();
	};

	return {
		render,
		handleInput,
		isSettled: () => settled !== undefined,
		settleResult: () => settled,
		dispose,
	};
}

function readConfigValue(
	config: Readonly<Record<string, unknown>>,
	primary: string,
	snake: string,
	camel: string,
): unknown {
	if (Object.hasOwn(config, primary)) return config[primary];
	if (snake !== primary && Object.hasOwn(config, snake)) return config[snake];
	if (camel !== primary && Object.hasOwn(config, camel)) return config[camel];
	return null;
}

/** Convenience: pick a component by name and instantiate it from a module. */
export function instantiateComponentByName(
	module: ModuleDef,
	componentName: string,
	config: Readonly<Record<string, unknown>>,
	options: InstanceOptions = {},
): ComponentInstance {
	const found = findComponent(module, componentName);
	if (!found) {
		throw new RuntimeError(`unknown component: ${componentName}`);
	}
	return instantiate(found, config, module.views, options);
}

function findComponent(module: ModuleDef, name: string): ComponentDef | undefined {
	for (const c of module.components) {
		if (c.name === name) return c;
	}
	return undefined;
}

/** Type-guard helper for callers that walk arbitrary SExprs (re-exported for symmetry). */
export function looksLikeViewCall(expr: SExpr): expr is SExpr[] {
	return isList(expr) && expr.length > 0 && isSym(expr[0]);
}

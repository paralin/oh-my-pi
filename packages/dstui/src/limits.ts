/**
 * Resource limits for the DSL runtime.
 *
 * The parser, compiler, evaluator, and layout/render pipeline all consult the
 * same {@link DstuiLimits} object so a host can dial the budget up or down for
 * a particular component without forking the runtime.
 *
 * All defaults assume the source is **untrusted, model-authored** DSL: caps
 * are tight enough to make a single overlay impossible to weaponize into a
 * CPU/memory hog, yet generous enough to express the bundled `radio-list` /
 * `rotary-encoder` / `progress-gauge` widgets without bumping into a limit.
 */

/** Total resource budget for one DSL module instance. */
export interface DstuiLimits {
	/** Max bytes accepted by {@link parse}. Anything larger is rejected before tokenization. */
	maxSourceBytes: number;
	/** Max nesting depth of `(...)` lists accepted by {@link parse}. */
	maxParseDepth: number;
	/** Max number of AST nodes (atoms + lists) produced by {@link parse}. */
	maxAstNodes: number;
	/** Max recursion depth of {@link evaluate} and {@link buildLayout}. */
	maxEvalDepth: number;
	/**
	 * Max number of `evaluate`/`buildLayout`/`renderNode` ticks per render or
	 * input cycle. The budget is reset at the start of every cycle so a long
	 * session does not amortize a single hostile render.
	 */
	maxEvalSteps: number;
	/** Max length of any string produced by the evaluator or returned from a builtin. */
	maxStringLength: number;
	/** Max length of any array produced or returned by a builtin. */
	maxListLength: number;
	/** Max number of rows in rendered output. Extra rows are dropped. */
	maxOutputRows: number;
	/** Max number of cells per row in rendered output. Extra cells are dropped. */
	maxOutputColumns: number;
	/** Max number of `(every ...)` timers a single component may register. */
	maxTimers: number;
	/** Minimum interval (ms) accepted by `(every ...)`. Smaller values are clamped up. */
	minTimerIntervalMs: number;
	/** Max number of `(bind ...)` forms accepted by a single component. */
	maxBindings: number;
	/** Max number of `(state ...)` slots accepted by a single component. */
	maxState: number;
	/** Max number of `defcomponent` forms per module. */
	maxComponentsPerModule: number;
	/** Max number of `defview` forms per module. */
	maxViewsPerModule: number;
	/** Max number of params on a `defcomponent` or `defview`. */
	maxParams: number;
}

/** Conservative defaults sized for model-authored UI source. */
export const DEFAULT_LIMITS: Readonly<DstuiLimits> = Object.freeze({
	maxSourceBytes: 64 * 1024,
	maxParseDepth: 128,
	maxAstNodes: 8192,
	maxEvalDepth: 256,
	maxEvalSteps: 100_000,
	maxStringLength: 16 * 1024,
	maxListLength: 4096,
	maxOutputRows: 256,
	maxOutputColumns: 512,
	maxTimers: 8,
	minTimerIntervalMs: 50,
	maxBindings: 64,
	maxState: 64,
	maxComponentsPerModule: 32,
	maxViewsPerModule: 32,
	maxParams: 32,
});

/** Merge a partial overlay onto {@link DEFAULT_LIMITS}, returning a frozen result. */
export function resolveLimits(overlay?: Partial<DstuiLimits>): Readonly<DstuiLimits> {
	if (!overlay) return DEFAULT_LIMITS;
	return Object.freeze({ ...DEFAULT_LIMITS, ...overlay });
}

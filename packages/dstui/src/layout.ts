/**
 * Layout / render pipeline.
 *
 * `buildLayout` walks an S-expression view tree under the active {@link Env}
 * and {@link Budget} and produces a {@link LayoutNode} tree. `renderNode`
 * lays each node out onto a cell grid using `flex-row` / `flex-col` /
 * `grid` / `item` semantics, and `flatten` collapses the grid back into a
 * `string[]` ready for a TUI host.
 *
 * Output is bounded by {@link DstuiLimits.maxOutputRows} and
 * {@link DstuiLimits.maxOutputColumns}: extra rows are dropped, extra cells
 * are truncated, so a hostile DSL module can never produce more output bytes
 * than `rows * (cols + style-overhead)`. Tabs are expanded to spaces inside
 * each text cell.
 */

import { isKw, isList, isSym, Kw, type SExpr, Sym } from "./ast";
import { stringifyAtom } from "./builtins";
import { type Budget, Env, evaluate } from "./evaluator";
import type { DstuiLimits } from "./limits";
import { applyStyle, resolveStyleName } from "./style";

/** A single rendered cell: one visible character and an optional style tag. */
interface Cell {
	char: string;
	style?: unknown;
}

type Grid = Cell[][];

/** Internal layout AST. Built once per `render(width)` from the view S-expression. */
export type LayoutNode =
	| { type: "empty" }
	| { type: "text"; text: string; style?: unknown }
	| {
			type: "bar";
			value: number;
			width: number;
			cursor: string;
			fill: string;
			empty: string;
			style?: unknown;
	  }
	| { type: "spacer"; size: number }
	| { type: "stack"; direction: "row" | "col"; gap: number; children: LayoutNode[] }
	| { type: "grid"; columns: number; gap: number; children: LayoutNode[] }
	| { type: "item"; basis: number; grow: number; children: LayoutNode[] }
	| { type: "each"; varName: string; listExpr: SExpr; body: SExpr };

/** Map of `defview` definitions reachable from a build. */
export type ViewLookup = (name: string) =>
	| {
			params: string[];
			body: SExpr;
	  }
	| undefined;

const TAB_REPLACEMENT = "   ";

function cell(char: string, style?: unknown): Cell {
	return { char, style };
}

function expandTabsInText(text: string): string {
	if (text.indexOf("\t") === -1) return text;
	return text.replaceAll("\t", TAB_REPLACEMENT);
}

function blankRow(width: number): Cell[] {
	const out: Cell[] = new Array(width);
	for (let i = 0; i < width; i++) out[i] = cell(" ");
	return out;
}

function textCells(text: string, style?: unknown, maxCols = Number.POSITIVE_INFINITY): Cell[] {
	const cleaned = expandTabsInText(text);
	const chars = [...cleaned];
	const limit = Math.min(chars.length, maxCols);
	const out: Cell[] = new Array(limit);
	for (let i = 0; i < limit; i++) out[i] = cell(chars[i] ?? " ", style);
	return out;
}

function gridWidth(grid: Grid): number {
	let max = 0;
	for (const row of grid) if (row.length > max) max = row.length;
	return max;
}

function padRow(row: Cell[], width: number): Cell[] {
	if (row.length >= width) return row.slice(0, width);
	return [...row, ...blankRow(width - row.length)];
}

function padGrid(grid: Grid, width: number): Grid {
	const out: Grid = new Array(grid.length);
	for (let i = 0; i < grid.length; i++) {
		const row = grid[i];
		out[i] = row ? padRow(row, width) : blankRow(width);
	}
	return out;
}

function hstack(grids: Grid[], gap: number, maxCols: number): Grid {
	if (grids.length === 0) return [[]];
	const widths = grids.map(gridWidth);
	let height = 1;
	for (const g of grids) if (g.length > height) height = g.length;
	const out: Grid = new Array(height);
	for (let y = 0; y < height; y++) {
		const row: Cell[] = [];
		for (let i = 0; i < grids.length; i++) {
			if (i > 0 && gap > 0) {
				for (let g = 0; g < gap; g++) {
					if (row.length >= maxCols) break;
					row.push(cell(" "));
				}
			}
			const source = grids[i]?.[y] ?? [];
			const padded = padRow(source, widths[i] ?? 0);
			for (let k = 0; k < padded.length; k++) {
				if (row.length >= maxCols) break;
				row.push(padded[k] as Cell);
			}
			if (row.length >= maxCols) break;
		}
		out[y] = row;
	}
	return out;
}

function vstack(grids: Grid[], gap: number, maxRows: number): Grid {
	const out: Grid = [];
	for (let i = 0; i < grids.length; i++) {
		if (i > 0 && gap > 0) {
			for (let g = 0; g < gap; g++) {
				if (out.length >= maxRows) return out;
				out.push([]);
			}
		}
		const g = grids[i] as Grid;
		for (const row of g) {
			if (out.length >= maxRows) return out;
			out.push(row);
		}
	}
	return out;
}

function sameStyle(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a instanceof Kw && b instanceof Kw && a.name === b.name) return true;
	if (typeof a === "string" && typeof b === "string" && a === b) return true;
	if (a instanceof Kw && typeof b === "string") return a.name === b;
	if (b instanceof Kw && typeof a === "string") return b.name === a;
	return false;
}

/** Flatten a styled grid into a `string[]`. */
export function flatten(grid: Grid, width: number, limits: Readonly<DstuiLimits>): string[] {
	const maxRows = Math.min(grid.length, limits.maxOutputRows);
	const out: string[] = new Array(maxRows);
	for (let r = 0; r < maxRows; r++) {
		const row = grid[r] ?? [];
		const cap = Math.min(row.length, width, limits.maxOutputColumns);
		const cells = row.slice(0, cap);
		// Drop trailing unstyled spaces so per-line padding doesn't leak into output.
		let end = cells.length;
		while (end > 0) {
			const last = cells[end - 1] as Cell;
			if (last.char === " " && !last.style) end -= 1;
			else break;
		}
		let line = "";
		let buffer = "";
		let currentStyle: unknown;
		for (let i = 0; i < end; i++) {
			const c = cells[i] as Cell;
			if (!sameStyle(currentStyle, c.style)) {
				if (buffer) line += applyStyle(currentStyle, buffer);
				currentStyle = c.style;
				buffer = "";
			}
			buffer += c.char;
		}
		if (buffer) line += applyStyle(currentStyle, buffer);
		out[r] = line;
	}
	return out;
}

/**
 * Split positional args from `:kw value` pairs. Named-arg storage uses a
 * null-prototype record so DSL keys cannot reach `Object.prototype`.
 */
function argsOf(args: SExpr[]): { positional: SExpr[]; named: Record<string, SExpr> } {
	const positional: SExpr[] = [];
	const named: Record<string, SExpr> = Object.create(null);
	let i = 0;
	while (i < args.length) {
		const arg = args[i];
		if (isKw(arg) && i + 1 < args.length) {
			named[arg.name] = args[i + 1] as SExpr;
			i += 2;
		} else {
			positional.push(arg as SExpr);
			i += 1;
		}
	}
	return { positional, named };
}

function resolveStyle(named: Record<string, SExpr>, env: Env, budget: Budget, positional: SExpr[] = []): unknown {
	let style: unknown = named.style ? evaluate(named.style, env, budget) : undefined;
	// Allow shorthand `:bold true` flags in addition to `:style :bold`.
	for (const styleName of [
		"bold",
		"dim",
		"muted",
		"accent",
		"red",
		"yellow",
		"green",
		"blue",
		"magenta",
		"cyan",
		"inverse",
	] as const) {
		const expr = named[styleName];
		if (expr !== undefined && evaluate(expr, env, budget)) style = new Kw(styleName);
	}
	if (style === undefined) {
		for (const part of positional) {
			if (isKw(part) && resolveStyleName(part)) return part;
		}
	}
	return style;
}

function buildSequence(forms: SExpr[], env: Env, budget: Budget, views: ViewLookup): LayoutNode {
	const children: LayoutNode[] = [];
	for (const form of forms) {
		const child = buildLayout(form, env, budget, views);
		if (child.type !== "empty") children.push(child);
	}
	if (children.length === 0) return { type: "empty" };
	if (children.length === 1) return children[0] as LayoutNode;
	return { type: "stack", direction: "col", gap: 0, children };
}

function callView(viewName: string, args: SExpr[], env: Env, budget: Budget, views: ViewLookup): LayoutNode {
	const view = views(viewName);
	if (!view) return { type: "empty" };
	budget.enter();
	try {
		const child = new Env(env);
		for (let i = 0; i < view.params.length; i++) {
			const param = view.params[i];
			if (!param) continue;
			const argExpr = args[i];
			child.set(param, argExpr === undefined ? null : evaluate(argExpr, env, budget));
		}
		return buildLayout(view.body, child, budget, views);
	} finally {
		budget.leave();
	}
}

/** Lower a view S-expression into a {@link LayoutNode}. */
export function buildLayout(expr: SExpr, env: Env, budget: Budget, views: ViewLookup): LayoutNode {
	budget.tick();
	if (!isList(expr) || expr.length === 0) return { type: "empty" };
	const head = expr[0];
	if (!isSym(head)) return { type: "empty" };
	const name = head.name;

	if (name === "use") {
		const target = expr[1];
		if (isSym(target)) return callView(target.name, expr.slice(2), env, budget, views);
		if (typeof target === "string") return callView(target, expr.slice(2), env, budget, views);
		return { type: "empty" };
	}

	if (name === "text") {
		const { positional, named } = argsOf(expr.slice(1));
		let text = "";
		for (const part of positional) {
			if (isKw(part) && resolveStyleName(part)) continue;
			text += stringifyAtom(evaluate(part, env, budget));
		}
		return {
			type: "text",
			text,
			style: resolveStyle(named, env, budget, positional),
		};
	}

	if (name === "bar") {
		const { positional, named } = argsOf(expr.slice(1));
		return {
			type: "bar",
			value: Number(evaluate(positional[0] ?? 0, env, budget)) || 0,
			width: named.width ? Math.max(1, Math.floor(Number(evaluate(named.width, env, budget)) || 0)) : 20,
			cursor: named.cursor ? stringifyAtom(evaluate(named.cursor, env, budget)) : "●",
			fill: named.fill ? stringifyAtom(evaluate(named.fill, env, budget)) : "━",
			empty: named.empty ? stringifyAtom(evaluate(named.empty, env, budget)) : "─",
			style: resolveStyle(named, env, budget),
		};
	}

	if (name === "spacer") {
		return { type: "spacer", size: Math.max(1, Math.floor(Number(evaluate(expr[1] ?? 1, env, budget)) || 1)) };
	}

	if (name === "row" || name === "col") {
		const { positional } = argsOf(expr.slice(1));
		const children: LayoutNode[] = [];
		for (const part of positional) {
			const child = buildLayout(part, env, budget, views);
			if (child.type !== "empty") children.push(child);
		}
		return { type: "stack", direction: name, gap: 0, children };
	}

	if (name === "flex-row" || name === "flex-col") {
		const { positional, named } = argsOf(expr.slice(1));
		const children: LayoutNode[] = [];
		for (const part of positional) {
			const child = buildLayout(part, env, budget, views);
			if (child.type !== "empty") children.push(child);
		}
		return {
			type: "stack",
			direction: name === "flex-row" ? "row" : "col",
			gap: named.gap ? Math.max(0, Math.floor(Number(evaluate(named.gap, env, budget)) || 0)) : 0,
			children,
		};
	}

	if (name === "grid") {
		const { positional, named } = argsOf(expr.slice(1));
		const children: LayoutNode[] = [];
		for (const part of positional) {
			const child = buildLayout(part, env, budget, views);
			if (child.type !== "empty") children.push(child);
		}
		return {
			type: "grid",
			columns: named.columns ? Math.max(1, Math.floor(Number(evaluate(named.columns, env, budget)) || 0)) : 2,
			gap: named.gap ? Math.max(0, Math.floor(Number(evaluate(named.gap, env, budget)) || 0)) : 2,
			children,
		};
	}

	if (name === "item") {
		const { positional, named } = argsOf(expr.slice(1));
		const children: LayoutNode[] = [];
		for (const part of positional) {
			const child = buildLayout(part, env, budget, views);
			if (child.type !== "empty") children.push(child);
		}
		return {
			type: "item",
			basis: named.basis ? Math.max(0, Math.floor(Number(evaluate(named.basis, env, budget)) || 0)) : 0,
			grow: named.grow ? Math.max(0, Math.floor(Number(evaluate(named.grow, env, budget)) || 0)) : 0,
			children,
		};
	}

	if (name === "each") {
		return {
			type: "each",
			varName: isSym(expr[1]) ? (expr[1] as Sym).name : "it",
			listExpr: expr[2] ?? null,
			body: expr.length > 4 ? [new Sym("do"), ...expr.slice(3)] : (expr[3] ?? null),
		};
	}

	if (name === "do") return buildSequence(expr.slice(1), env, budget, views);

	if (name === "let") {
		const child = new Env(env);
		const bindings = expr[1];
		if (isList(bindings)) {
			for (const binding of bindings) {
				if (isList(binding) && binding.length >= 2 && isSym(binding[0])) {
					child.set((binding[0] as Sym).name, evaluate(binding[1] ?? null, child, budget));
				}
			}
		}
		return buildSequence(expr.slice(2), child, budget, views);
	}

	if (name === "when") {
		return evaluate(expr[1] ?? null, env, budget)
			? buildSequence(expr.slice(2), env, budget, views)
			: { type: "empty" };
	}
	if (name === "if") {
		return buildLayout(
			evaluate(expr[1] ?? null, env, budget) ? (expr[2] ?? null) : (expr[3] ?? null),
			env,
			budget,
			views,
		);
	}

	if (name === "cond") {
		for (let i = 1; i < expr.length; i++) {
			const clause = expr[i];
			if (!isList(clause) || clause.length < 2) continue;
			if (isSym(clause[0], "else") || evaluate(clause[0] ?? null, env, budget)) {
				return buildSequence(clause.slice(1), env, budget, views);
			}
		}
		return { type: "empty" };
	}

	// Fallback: maybe a user-defined view called positionally.
	if (views(name)) return callView(name, expr.slice(1), env, budget, views);
	return { type: "empty" };
}

/** Render a layout tree into a styled grid of `Cell`s sized to `width`. */
export function renderNode(node: LayoutNode, env: Env, budget: Budget, views: ViewLookup, width: number): Grid {
	budget.tick();
	const limits = budget.limits;
	const maxRows = limits.maxOutputRows;
	const maxCols = Math.min(width, limits.maxOutputColumns);

	switch (node.type) {
		case "empty":
			return [];
		case "text":
			return [textCells(node.text, node.style, maxCols)];
		case "spacer": {
			const size = Math.min(node.size, maxRows);
			const out: Grid = new Array(size);
			for (let i = 0; i < size; i++) out[i] = [];
			return out;
		}
		case "bar": {
			const value = Math.max(0, Math.min(1, node.value));
			const barWidth = Math.min(node.width, maxCols);
			const pos = Math.round(value * Math.max(0, barWidth - 1));
			const row: Cell[] = new Array(barWidth);
			for (let i = 0; i < barWidth; i++) {
				if (i === pos) row[i] = cell(node.cursor, node.style);
				else if (i < pos) row[i] = cell(node.fill, node.style);
				else row[i] = cell(node.empty, new Kw("muted"));
			}
			return [row];
		}
		case "stack": {
			if (node.direction === "col") {
				const children = node.children.map(c => renderNode(c, env, budget, views, maxCols));
				return vstack(children, node.gap, maxRows);
			}
			const children = node.children;
			const basis = children.map(child => (child.type === "item" ? child.basis : 0));
			let fixedWidth = Math.max(0, children.length - 1) * node.gap;
			let totalGrow = 0;
			const staticGrids: Array<Grid | null> = new Array(children.length);
			for (let i = 0; i < children.length; i++) {
				const child = children[i] as LayoutNode;
				if (child.type === "item" && child.grow > 0) {
					totalGrow += child.grow;
					fixedWidth += basis[i] ?? 0;
					staticGrids[i] = null;
				} else if (child.type === "item") {
					const inner = vstack(
						child.children.map(part => renderNode(part, env, budget, views, child.basis || maxCols)),
						0,
						maxRows,
					);
					const sized = child.basis > 0 ? padGrid(inner, child.basis) : inner;
					staticGrids[i] = sized;
					fixedWidth += gridWidth(sized);
				} else {
					const g = renderNode(child, env, budget, views, maxCols);
					staticGrids[i] = g;
					fixedWidth += gridWidth(g);
				}
			}
			const remaining = Math.max(0, maxCols - fixedWidth);
			const out: Grid[] = new Array(children.length);
			let used = 0;
			let growSeen = 0;
			for (let i = 0; i < children.length; i++) {
				const child = children[i] as LayoutNode;
				if (child.type === "item" && child.grow > 0) {
					growSeen += child.grow;
					const extra =
						growSeen === totalGrow ? remaining - used : Math.floor((remaining * child.grow) / totalGrow);
					used += extra;
					const alloc = (child.basis ?? 0) + extra;
					const inner = vstack(
						child.children.map(part => renderNode(part, env, budget, views, alloc)),
						0,
						maxRows,
					);
					out[i] = padGrid(inner, alloc);
				} else {
					out[i] = staticGrids[i] ?? [];
				}
			}
			return hstack(out, node.gap, maxCols);
		}
		case "grid": {
			const cellWidth = Math.max(4, Math.floor((maxCols - Math.max(0, node.columns - 1) * node.gap) / node.columns));
			const rows: Grid[] = [];
			for (let i = 0; i < node.children.length; i += node.columns) {
				const chunk = node.children
					.slice(i, i + node.columns)
					.map(child => padGrid(renderNode(child, env, budget, views, cellWidth), cellWidth));
				rows.push(hstack(chunk, node.gap, maxCols));
			}
			return vstack(rows, 0, maxRows);
		}
		case "item": {
			const childWidth = node.basis || maxCols;
			return padGrid(
				vstack(
					node.children.map(child => renderNode(child, env, budget, views, childWidth)),
					0,
					maxRows,
				),
				childWidth,
			);
		}
		case "each": {
			const list = evaluate(node.listExpr, env, budget);
			if (!Array.isArray(list)) return [];
			const rows: Grid[] = [];
			let accumulated = 0;
			for (let idx = 0; idx < list.length; idx++) {
				if (accumulated >= maxRows) break;
				const child = new Env(env);
				child.set(node.varName, list[idx]);
				child.set("__index__", idx);
				const itemGrid = renderNode(buildLayout(node.body, child, budget, views), child, budget, views, maxCols);
				rows.push(itemGrid);
				accumulated += itemGrid.length;
			}
			return vstack(rows, 0, maxRows);
		}
	}
}

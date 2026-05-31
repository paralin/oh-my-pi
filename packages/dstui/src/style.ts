/**
 * Fixed ANSI style table for the DSL renderer.
 *
 * The table is intentionally tiny: extending it requires a code change, so
 * DSL source cannot inject arbitrary SGR sequences via `(text x :style …)`.
 * Renderer consumers compose the lines further (e.g. truncation, hyperlink
 * wrapping) at the `@oh-my-pi/pi-tui` Component boundary in the chunk-2 PR.
 */

import { Kw } from "./ast";

/** Names accepted by `(text … :style :NAME)` or `(text … :NAME)`. */
export type StyleName =
	| "bold"
	| "dim"
	| "muted"
	| "accent"
	| "red"
	| "yellow"
	| "green"
	| "blue"
	| "magenta"
	| "cyan"
	| "inverse";

const STYLE_OPEN: Readonly<Record<StyleName, string>> = Object.freeze({
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	muted: "\x1b[90m",
	accent: "\x1b[36m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	green: "\x1b[32m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	inverse: "\x1b[7m",
});

const STYLE_RESET = "\x1b[0m";

const STYLE_NAMES: ReadonlySet<string> = new Set(Object.keys(STYLE_OPEN));

/** Map a raw DSL style value (Kw or string) to its registered name, or `undefined`. */
export function resolveStyleName(style: unknown): StyleName | undefined {
	if (style instanceof Kw && STYLE_NAMES.has(style.name)) return style.name as StyleName;
	if (typeof style === "string" && STYLE_NAMES.has(style)) return style as StyleName;
	return undefined;
}

/** Wrap `text` in the SGR codes for `style`, or return `text` unchanged. */
export function applyStyle(style: unknown, text: string): string {
	const name = resolveStyleName(style);
	if (!name) return text;
	return `${STYLE_OPEN[name]}${text}${STYLE_RESET}`;
}

/** Read-only view of the registered style names (for tests and debugging). */
export function listStyleNames(): readonly StyleName[] {
	return Object.keys(STYLE_OPEN) as StyleName[];
}

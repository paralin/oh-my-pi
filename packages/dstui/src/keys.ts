/**
 * Key normalization.
 *
 * Inputs to {@link normalizeKey} can be raw terminal byte sequences (CSI
 * arrows, kitty keyboard protocol, vim-style letters in DSL bindings) or
 * already-normalized names (`"escape"`, `"up"`, `"ctrl+c"`). Output is
 * always a lowercase canonical name a `(bind :KEY …)` form can compare
 * against. {@link matchKey} also honors the hjkl/wasd aliases the DSL's
 * sample widgets use.
 */

const CTRL_NAME = ["ctrl+@", "ctrl+a", "ctrl+b", "ctrl+c", "ctrl+d", "ctrl+e", "ctrl+f", "ctrl+g"] as const;

/** Canonicalize a raw key sequence or a name into a lowercase key id. */
export function normalizeKey(data: string): string {
	const raw = data;
	const lower = raw.toLowerCase();

	if (raw === "\r" || raw === "\n" || lower === "return" || lower === "enter") return "enter";
	if (raw === "\u001b" || raw === "\u001b\u001b" || lower === "escape" || lower === "esc") return "escape";
	if (raw === "\t" || lower === "tab") return "tab";
	if (raw === " " || lower === "space") return "space";
	if (raw === "\u007f" || raw === "\b" || lower === "backspace") return "backspace";
	if (raw === "\u001b[3~" || lower === "delete") return "delete";

	const kitty = raw.match(/^\u001b\[([0-9]+)(?:;[0-9:]+)?u$/);
	if (kitty) {
		const codepoint = Number(kitty[1]);
		if (codepoint === 27) return "escape";
		if (codepoint === 13) return "enter";
		if (codepoint === 9) return "tab";
		if (codepoint === 32) return "space";
		if (codepoint === 127 || codepoint === 8) return "backspace";
		if (codepoint >= 33 && codepoint <= 126) return String.fromCharCode(codepoint).toLowerCase();
	}

	const csi = raw.match(/^\u001b\[[0-9;:]*([ABCDHF])$/);
	if (csi) {
		const final = csi[1];
		if (final === "A") return "up";
		if (final === "B") return "down";
		if (final === "C") return "right";
		if (final === "D") return "left";
		if (final === "H") return "home";
		if (final === "F") return "end";
	}

	const app = raw.match(/^\u001bO([ABCDHF])$/);
	if (app) {
		const final = app[1];
		if (final === "A") return "up";
		if (final === "B") return "down";
		if (final === "C") return "right";
		if (final === "D") return "left";
		if (final === "H") return "home";
		if (final === "F") return "end";
	}

	if (lower === "arrowup") return "up";
	if (lower === "arrowdown") return "down";
	if (lower === "arrowleft") return "left";
	if (lower === "arrowright") return "right";
	if (lower === "pageup" || lower === "page-up") return "page-up";
	if (lower === "pagedown" || lower === "page-down") return "page-down";

	if (raw.length === 2 && raw.startsWith("\u001b")) return `alt+${raw.slice(1).toLowerCase()}`;
	if (raw.length === 1) {
		const code = raw.charCodeAt(0);
		if (code === 3) return "ctrl+c";
		if (code === 4) return "ctrl+d";
		if (code >= 1 && code <= 7) return CTRL_NAME[code] ?? `ctrl+${String.fromCharCode(code + 96)}`;
		if (code >= 8 && code <= 26) return `ctrl+${String.fromCharCode(code + 96)}`;
		return lower;
	}

	return lower;
}

/** True if `data` matches a `(bind :KEY …)` entry. Honors hjkl/wasd aliases. */
export function matchKey(data: string, key: string): boolean {
	const normalized = normalizeKey(data);
	const wanted = key.toLowerCase();
	if (normalized === wanted) return true;
	if (wanted === "left" && (normalized === "h" || normalized === "a")) return true;
	if (wanted === "right" && (normalized === "l" || normalized === "d")) return true;
	if (wanted === "up" && normalized === "k") return true;
	if (wanted === "down" && normalized === "j") return true;
	return false;
}

/** True if `data` represents a session-killing keystroke (escape / ctrl+c / ctrl+d). */
export function isCancelKey(data: string): boolean {
	const key = normalizeKey(data);
	return key === "escape" || key === "ctrl+c" || key === "ctrl+d";
}

import { describe, expect, test } from "bun:test";
import { isCancelKey, matchKey, normalizeKey } from "../src/keys";

describe("normalizeKey", () => {
	test.each([
		["\r", "enter"],
		["\n", "enter"],
		["enter", "enter"],
		["\u001b", "escape"],
		["escape", "escape"],
		["\t", "tab"],
		[" ", "space"],
		["\u001b[A", "up"],
		["\u001b[B", "down"],
		["\u001b[C", "right"],
		["\u001b[D", "left"],
		["\u001bOA", "up"],
		["\u001b[27u", "escape"],
		["\u0003", "ctrl+c"],
		["\u0004", "ctrl+d"],
		["\u001b[3~", "delete"],
	])("normalizes %p → %p", (raw, expected) => {
		expect(normalizeKey(raw)).toBe(expected);
	});
});

describe("matchKey", () => {
	test("honors hjkl/wasd aliases", () => {
		expect(matchKey("h", "left")).toBe(true);
		expect(matchKey("a", "left")).toBe(true);
		expect(matchKey("l", "right")).toBe(true);
		expect(matchKey("d", "right")).toBe(true);
		expect(matchKey("j", "down")).toBe(true);
		expect(matchKey("k", "up")).toBe(true);
		expect(matchKey("\u001b[A", "up")).toBe(true);
		expect(matchKey("x", "up")).toBe(false);
	});
});

describe("isCancelKey", () => {
	test.each(["\u001b", "escape", "\u0003", "\u0004", "ctrl+c", "ctrl+d"])("cancels on %p", raw => {
		expect(isCancelKey(raw)).toBe(true);
	});
	test("does not cancel on enter or arrow keys", () => {
		expect(isCancelKey("\r")).toBe(false);
		expect(isCancelKey("\u001b[A")).toBe(false);
	});
});

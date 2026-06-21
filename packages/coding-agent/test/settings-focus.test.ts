import { describe, expect, it } from "bun:test";
import { Text, TUI, type Terminal, type TerminalAppearance } from "@oh-my-pi/pi-tui";
import { getEditorSurfaceFocusTarget } from "@oh-my-pi/pi-coding-agent/modes/controllers/editor-surface-focus";

class MemoryTerminal implements Terminal {
	readonly columns = 80;
	readonly rows = 24;
	readonly kittyProtocolActive = false;
	readonly kittyEnableSequence = null;
	readonly appearance = undefined;

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
}

const inertRenderScheduler = {
	now: () => 0,
	scheduleImmediate: () => {},
	scheduleRender: () => ({ cancel() {} }),
};

describe("settings overlay focus restore", () => {
	it("returns focus to a pending ask selector instead of the prompt editor", () => {
		const ui = new TUI(new MemoryTerminal(), false, { renderScheduler: inertRenderScheduler });
		const editor = new Text("editor", 0, 0);
		const settingsOverlay = new Text("settings", 0, 0);
		const askSelector = new Text("ask", 0, 0);
		const ctx = {
			editor,
			hookSelector: askSelector,
			hookInput: undefined,
			hookEditor: undefined,
		};

		ui.setFocus(editor);
		const overlay = ui.showOverlay(settingsOverlay, { fullscreen: true });

		ui.setFocus(askSelector);
		expect(ui.getFocused()).toBe(settingsOverlay);

		overlay.hide();
		ui.setFocus(getEditorSurfaceFocusTarget(ctx));

		expect(ui.getFocused()).toBe(askSelector);
	});
});

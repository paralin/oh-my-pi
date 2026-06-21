import type { Component } from "@oh-my-pi/pi-tui";

interface EditorSurfaceFocusContext {
	editor: Component;
	hookSelector?: Component;
	hookInput?: Component;
	hookEditor?: Component;
}

/** Returns the editor-surface component that should receive input after modal UI closes. */
export function getEditorSurfaceFocusTarget(ctx: EditorSurfaceFocusContext): Component {
	return ctx.hookSelector ?? ctx.hookInput ?? ctx.hookEditor ?? ctx.editor;
}

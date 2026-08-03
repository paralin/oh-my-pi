/**
 * TUI renderers for built-in tools.
 *
 * These provide rich visualization for tool calls and results in the TUI.
 */
import type { Component } from "@oh-my-pi/pi-tui";
import { editToolRenderer } from "../edit/renderer";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { goalToolRenderer } from "../goals/tools/goal-tool";
import { lspToolRenderer } from "../lsp/render";
import type { Theme } from "../modes/theme/theme";
import { taskToolRenderer } from "../task/renderer";
import { webSearchToolRenderer } from "../web/search/render";
import { askToolRenderer } from "./ask";
import { astEditToolRenderer } from "./ast-edit";
import { astGrepToolRenderer } from "./ast-grep";
import { bashToolRenderer } from "./bash";
import { browserToolRenderer } from "./browser/render";
import { computerToolRenderer } from "./computer-renderer";
import { cronCreateToolRenderer, cronDeleteToolRenderer, cronListToolRenderer } from "./cron";
import { debugToolRenderer } from "./debug";
import { evalToolRenderer } from "./eval-render";
import { githubToolRenderer } from "./gh-renderer";
import { globToolRenderer } from "./glob";
import { grepToolRenderer } from "./grep";
import { hubToolRenderer } from "./hub";
import { inspectImageToolRenderer } from "./inspect-image-renderer";
import { recallToolRenderer, reflectToolRenderer, retainToolRenderer } from "./memory-render";
import { readToolRenderer } from "./read";
import { resolveRenderer } from "./resolve";
import { thinkToolRenderer } from "./think";
import { todoToolRenderer } from "./todo";
import { createVibeToolRenderer } from "./vibe";
import { writeToolRenderer } from "./write";
import { setXdevRendererLookup } from "./xdev";

/**
 * Per-renderer opt-in for a full viewport replay when the first result
 * replaces a painted pending-call render. A predicate receives the painted
 * call args and render options so the repaint stays scoped to the pending
 * shapes that actually re-anchor (an over-eager replay wipes native
 * scrollback on direct terminals).
 */
export type FirstResultViewportRepaint = boolean | ((args: unknown, options: RenderResultOptions) => boolean);

export type ToolRenderer = {
	renderCall: (args: unknown, options: RenderResultOptions, theme: Theme) => Component;
	renderResult: (
		result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
		options: RenderResultOptions & { renderContext?: Record<string, unknown> },
		theme: Theme,
		args?: unknown,
	) => Component;
	mergeCallAndResult?: boolean;
	/** Render without background box, inline in the response flow */
	inline?: boolean;
	/**
	 * Whether the renderer's pending-call path visibly consumes
	 * `options.spinnerFrame`. Used to avoid scheduling repaint ticks for live
	 * partial calls whose bytes cannot change between spinner frames.
	 */
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether the renderer's partial-result path visibly consumes
	 * `options.spinnerFrame`.
	 */
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
	/**
	 * Whether replacing a pending call render with the first result requires a
	 * full viewport repaint. Use for merged renderers whose pending rows can be
	 * re-anchored instead of preserved by the result render.
	 */
	forceFirstResultViewportRepaint?: FirstResultViewportRepaint;
	/**
	 * Whether settling a provisional partial result into the final render requires
	 * a full viewport repaint. Use when the result renderer changes chrome or
	 * frame topology at `options.isPartial: true -> false`.
	 */
	forceResultViewportRepaintOnSettle?: boolean;
};

/** Built on demand so each `vibe_*` lookup keeps a stable renderer identity. */
const vibeRenderers = new Map<string, ToolRenderer>();
function vibeRenderer(op: Parameters<typeof createVibeToolRenderer>[0]): ToolRenderer {
	let renderer = vibeRenderers.get(op);
	if (!renderer) {
		renderer = createVibeToolRenderer(op) as ToolRenderer;
		vibeRenderers.set(op, renderer);
	}
	return renderer;
}

/**
 * Every entry resolves its renderer through a lazy getter.
 *
 * Renderer modules form import cycles through sdk and tools/index. Deferring
 * each binding read until render time keeps module initialization independent
 * of import order.
 *
 * Getters remain own and enumerable. Each returns its shared renderer object,
 * which preserves aliases such as `apply_patch` and `edit`.
 */
export const toolRenderers: Record<string, ToolRenderer> = {
	get ask(): ToolRenderer {
		return askToolRenderer as ToolRenderer;
	},
	get ast_grep(): ToolRenderer {
		return astGrepToolRenderer as ToolRenderer;
	},
	get ast_edit(): ToolRenderer {
		return astEditToolRenderer as ToolRenderer;
	},
	get bash(): ToolRenderer {
		return bashToolRenderer as ToolRenderer;
	},
	get browser(): ToolRenderer {
		return browserToolRenderer as ToolRenderer;
	},
	get computer(): ToolRenderer {
		return computerToolRenderer as ToolRenderer;
	},
	get cron_create(): ToolRenderer {
		return cronCreateToolRenderer as ToolRenderer;
	},
	get cron_list(): ToolRenderer {
		return cronListToolRenderer as ToolRenderer;
	},
	get cron_delete(): ToolRenderer {
		return cronDeleteToolRenderer as ToolRenderer;
	},
	get debug(): ToolRenderer {
		return debugToolRenderer as ToolRenderer;
	},
	get eval(): ToolRenderer {
		return evalToolRenderer as ToolRenderer;
	},
	get edit(): ToolRenderer {
		return editToolRenderer as ToolRenderer;
	},
	get apply_patch(): ToolRenderer {
		return editToolRenderer as ToolRenderer;
	},
	get glob(): ToolRenderer {
		return globToolRenderer as ToolRenderer;
	},
	get grep(): ToolRenderer {
		return grepToolRenderer as ToolRenderer;
	},
	get lsp(): ToolRenderer {
		return lspToolRenderer as ToolRenderer;
	},
	get inspect_image(): ToolRenderer {
		return inspectImageToolRenderer as ToolRenderer;
	},
	get hub(): ToolRenderer {
		return hubToolRenderer as ToolRenderer;
	},
	get read(): ToolRenderer {
		return readToolRenderer as ToolRenderer;
	},
	// Keyed by xd:// resolution-device names: the write dispatch delegates here
	// by dispatch tool, and historical `resolve` tool transcripts still render
	// through the `resolve` entry. Both devices carry the same ResolveDetails.
	get resolve(): ToolRenderer {
		return resolveRenderer as ToolRenderer;
	},
	get reject(): ToolRenderer {
		return resolveRenderer as ToolRenderer;
	},
	get retain(): ToolRenderer {
		return retainToolRenderer as ToolRenderer;
	},
	get recall(): ToolRenderer {
		return recallToolRenderer as ToolRenderer;
	},
	get reflect(): ToolRenderer {
		return reflectToolRenderer as ToolRenderer;
	},
	get task(): ToolRenderer {
		return taskToolRenderer as ToolRenderer;
	},
	get think(): ToolRenderer {
		return thinkToolRenderer as ToolRenderer;
	},
	get todo(): ToolRenderer {
		return todoToolRenderer as ToolRenderer;
	},
	get github(): ToolRenderer {
		return githubToolRenderer as ToolRenderer;
	},
	get goal(): ToolRenderer {
		return goalToolRenderer as ToolRenderer;
	},
	get web_search(): ToolRenderer {
		return webSearchToolRenderer as ToolRenderer;
	},
	get vibe_spawn(): ToolRenderer {
		return vibeRenderer("spawn");
	},
	get vibe_send(): ToolRenderer {
		return vibeRenderer("send");
	},
	get vibe_wait(): ToolRenderer {
		return vibeRenderer("wait");
	},
	get vibe_kill(): ToolRenderer {
		return vibeRenderer("kill");
	},
	get vibe_list(): ToolRenderer {
		return vibeRenderer("list");
	},
	get write(): ToolRenderer {
		return writeToolRenderer as ToolRenderer;
	},
};

// Wire the xd:// render delegation. Injected (instead of the xdev module
// importing this module) to avoid the renderers → tool modules → sdk →
// tools/index → xdev import cycle.
setXdevRendererLookup(name => toolRenderers[name]);

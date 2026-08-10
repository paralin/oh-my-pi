/**
 * Contract: renderInitialMessages renders the collapsed live DISPLAY TRANSCRIPT,
 * not the LLM context. The transcript comes from
 * `session.buildTranscriptSessionContext({ collapseCompactedHistory: true })`;
 * `sessionManager.buildSessionContext()` — the LLM-context builder — must not be
 * consulted for display.
 *
 * Also guards the cold-launch terminal cleanup: `omp` / `omp -c` leave the
 * previous run's transcript in native scrollback because the TUI's initial
 * paint preserves it, so the cold-launch render must request a
 * scrollback-clearing repaint (`clearTerminalHistory`).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { StrippedToolCallsPlaceholder } from "@oh-my-pi/pi-coding-agent/modes/components/stripped-tool-calls-placeholder";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext, StrippedToolCallsMarker } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { Container } from "@oh-my-pi/pi-tui";

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	// afterEach resets Settings, but renderInitialMessages reads the global
	// Settings (display.collapseCompacted) — re-init before every test.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

function makeEmptyContext(): SessionContext {
	return {
		messages: [],
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	};
}

/** Build a minimal InteractiveModeContext mock, returning spies for assertions. */
function makeCtx(): {
	ctx: InteractiveModeContext;
	transcriptSpy: Mock<(options?: { collapseCompactedHistory?: boolean }) => SessionContext>;
	llmContextSpy: Mock<() => SessionContext>;
	renderSessionContextSpy: Mock<(...args: unknown[]) => void>;
} {
	const transcriptSpy = vi.fn(() => makeEmptyContext());
	const llmContextSpy = vi.fn(() => makeEmptyContext());
	const renderSessionContextSpy = vi.fn();

	const ctx = {
		chatContainer: { clear: vi.fn(), addChild: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn(), disposeChildren: vi.fn() },
		pendingBashComponents: [],
		session: { buildTranscriptSessionContext: transcriptSpy },
		viewSession: {
			buildTranscriptSessionContext: transcriptSpy,
			sessionManager: {
				buildSessionContext: llmContextSpy,
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			buildSessionContext: llmContextSpy,
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
		},
		renderSessionContext: renderSessionContextSpy,
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
		resetTranscript: () => ctx.chatContainer.clear(),
	} as unknown as InteractiveModeContext;

	return { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy };
}

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: 1,
	};
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return { ...makeEmptyContext(), messages };
}

function makeRenderCtx(
	transcript: SessionContext,
	showImages = true,
	hideToolActivity = false,
): { ctx: InteractiveModeContext; chatContainer: Container } {
	const chatContainer = new Container();
	let helpers: UiHelpers;
	const ctx = {
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		transcriptMessageComponents: new WeakMap(),
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		updateEditorTopBorder: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		// Rebuild paths honor terminal.showImages since the native-image work;
		// keep it on so the image-replay contracts below stay meaningful.
		settings: {
			get: (key: string) => {
				if (key === "terminal.showImages") return showImages;
				if (key === "display.hideToolActivity") return hideToolActivity;
				return false;
			},
		},
		toolOutputExpanded: false,
		hideToolActivity,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		editor: { addToHistory: vi.fn() },
		viewSession: {
			buildTranscriptSessionContext: () => transcript,
			getToolByName: () => {
				throw new Error("historical replay must not resolve tools");
			},
			extensionRunner: undefined,
			sessionManager: {
				getEntries: vi.fn(() => []),
				getCwd: vi.fn(() => "/tmp"),
			},
		},
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync: vi.fn(() => ({
				hash: "hash",
				path: "/tmp/hash",
				displayPath: "/tmp/hash.png",
				ref: "blob:sha256:hash",
			})),
		},
		addMessageToChat: (message: AgentMessage, options?: { populateHistory?: boolean }) =>
			helpers.addMessageToChat(message, options),
		renderSessionContext: (
			context: SessionContext,
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => helpers.renderSessionContext(context, options),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, chatContainer };
}

describe("UiHelpers.renderInitialMessages — transcript source", () => {
	it("renders the collapsed live display transcript, never the LLM context", async () => {
		await Settings.init({ inMemory: true });
		const { ctx, transcriptSpy, llmContextSpy, renderSessionContextSpy } = makeCtx();
		const transcript = makeEmptyContext();
		transcriptSpy.mockReturnValue(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		expect(transcriptSpy).toHaveBeenCalledWith({ collapseCompactedHistory: true });
		expect(llmContextSpy).not.toHaveBeenCalled();
		expect(renderSessionContextSpy).toHaveBeenCalledWith(transcript, {
			updateFooter: true,
			populateHistory: true,
		});
	});
});

describe("UiHelpers.renderInitialMessages — clearTerminalHistory", () => {
	it("requests a scrollback-clearing repaint when clearTerminalHistory is set", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages({ clearTerminalHistory: true });
		expect(ctx.ui.requestRender).toHaveBeenCalledWith(true, { clearScrollback: true });
	});

	it("never clears scrollback when clearTerminalHistory is unset", async () => {
		await Settings.init({ inMemory: true });
		const { ctx } = makeCtx();
		new UiHelpers(ctx).renderInitialMessages();
		const clearedCall = (ctx.ui.requestRender as Mock<(...a: unknown[]) => void>).mock.calls.find(
			([force, opts]) => force === true && (opts as { clearScrollback?: boolean } | undefined)?.clearScrollback,
		);
		expect(clearedCall).toBeUndefined();
	});
});

describe("UiHelpers.renderInitialMessages — hidden tool activity", () => {
	it("hides replayed tool cards without discarding them from the persisted transcript", () => {
		const toolCallId = "replayed-hidden-tool";
		const toolArgumentMarker = "REPLAYED TOOL ARGUMENT MARKER";
		const toolResultMarker = "REPLAYED TOOL RESULT MARKER";
		const narrationMarker = "ASSISTANT NARRATION STAYS VISIBLE";
		const finalMarker = "FINAL ASSISTANT RESPONSE STAYS VISIBLE";
		const transcript = transcriptWith([
			{
				...assistantToolCall(toolCallId, "contract_probe", { value: toolArgumentMarker }),
				content: [
					{ type: "text", text: narrationMarker },
					{ type: "toolCall", id: toolCallId, name: "contract_probe", arguments: { value: toolArgumentMarker } },
				],
			},
			{
				role: "toolResult",
				toolCallId,
				toolName: "contract_probe",
				content: [{ type: "text", text: toolResultMarker }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: finalMarker }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "stop",
				timestamp: 3,
			},
		]);

		const hidden = makeRenderCtx(transcript, true, true);
		new UiHelpers(hidden.ctx).renderInitialMessages();
		const hiddenRender = Bun.stripANSI(hidden.chatContainer.render(120).join("\n"));
		expect(hiddenRender).toContain(narrationMarker);
		expect(hiddenRender).toContain(finalMarker);
		expect(hiddenRender).not.toContain(toolArgumentMarker);
		expect(hiddenRender).not.toContain(toolResultMarker);

		const visible = makeRenderCtx(transcript, true, false);
		new UiHelpers(visible.ctx).renderInitialMessages();
		const visibleRender = Bun.stripANSI(visible.chatContainer.render(120).join("\n"));
		expect(visibleRender).toContain(toolArgumentMarker);
		expect(visibleRender).toContain(toolResultMarker);
	});

	it("hides the stripped-tool-calls placeholder with tool activity and restores it on reveal", () => {
		const strippedAssistant: AgentMessage & StrippedToolCallsMarker = {
			role: "assistant",
			content: [{ type: "text", text: "narration" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet",
			usage: emptyUsage,
			stopReason: "stop",
			timestamp: 1,
			strippedToolCalls: 2,
		};
		const transcript = transcriptWith([strippedAssistant]);

		const hidden = makeRenderCtx(transcript, true, true);
		new UiHelpers(hidden.ctx).renderInitialMessages();
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).not.toContain(
			"elided — no result on this branch",
		);

		// A live reveal must restore the placeholder without a transcript rebuild.
		for (const child of hidden.chatContainer.children) {
			if (child instanceof StrippedToolCallsPlaceholder) child.setToolActivityVisible(true);
		}
		expect(Bun.stripANSI(hidden.chatContainer.render(120).join("\n"))).toContain(
			"2 tool calls elided — no result on this branch",
		);
	});
});

describe("UiHelpers.renderSessionContext — error-stop tool calls", () => {
	it("keeps the synthetic assistant error result instead of replaying a later tool result", async () => {
		await Settings.init({ inMemory: true });
		const transcript = transcriptWith([
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "error-tool",
						name: "eval",
						arguments: { language: "py", code: "raise RuntimeError('boom')" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet",
				usage: emptyUsage,
				stopReason: "error",
				errorMessage: "synthetic assistant stop error",
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "error-tool",
				toolName: "eval",
				content: [{ type: "text", text: "late tool result must not replace the assistant stop error" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const { ctx, chatContainer } = makeRenderCtx(transcript);

		new UiHelpers(ctx).renderInitialMessages();

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("synthetic assistant stop error");
		expect(rendered).not.toContain("late tool result must not replace the assistant stop error");
	});
});

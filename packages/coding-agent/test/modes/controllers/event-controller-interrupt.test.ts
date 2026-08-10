import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";

function createContext() {
	const ensureLoadingAnimation = vi.fn();
	const session = {
		getToolByName: () => undefined,
		isAborting: false,
	};
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		transcriptMessageComponents: new WeakMap(),
		hideThinkingBlock: false,
		getUserMessageText: () => "new prompt",
		locallySubmittedUserSignatures: new Set<string>(),
		addMessageToChat: vi.fn(),
		editor: { setText: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		clearPinnedError: vi.fn(),
		ensureLoadingAnimation,
		ui: { requestRender: vi.fn() },
		session,
		viewSession: session,
	} as unknown as InteractiveModeContext;
	return { ctx, session };
}

const AGENT_START = { type: "agent_start" } as unknown as AgentSessionEvent;

describe("EventController aborted-turn working messages", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("preserves playback across internal continuations and clears it for a user message", async () => {
		const clear = vi.spyOn(vocalizer, "clear").mockImplementation(() => {});
		const { ctx } = createContext();
		const controller = new EventController(ctx);

		await controller.handleEvent(AGENT_START);
		await controller.handleEvent({ type: "turn_start" });
		expect(clear).not.toHaveBeenCalled();

		await controller.handleEvent({
			type: "message_start",
			message: {
				role: "user",
				content: [{ type: "text", text: "new prompt" }],
				attribution: "user",
				timestamp: Date.now(),
			},
		});
		expect(clear).toHaveBeenCalledTimes(1);
	});
});

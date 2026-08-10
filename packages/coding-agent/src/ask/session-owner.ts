import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import type { ToolSession } from "../session/tool-session";
import { vocalizer } from "../tts/vocalizer";
import type { AskOwner } from "./structured";

/** Binds shared structured-question behavior to the active session UI and settings. */
export function createSessionAskOwner(session: ToolSession, context?: AgentToolContext): AskOwner {
	return {
		hasUI: context?.hasUI === true && context.ui !== undefined,
		ui: context?.ui,
		timeoutSeconds: () => session.settings.get("ask.timeout"),
		notify: () => {
			if (session.settings.get("ask.notify") === "off") return;
			TERMINAL.sendNotification({
				title: "Oh My Pi",
				body: "Waiting for input",
				type: "ask",
				urgency: "normal",
				actions: "focus",
			});
		},
		speak: text => {
			if (session.settings.get("speech.enabled")) vocalizer.speak(text);
		},
		abort: () => context?.abort(),
	};
}

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/** True when persisted provider history contains removed provider-tool or Python-shortcut history. */
export function hasLegacyProviderToolCalls(messages: readonly AgentMessage[]): boolean {
	return messages.some(message => {
		if (message.role === "pythonExecution") return true;
		if (message.role === "toolResult") return message.toolName !== "ipython";
		if (message.role !== "assistant") return false;
		return message.content.some(content => content.type === "toolCall" && content.name !== "ipython");
	});
}

export const LEGACY_SESSION_ERROR =
	"This session contains removed tool or Python-shortcut calls and is read-only. Start a new IPython session to continue.";

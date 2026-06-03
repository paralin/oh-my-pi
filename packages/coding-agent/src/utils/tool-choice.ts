import type { Api, Model, ToolChoice } from "@oh-my-pi/pi-ai";

/**
 * Build a provider-aware tool choice that targets one specific tool when supported.
 * Providers that only expose required/any forcing may still honor named choices by
 * narrowing their request tool list before transport.
 */
export function buildNamedToolChoice(toolName: string, model?: Model<Api>): ToolChoice | undefined {
	if (!model) return undefined;

	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") {
		return { type: "tool", name: toolName };
	}

	if (
		model.api === "openai-codex-responses" ||
		model.api === "openai-responses" ||
		model.api === "openai-completions" ||
		model.api === "azure-openai-responses"
	) {
		return { type: "function", name: toolName };
	}

	if (model.api === "ollama-chat") {
		return { type: "function", name: toolName };
	}

	if (model.api === "google-generative-ai" || model.api === "google-gemini-cli" || model.api === "google-vertex") {
		return "required";
	}

	return undefined;
}

/**
 * Whether the given tool-choice can be served against the per-turn active tool set.
 * Non-named choices ("auto", "none", "any", "required", undefined) are always servable;
 * named choices ({type:"tool",name} / {type:"function",name|function.name}) require the
 * named tool to be present. Used by `AgentSession.nextToolChoice` to filter dequeued
 * directives whose target tool isn't in the current turn's serialized tools (issue #1701).
 */
export function isToolChoiceActive(
	toolChoice: ToolChoice | undefined,
	tools: ReadonlyArray<{ name: string }>,
): boolean {
	if (!toolChoice || typeof toolChoice === "string") return true;
	const name =
		toolChoice.type === "tool"
			? toolChoice.name
			: "function" in toolChoice
				? toolChoice.function.name
				: toolChoice.name;
	return tools.some(tool => tool.name === name);
}

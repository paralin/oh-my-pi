/**
 * The single `answer` tool.
 *
 * One tool, registered once, for every node of every graph. Its schema is
 * byte-identical for the whole walk, which is the point: tool definitions live
 * in the cached prompt prefix, so a per-node tool set invalidates the provider
 * cache at exactly the moment the walk is hottest. All per-node variation rides
 * in the appended user message, where tokens are cheap and change is expected.
 *
 * The option field is a plain string rather than a per-node enum for the same
 * reason. The node's question lists its legal options; the engine rejects
 * anything else with a tool error naming them.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";

/** What the model hands back at every node. */
export interface AnswerInput {
	option: string;
	why: string;
	payload?: Record<string, unknown>;
}

/** How the engine judged one answer. */
export type AnswerVerdict = { ok: true; message: string } | { ok: false; message: string };

/**
 * Build the walk's only tool.
 *
 * `judge` is the engine's per-node validation. It is a closure over mutable
 * walk state rather than a parameter, so the tool object itself never changes
 * and the serialized schema stays stable.
 */
export function createAnswerTool(judge: (input: AnswerInput) => Promise<AnswerVerdict>): AgentTool<any> {
	return {
		name: "answer",
		label: "Answer",
		description:
			"Answer the current step. Choose one of the options the step listed, say why, and supply the payload the step asked for.",
		parameters: z.object({
			option: z.string().describe("One of the options listed by the current step."),
			why: z.string().describe("Why this option and this payload, concretely, about this code."),
			payload: z
				.record(z.string(), z.any())
				.optional()
				.describe("The step's typed payload. Omit when the step asks for no payload."),
		}),
		execute: async (_id, params: AnswerInput) => {
			const verdict = await judge(params);
			return { content: [{ type: "text", text: verdict.message }], isError: !verdict.ok };
		},
	};
}

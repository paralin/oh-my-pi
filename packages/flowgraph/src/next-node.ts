/**
 * The `next_node` tool: the graph handed out one step at a time.
 *
 * The single-answer walk drives the graph from outside, appending each node's
 * question as a user message and ending the turn on every answer. This tool
 * moves the same state machine inside the session. One call answers the step the
 * walk currently occupies and returns the step it moved to, so the whole walk
 * runs inside one turn loop with one warm prefix and no per-node session setup.
 *
 * The schema is constant for the length of the walk, for the same reason
 * `answer` is: tool definitions live in the cached prompt prefix, so a per-node
 * schema would invalidate the cache at every step.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { z } from "@oh-my-pi/pi-ai";

/** Work-in-progress state a node carries across a context boundary. */
export interface WipState {
	/** What is true now, in observable terms. */
	progress: string;
	/** Threads that would otherwise be lost, each actionable on its own. */
	open: string[];
	/** Decisions, signatures, paths, and gotchas a fresh session would rediscover by reading. */
	facts: string[];
	/** The single next action, so a resumed session starts working instead of orienting. */
	next: string;
}

/** What the model hands back at every step. */
export interface NextNodeInput {
	option?: string;
	why?: string;
	payload?: Record<string, unknown>;
	state?: WipState;
}

/** One step as the tool describes it back to the session. */
export interface StepView {
	/** What the engine did with the previous answer, so a correction reads differently from an advance. */
	accepted: string;
	step: string;
	visit: number;
	prompt: string;
	whyQuestion?: string;
	/** JSON-shaped description of the step's typed blank, or null when it collects none. */
	payloadFormat: unknown;
	options: { option: string; description: string; payload?: string }[];
	/**
	 * The command this step will run before it may be left, stated up front.
	 *
	 * The session has real tools, so naming the gate before the step is answered
	 * lets it run the check itself and arrive with a passing tree. That is far
	 * cheaper than discovering the gate by failing it.
	 */
	gate: string[] | null;
	/** State dumped into this step by an earlier session, on resume. */
	state: WipState | null;
	/** The next answer must carry `state`: the context window is nearly full. */
	checkpointRequired: boolean;
}

/**
 * How the engine judged one call.
 *
 * An accepted answer normally hands back the next step. It hands back a bare
 * message instead when there is no next step, which is how a walk ends without
 * the last result reading like a rejection.
 */
export type StepVerdict = { ok: true; view: StepView } | { ok: true; message: string } | { ok: false; message: string };

const stateSchema = z.object({
	progress: z.string().min(1).describe("What is true now, in observable terms."),
	open: z.array(z.string()).describe("Open threads, each actionable on its own."),
	facts: z.array(z.string()).describe("Decisions, signatures, paths, and gotchas worth surviving."),
	next: z.string().min(1).describe("The single next action."),
});

/**
 * Build the walk's step tool.
 *
 * `judge` is a closure over mutable walk position rather than a parameter, so
 * the tool object never changes and its serialized schema stays stable.
 */
export function createNextNodeTool(judge: (input: NextNodeInput) => Promise<StepVerdict>): AgentTool<any> {
	return {
		name: "next_node",
		label: "Next step",
		description:
			"Answer the current step of the walk and receive the next one. Choose one of the options the current step listed, say why, and supply the payload it asked for. Call with no arguments to see the current step again.",
		parameters: z.object({
			option: z.string().optional().describe("One of the options listed by the current step."),
			why: z.string().optional().describe("Why this option and this payload, concretely, about this code."),
			payload: z
				.record(z.string(), z.any())
				.optional()
				.describe("The step's typed payload. Omit when the step asks for no payload."),
			state: stateSchema.optional().describe("Work-in-progress dump. Required only when the step asks for it."),
		}),
		execute: async (_id, params: NextNodeInput) => {
			const verdict = await judge(params);
			const text = "view" in verdict ? JSON.stringify(verdict.view, null, 1) : verdict.message;
			return { content: [{ type: "text", text }], isError: !verdict.ok };
		},
	};
}

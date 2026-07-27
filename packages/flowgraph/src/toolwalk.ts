/**
 * The tool-driven walk: one open session holding the graph as a tool.
 *
 * The single-answer walk ({@link ./walk}) runs the graph from outside the
 * session and spends a request per node on a model that cannot touch the
 * workspace. This engine keeps the graph and gives back the hands. The session
 * has ordinary tools, and one more, `next_node`: it answers the step it occupies
 * and receives the step it moved to, so the state machine runs inside the turn
 * loop instead of around it. One session, one warm prefix, no per-node setup.
 *
 * Two things change with it. The engine no longer renders the artifact, so a
 * payload is a typed declaration of what the session made true on disk rather
 * than the mechanism that made it true; the gate is what checks the claim. And
 * the same tool carries the walk across a context boundary: at a checkpoint the
 * session dumps its work-in-progress state into the node it occupies, the engine
 * starts a fresh session against the identical cached prefix, and primes it from
 * that state. The trajectory, not a transcript, is what continues.
 */
import { Agent, type AgentEvent, TERMINAL_TOOL_RESULT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { type Model, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import Handlebars from "handlebars";
import { emptyArtifact, type GoArtifact, resolvePackageName } from "./artifact";
import { DONE_NODE, ESCAPE_OPTION, type FlowNode, type IndexedGraph } from "./graph";
import { createNextNodeTool, type NextNodeInput, type StepVerdict, type StepView, type WipState } from "./next-node";
import { observe, runGate } from "./observe";
import { describePayload, validatePayload } from "./payload";
import { createToolbox } from "./toolbox";
import type { TrajectoryWriter, WalkUsage } from "./trajectory";
import type { WalkResult } from "./walk";

/** Everything a tool-driven walk needs that is not in the graph. */
export interface ToolWalkOptions {
	graph: IndexedGraph;
	walkId: string;
	/** Target directory. Every tool, observation, and gate is confined to it. */
	dir: string;
	task: string;
	model: Model;
	trajectory: TrajectoryWriter;
	reasoning?: SimpleStreamOptions["reasoning"];
	maxTokens?: number;
	/** Hard ceiling on node entries, which bounds cyclic graphs. */
	maxNodeEntries?: number;
	/** Hard ceiling on assistant turns, which bounds a session that stops answering. */
	maxTurns?: number;
	/** Fraction of the model's context window that triggers a state dump. */
	checkpointAt?: number;
	/** Where a resumed walk stands: the node it occupies and the state it dumped there. */
	resume?: { nodeId: string; state: WipState };
	onProgress?: (line: string) => void;
}

const DEFAULT_MAX_NODE_ENTRIES = 32;
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_CHECKPOINT_AT = 0.75;
/** Assumed window when the catalog does not state one, low enough to be safe. */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/** How a session is told to begin, once the entry step is already in front of it. */
const OPENING = `The walk has begun and you are standing in the step below. Do the step's work with your ordinary tools, then call \`next_node\` to answer it and receive the next step. Everything you need to know about the current step is in this message; every later step arrives as a \`next_node\` result.`;

/** What a session is told when it ends a turn without answering. */
const ANSWER_REQUIRED = `You have not answered the current step. Call \`next_node\` with the option you chose, why, and the payload the step asked for. If no option fits, answer \`escape\` and say why.`;

function emptyUsage(): WalkUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function nodeOptions(node: FlowNode) {
	return [
		...node.edges.map(edge => ({ option: edge.option, description: edge.description, payload: edge.payload })),
		{
			option: ESCAPE_OPTION,
			description: "No option above fits the work this task actually needs.",
			payload: undefined,
		},
	];
}

/** Render one step as the session receives it, whether in a message or a tool result. */
function renderStep(view: StepView): string {
	return `## Step: ${view.step}${view.visit > 1 ? ` (visit ${view.visit})` : ""}\n\n${JSON.stringify(view, null, 1)}`;
}

/**
 * Prime a fresh session from a node's dumped state.
 *
 * The system prompt, the orientation, and the tool schemas are the constant
 * prefix and do not move across a checkpoint, so this message is the only new
 * material a resumed session pays for. Everything else, the whole transcript of
 * reads, edits, and command output, is gone by construction rather than by
 * summarization.
 */
function renderResume(task: string, state: WipState, view: StepView): string {
	return [
		`## Resuming`,
		`An earlier session did the work below and ran out of context. You are continuing it. Nothing of its transcript survives; what it judged worth keeping is here.`,
		`Objective: ${task}`,
		`### Progress\n${state.progress}`,
		`### Open threads\n${state.open.map(line => `- ${line}`).join("\n") || "(none)"}`,
		`### Facts worth keeping\n${state.facts.map(line => `- ${line}`).join("\n") || "(none)"}`,
		`### Next action\n${state.next}`,
		`Read whatever you need to confirm this before acting on it, then continue from the step below.`,
		renderStep(view),
	].join("\n\n");
}

/**
 * Drive one session through the graph with `next_node` and return the outcome.
 */
export async function toolWalk(options: ToolWalkOptions): Promise<WalkResult> {
	const { graph, nodes } = options.graph;
	const maxNodeEntries = options.maxNodeEntries ?? DEFAULT_MAX_NODE_ENTRIES;
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	const checkpointAt = options.checkpointAt ?? DEFAULT_CHECKPOINT_AT;
	const contextWindow = options.model.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
	const usage = emptyUsage();
	// Observation still needs an artifact to describe; in this mode it stays
	// empty, because the files on disk are the artifact and the session wrote them.
	const artifact: GoArtifact = emptyArtifact("", await resolvePackageName(options.dir, graph.packageName));

	let node: FlowNode = nodes.get(options.resume?.nodeId ?? graph.entry) as FlowNode;
	if (!node) throw new Error(`walk cannot resume at unknown node: ${options.resume?.nodeId}`);
	let agent: Agent;
	let result: WalkResult | undefined;
	let nodesEntered = 0;
	let turns = 0;
	/** Set when the session must dump state before it may answer again. */
	let checkpointRequired = false;
	/** Set once a dump lands: the outer loop restarts the session from it. */
	let resumeFrom: WipState | undefined;
	let lastPromptTokens = 0;
	/** Prompt size the live session opened at, which is where a checkpoint returns it. */
	let sessionBaselineTokens = 0;
	const visits = new Map<string, number>();
	const nodeState = new Map<string, WipState>(options.resume ? [[options.resume.nodeId, options.resume.state]] : []);

	/** Enter a node and describe it, which is both the record and the tool result. */
	async function enter(accepted: string): Promise<StepView> {
		const visit = (visits.get(node.id) ?? 0) + 1;
		visits.set(node.id, visit);
		nodesEntered += 1;
		const instruction = Handlebars.compile(node.prompt, { noEscape: true })({
			task: options.task,
			dir: options.dir,
			visit,
		});
		const observations = await observe(node.context, options.dir, artifact);
		const view: StepView = {
			accepted,
			step: node.id,
			visit,
			prompt: observations ? `${instruction}\n\n${observations}` : instruction,
			whyQuestion: node.why,
			payloadFormat: node.payload === "none" ? null : JSON.parse(describePayload(node.payload)),
			options: nodeOptions(node).map(entry => ({
				option: entry.option,
				description: entry.description,
				payload: entry.payload ?? (node.payload === "none" ? undefined : node.payload),
			})),
			gate: node.gate?.command ?? null,
			state: nodeState.get(node.id) ?? null,
			checkpointRequired,
		};
		options.trajectory.write({
			type: "node_enter",
			nodeId: node.id,
			visit,
			prompt: view.prompt,
			payload: node.payload,
			options: view.options.map(entry => entry.option),
		});
		options.onProgress?.(`-> ${node.id} (visit ${visit})`);
		return view;
	}

	function finish(status: WalkResult["status"], error?: string): WalkResult {
		options.trajectory.write({
			type: "walk_end",
			walkId: options.walkId,
			status,
			finalNodeId: node.id,
			nodesEntered,
			usage,
			...(error ? { error } : {}),
		});
		result = { status, finalNodeId: node.id, nodesEntered, usage, ...(error ? { error } : {}) };
		return result;
	}

	const nextNodeTool = createNextNodeTool(async (input: NextNodeInput): Promise<StepVerdict> => {
		// A dump is accepted at any time and required once the window is nearly
		// full, because the session that notices it is running out is the one that
		// still knows what mattered.
		if (input.state) {
			const forced = checkpointRequired;
			const visit = visits.get(node.id) ?? 1;
			nodeState.set(node.id, input.state);
			options.trajectory.write({
				type: "checkpoint",
				nodeId: node.id,
				visit,
				promptTokens: lastPromptTokens,
				contextWindow,
				forced,
				state: input.state,
			});
			options.onProgress?.(`   ${node.id} checkpoint${forced ? " (forced)" : ""}: ${input.state.next}`);
			checkpointRequired = false;
			// A required dump is the compaction boundary itself, so an answer riding
			// along with it does not pass. Applying it would carry the full window
			// into the next step and the boundary the dump exists to cross would
			// never be crossed: the walk would collect state it never resumes from.
			// The state is what survives, and the fresh session answers this step.
			if (!input.option || forced) {
				resumeFrom = input.state;
				agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
				return {
					ok: true,
					message: input.option
						? "state recorded; the window was full, so this answer was not applied. A fresh session continues from your state and answers this step."
						: "state recorded; the walk continues from it",
				};
			}
		}

		if (!input.option)
			return { ok: true, view: await describeCurrent("no answer given; here is the current step again") };
		if (checkpointRequired) {
			return {
				ok: false,
				message: "the context window is nearly full; call next_node with `state` before answering this step",
			};
		}

		const legal = nodeOptions(node).map(entry => entry.option);
		if (!legal.includes(input.option)) {
			return {
				ok: false,
				message: `unknown option ${JSON.stringify(input.option)}; legal here: ${legal.join(", ")}`,
			};
		}
		if (!input.why) return { ok: false, message: "every answer needs a `why`; say why this option and this payload" };

		if (input.option === ESCAPE_OPTION) {
			options.trajectory.write({
				type: "answer",
				nodeId: node.id,
				visit: visits.get(node.id) ?? 1,
				option: ESCAPE_OPTION,
				why: input.why,
				payload: {},
				applied: "left the graph",
			});
			finish("escaped");
			agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			return { ok: false, message: "the walk has ended: the graph does not fit this work" };
		}

		const taken = node.edges.find(edge => edge.option === input.option);
		const filled = input.payload !== undefined && Object.keys(input.payload).length > 0;
		const validated = validatePayload(filled ? node.payload : (taken?.payload ?? node.payload), input.payload);
		if (!validated.ok) {
			return { ok: false, message: `payload rejected, answer again with a corrected payload: ${validated.reason}` };
		}

		if (node.gate) {
			const cwd = node.gate.cwd === "." ? options.dir : `${options.dir}/${node.gate.cwd}`;
			const { ok: passed, output } = await runGate(node.gate.command, cwd, node.gate.emptyOutput);
			options.trajectory.write({
				type: "gate_result",
				nodeId: node.id,
				command: node.gate.command,
				ok: passed,
				output,
			});
			// Nothing rolls back: the session's own edits stand, so a failed gate is
			// an ordinary fix round rather than a lost answer.
			if (!passed) return { ok: false, message: `gate failed, fix the code and answer again:\n${output}` };
		}

		options.trajectory.write({
			type: "answer",
			nodeId: node.id,
			visit: visits.get(node.id) ?? 1,
			option: input.option,
			why: input.why,
			payload: input.payload ?? {},
			applied: validated.summary,
		});
		options.onProgress?.(`   ${node.id} --${input.option}--> ${taken?.to}`);

		if (!taken) return { ok: false, message: `unknown option: ${input.option}` };
		if (taken.to === DONE_NODE) {
			finish("done");
			agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			return { ok: true, message: "the walk is complete" };
		}
		if (nodesEntered >= maxNodeEntries) {
			finish("stuck", `node entry ceiling ${maxNodeEntries} reached`);
			agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			return { ok: false, message: "the walk has ended: node ceiling reached" };
		}

		const next = nodes.get(taken.to);
		if (!next) throw new Error(`walk reached unknown node: ${taken.to}`);
		node = next;
		return { ok: true, view: await enter(`${validated.summary}; advancing via ${input.option}`) };
	});

	/** Re-describe the node the walk occupies without counting a new entry. */
	async function describeCurrent(accepted: string): Promise<StepView> {
		const visit = visits.get(node.id) ?? 1;
		visits.set(node.id, visit - 1);
		nodesEntered -= 1;
		return enter(accepted);
	}

	agent = new Agent({
		streamFn: (model, context, streamOptions) =>
			streamSimple(model, context, {
				...streamOptions,
				maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
				reasoning: options.reasoning,
			}),
		initialState: {
			systemPrompt: [graph.systemPrompt, graph.orientation],
			model: options.model,
			tools: [...createToolbox(options.dir), nextNodeTool],
		},
	});

	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_end") turns += 1;
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		const messageUsage = event.message.usage;
		if (!messageUsage) return;
		usage.input += messageUsage.input;
		usage.output += messageUsage.output;
		usage.cacheRead += messageUsage.cacheRead;
		usage.cacheWrite += messageUsage.cacheWrite;
		usage.totalTokens += messageUsage.totalTokens;
		usage.cost += messageUsage.cost?.total ?? 0;
		// Prompt size, not turn count, is what decides a checkpoint: a graph that
		// reads large files fills its window early and a terse one may never.
		lastPromptTokens = messageUsage.input + messageUsage.cacheRead + messageUsage.cacheWrite;
		if (!sessionBaselineTokens) sessionBaselineTokens = lastPromptTokens;
		// Growth since this session opened is the second condition, and it is what
		// keeps a threshold set below the constant prefix from demanding a dump the
		// moment a fresh session speaks. A session sitting at its own baseline has
		// nothing a restart could reclaim.
		if (lastPromptTokens >= contextWindow * checkpointAt && lastPromptTokens > sessionBaselineTokens)
			checkpointRequired = true;
		options.trajectory.write({
			type: "request",
			nodeId: node.id,
			input: messageUsage.input,
			output: messageUsage.output,
			cacheRead: messageUsage.cacheRead,
			cacheWrite: messageUsage.cacheWrite,
			totalTokens: messageUsage.totalTokens,
			cost: messageUsage.cost?.total ?? 0,
		});
	});

	try {
		const opening = await enter("the walk begins here");
		let message = options.resume
			? renderResume(options.task, options.resume.state, opening)
			: `${OPENING}\n\nObjective: ${options.task}\n\n${renderStep(opening)}`;
		let silentTurns = 0;

		while (!result) {
			await agent.prompt(message);
			if (result) break;
			if (agent.state.error) return finish("error", agent.state.error);
			if (turns >= maxTurns) return finish("stuck", `turn ceiling ${maxTurns} reached`);

			if (resumeFrom) {
				// The dump is the whole of what crosses the boundary. Clearing the
				// session leaves the constant prefix in place, so the fresh one pays
				// for the primed message and nothing else.
				agent.clearMessages();
				message = renderResume(options.task, resumeFrom, await describeCurrent("resumed from your own state dump"));
				resumeFrom = undefined;
				sessionBaselineTokens = 0;
				silentTurns = 0;
				continue;
			}

			if (++silentTurns > 2) return finish("stuck", `node ${node.id} never answered`);
			message = ANSWER_REQUIRED;
		}
		return result;
	} catch (err) {
		return result ?? finish("error", err instanceof Error ? err.message : String(err));
	} finally {
		unsubscribe();
	}
}

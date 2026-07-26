/**
 * The walk engine: one LLM session driven node by node through one tool.
 *
 * Inversion of control is the whole point. The session never decides what to do
 * next: entering a node appends that node's question as a user message, and the
 * node is left only when the model calls `answer` with an option the graph drew,
 * a payload the node's kind accepts, and a passing deterministic gate.
 *
 * The tool surface never changes for the length of a walk. System prompt,
 * orientation, and the `answer` schema are set once at construction, which keeps
 * the provider's cached prefix byte-identical across every node; only appended
 * user messages vary. Per-node variation that used to live in a tool allowlist
 * now lives in the question, where change is cheap and expected.
 */
import { Agent, type AgentEvent, type AgentMessage, TERMINAL_TOOL_RESULT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { type Model, type SimpleStreamOptions, streamSimple } from "@oh-my-pi/pi-ai";
import Handlebars from "handlebars";
import { type AnswerInput, type AnswerVerdict, createAnswerTool } from "./answer";
import { emptyArtifact, type GoArtifact, writeArtifact } from "./artifact";
import { DONE_NODE, ESCAPE_OPTION, type FlowNode, type IndexedGraph } from "./graph";
import { observe, runGate } from "./observe";
import { applyPayload, describePayload, type PayloadKind } from "./payload";
import answerRequiredPrompt from "./prompts/answer-required.md" with { type: "text" };
import type { TrajectoryWriter, WalkUsage } from "./trajectory";

/**
 * How a node's request is assembled from the walk's past.
 *
 * `session` keeps one growing conversation, so every node re-reads the whole
 * history from the provider's cache. `ledger` replaces each finished node's
 * turn with its typed answer, which is smaller but rewrites history and so
 * invalidates the cache from the rewrite point. `stateless` sends the constant
 * prefix plus this node's question alone, carrying prior answers as text inside
 * that question: the cached prefix never moves and nothing is re-read.
 */
export type ContextMode = "session" | "ledger" | "stateless";

/** Everything a walk needs that is not in the graph. */
export interface WalkOptions {
	graph: IndexedGraph;
	/** Identifier for this run, tying the opening and closing records together. */
	walkId: string;
	/** Target directory. Every observation, gate, and artifact write is confined to it. */
	dir: string;
	/** The parent objective, interpolated into node prompts as `{{task}}`. */
	task: string;
	model: Model;
	trajectory: TrajectoryWriter;
	/** How much of the walk's past each node's request carries. */
	context?: ContextMode;
	/** Reasoning effort forwarded unchanged to each provider request. */
	reasoning?: SimpleStreamOptions["reasoning"];
	/** Per-request output cap, kept low so one runaway node cannot burn the budget. */
	maxTokens?: number;
	/** Hard ceiling on node entries, which bounds cyclic graphs. */
	maxNodeEntries?: number;
	/** Human-facing progress sink. Never the record of the walk. */
	onProgress?: (line: string) => void;
}

/** Outcome of a walk, mirroring the closing trajectory record. */
export interface WalkResult {
	status: "done" | "escaped" | "stuck" | "error";
	finalNodeId: string;
	nodesEntered: number;
	usage: WalkUsage;
	error?: string;
}

/** What the model committed at a node, straight from its `answer` call. */
interface NodeDecision {
	option: string;
	why: string;
	payload?: Record<string, unknown>;
	/** What applying the payload did to the artifact, for the record. */
	applied: string;
}

const DEFAULT_MAX_NODE_ENTRIES = 32;
const DEFAULT_MAX_TOKENS = 8192;
/** Nudges allowed when a node ends its turn without answering. */
const MAX_ANSWER_NUDGES = 2;

function emptyUsage(): WalkUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/** The options a node offers, always including the escape. */
function nodeOptions(node: FlowNode): { option: string; description: string; payload?: PayloadKind }[] {
	return [
		...node.edges.map(edge => ({ option: edge.option, description: edge.description, payload: edge.payload })),
		{ option: ESCAPE_OPTION, description: "No option above fits the work this task actually needs." },
	];
}

/** A node's question as asked, beside the one line worth keeping afterwards. */
interface Question {
	full: string;
	/** The authored ask with the observations stripped, for the compaction ledger. */
	brief: string;
}

/**
 * Compose one node's question.
 *
 * Everything that varies by node lands here: the gathered observations, the
 * authored instruction, the typed blank, and the legal options. Nothing about
 * the node reaches the model any other way.
 */
async function composeQuestion(
	node: FlowNode,
	visit: number,
	options: WalkOptions,
	artifact: GoArtifact,
	answered: readonly string[],
): Promise<Question> {
	const instruction = Handlebars.compile(node.prompt, { noEscape: true })({
		task: options.task,
		dir: options.dir,
		visit,
	});
	const heading = `## Step: ${node.id}${visit > 1 ? ` (visit ${visit})` : ""}`;
	const sections = [heading, instruction];

	// A stateless request has no conversation behind it, so the answers the walk
	// already holds travel in the question instead.
	if (options.context === "stateless" && answered.length > 0) {
		sections.push(`## Answered so far\n${answered.join("\n")}`);
	}

	const observations = await observe(node.context, options.dir, artifact);
	if (observations) sections.push(observations);

	if (node.payload !== "none") {
		sections.push(`## Payload\nAnswer with a \`payload\` of this shape:\n${describePayload(node.payload)}`);
	}
	if (node.why) sections.push(`## Why\nYour \`why\` must answer: ${node.why}`);

	// An option that collects something other than the node's blank says so
	// beside itself, so choosing it never means inventing a payload for it.
	const options_ = nodeOptions(node)
		.map(entry => {
			if (entry.payload === undefined || entry.payload === node.payload) return `- ${entry.option}: ${entry.description}`;
			const blank =
				entry.payload === "none"
					? "may be answered with no payload at all"
					: `may be answered with a \`${entry.payload}\` payload instead`;
			return `- ${entry.option}: ${entry.description} (${blank})`;
		})
		.join("\n");
	sections.push(`## Options\nCall \`answer\` with exactly one of:\n${options_}`);

	return { full: sections.join("\n\n"), brief: `${heading}\n\n${instruction}` };
}

/**
 * Rewrite a finished node's turn as the pair a later node actually needs: what
 * it was asked, and the typed answer it gave.
 *
 * Both sides shed what has served its purpose. The question keeps its authored
 * ask and drops the observations pasted into it, which the next node's own
 * observations supersede; the assistant's prose, thinking, and tool-call
 * scaffolding give way to the typed answer the engine already holds. Nothing is
 * guessed the way transcript summarization guesses, and the ledger stays
 * append-only so the growing prefix still caches.
 */
function digest(
	session: readonly AgentMessage[],
	from: number,
	question: Question,
	decision: NodeDecision,
	nodeId: string,
): AgentMessage[] {
	const asked = session[from];
	const spoke = [...session]
		.reverse()
		.find((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
	if (asked?.role !== "user" || !spoke) return [];
	const answered = JSON.stringify({
		step: nodeId,
		option: decision.option,
		why: decision.why,
		did: decision.applied,
	});
	return [
		{ ...asked, content: question.brief },
		{ ...spoke, content: [{ type: "text", text: answered }] },
	];
}

/**
 * Drive one session through the graph and return the outcome.
 *
 * The trajectory writer receives every record; the returned result is the same
 * information in the shape a caller needs to set an exit code.
 */
export async function walk(options: WalkOptions): Promise<WalkResult> {
	const { graph, nodes } = options.graph;
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxNodeEntries = options.maxNodeEntries ?? DEFAULT_MAX_NODE_ENTRIES;
	const usage = emptyUsage();
	const artifact = emptyArtifact("", graph.packageName);

	// Mutable walk position the tool's judge closes over. The tool object itself
	// is built once and never rebuilt, so its serialized schema cannot drift.
	let node: FlowNode = nodes.get(graph.entry) as FlowNode;
	let decision: NodeDecision | undefined;
	let agent: Agent;

	const answerTool = createAnswerTool(async (input: AnswerInput): Promise<AnswerVerdict> => {
		if (decision) return { ok: false, message: "this step is already answered; wait for the next step" };

		const legal = nodeOptions(node).map(entry => entry.option);
		if (!legal.includes(input.option)) {
			return {
				ok: false,
				message: `unknown option ${JSON.stringify(input.option)}; legal here: ${legal.join(", ")}`,
			};
		}
		if (input.option === ESCAPE_OPTION) {
			decision = { option: ESCAPE_OPTION, why: input.why, applied: "left the graph" };
			agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
			return { ok: true, message: "leaving the graph" };
		}

		// Snapshot before applying, so a failed gate leaves neither the artifact
		// nor the file carrying a half-accepted answer.
		const before = structuredClone(artifact);
		// An edge's kind is an alternative to the node's, not a replacement for
		// it: a fill-body loop can carry the last body out on the exit edge, and
		// can also leave empty-handed once nothing is left to carry.
		const taken = node.edges.find(e => e.option === input.option);
		const filled = input.payload !== undefined && Object.keys(input.payload).length > 0;
		const applied = applyPayload(filled ? node.payload : (taken?.payload ?? node.payload), input.payload, artifact);
		if (!applied.ok) {
			return { ok: false, message: `payload rejected, answer again with a corrected payload: ${applied.reason}` };
		}
		if (artifact.file) await writeArtifact(options.dir, artifact);

		if (node.gate) {
			const cwd = node.gate.cwd === "." ? options.dir : `${options.dir}/${node.gate.cwd}`;
			const { ok, output } = await runGate(node.gate.command, cwd, node.gate.emptyOutput);
			options.trajectory.write({ type: "gate_result", nodeId: node.id, command: node.gate.command, ok, output });
			if (!ok) {
				Object.assign(artifact, before);
				if (artifact.file) await writeArtifact(options.dir, artifact);
				return { ok: false, message: `gate failed, answer again with a corrected payload:\n${output}` };
			}
		}

		decision = { option: input.option, why: input.why, payload: input.payload, applied: applied.summary };
		agent.abort(TERMINAL_TOOL_RESULT_ABORT_REASON);
		return { ok: true, message: `${applied.summary}; advancing via ${input.option}` };
	});

	agent = new Agent({
		streamFn: (model, context, streamOptions) =>
			streamSimple(model, context, { ...streamOptions, maxTokens, reasoning: options.reasoning }),
		initialState: {
			systemPrompt: [graph.systemPrompt, graph.orientation],
			model: options.model,
			tools: [answerTool],
		},
	});

	let turnsInNode = 0;
	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_end") turnsInNode += 1;
		if (event.type === "message_end" && event.message.role === "assistant") {
			const messageUsage = event.message.usage;
			if (!messageUsage) return;
			usage.input += messageUsage.input;
			usage.output += messageUsage.output;
			usage.cacheRead += messageUsage.cacheRead;
			usage.cacheWrite += messageUsage.cacheWrite;
			usage.totalTokens += messageUsage.totalTokens;
			usage.cost += messageUsage.cost?.total ?? 0;
			// Per-request, not just per-walk: whether context grows quadratically
			// across nodes is only visible in the distribution.
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
		}
	});

	const visits = new Map<string, number>();
	const ledger: AgentMessage[] = [];
	/** Typed answers so far, the walk's authoritative state under any context mode. */
	const answered: string[] = [];
	let nodesEntered = 0;

	try {
		while (true) {
			if (nodesEntered >= maxNodeEntries) {
				return finish("stuck", node.id, nodesEntered, usage, `node entry ceiling ${maxNodeEntries} reached`);
			}

			const visit = (visits.get(node.id) ?? 0) + 1;
			visits.set(node.id, visit);
			nodesEntered += 1;
			turnsInNode = 0;
			decision = undefined;

			const question = await composeQuestion(node, visit, options, artifact, answered);
			options.trajectory.write({
				type: "node_enter",
				nodeId: node.id,
				visit,
				prompt: question.full,
				payload: node.payload,
				options: nodeOptions(node).map(entry => entry.option),
			});
			options.onProgress?.(`-> ${node.id} (visit ${visit})`);

			if (options.context === "ledger") agent.replaceMessages(ledger);
			if (options.context === "stateless") agent.clearMessages();
			await agent.prompt(question.full);
			for (let nudge = 0; !decision && nudge < MAX_ANSWER_NUDGES; nudge++) {
				if (turnsInNode > node.maxTurns) break;
				await agent.prompt(answerRequiredPrompt);
			}
			if (agent.state.error) return finish("error", node.id, nodesEntered, usage, agent.state.error);
			if (!decision) return finish("stuck", node.id, nodesEntered, usage, `node ${node.id} never answered`);

			const committed = decision as NodeDecision;
			options.trajectory.write({
				type: "answer",
				nodeId: node.id,
				visit,
				option: committed.option,
				why: committed.why,
				payload: committed.payload ?? {},
				applied: committed.applied,
			});
			answered.push(
				JSON.stringify({ step: node.id, option: committed.option, why: committed.why, did: committed.applied }),
			);
			if (options.context === "ledger") {
				ledger.push(...digest(agent.state.messages, ledger.length, question, committed, node.id));
			}

			if (committed.option === ESCAPE_OPTION) return finish("escaped", node.id, nodesEntered, usage);

			const edge = node.edges.find(e => e.option === committed.option);
			if (!edge) throw new Error(`node ${node.id} produced unknown option: ${committed.option}`);
			options.onProgress?.(`   ${node.id} --${edge.option}--> ${edge.to}: ${committed.applied}`);
			if (edge.to === DONE_NODE) return finish("done", node.id, nodesEntered, usage);

			const next = nodes.get(edge.to);
			if (!next) throw new Error(`walk reached unknown node: ${edge.to}`);
			node = next;
		}
	} catch (err) {
		return finish("error", node.id, nodesEntered, usage, err instanceof Error ? err.message : String(err));
	} finally {
		unsubscribe();
	}

	function finish(
		status: WalkResult["status"],
		finalNodeId: string,
		entered: number,
		totals: WalkUsage,
		error?: string,
	): WalkResult {
		options.trajectory.write({
			type: "walk_end",
			walkId: options.walkId,
			status,
			finalNodeId,
			nodesEntered: entered,
			usage: totals,
			...(error ? { error } : {}),
		});
		return { status, finalNodeId, nodesEntered: entered, usage: totals, ...(error ? { error } : {}) };
	}
}

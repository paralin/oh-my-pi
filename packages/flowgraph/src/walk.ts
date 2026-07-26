/**
 * The walk engine: one LLM session driven node by node.
 *
 * Inversion of control is the whole point. The session never decides what to do
 * next; entering a node injects that node's prompt as a user message, narrows
 * the tool surface to that node's allowlist plus the two control tools, and the
 * node is only left when the model calls `advance` with an option the graph
 * drew and the node's deterministic gate has passed.
 */
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Model, streamSimple, z } from "@oh-my-pi/pi-ai";
import Handlebars from "handlebars";
import { DONE_NODE, ESCAPE_OPTION, type FlowNode, type IndexedGraph } from "./graph";
import advanceRequiredPrompt from "./prompts/advance-required.md" with { type: "text" };
import { createWorkspaceTools, runGate } from "./tools";
import type { TrajectoryWriter, WalkUsage } from "./trajectory";

/** Everything a walk needs that is not in the graph. */
export interface WalkOptions {
	graph: IndexedGraph;
	/** Identifier for this run, tying the opening and closing records together. */
	walkId: string;
	/** Target directory. Every workspace tool and gate is confined to it. */
	dir: string;
	/** The parent objective, interpolated into node prompts as `{{task}}`. */
	task: string;
	model: Model;
	trajectory: TrajectoryWriter;
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

/** What the model decided at a node, captured by the control tools. */
interface NodeDecision {
	option: string;
	why?: string;
	escapeReason?: string;
}

const DEFAULT_MAX_NODE_ENTRIES = 32;
const DEFAULT_MAX_TOKENS = 8192;
/** Nudges allowed when a node ends its turn without calling a control tool. */
const MAX_ADVANCE_NUDGES = 2;

function emptyUsage(): WalkUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/**
 * Build the two control tools for a node.
 *
 * `advance` carries the edge choice and the why-answer in one call, so the
 * rationale cannot drift from the transition it explains. `escape_graph` is the
 * legal exit for work the graph cannot express, which keeps a bad fit visible
 * instead of pushing the model to fake a walk.
 */
function createControlTools(
	node: FlowNode,
	dir: string,
	trajectory: TrajectoryWriter,
	artifacts: Set<string>,
	commit: (decision: NodeDecision) => void,
): AgentTool<any>[] {
	const options = node.edges.map(edge => edge.option) as [string, ...string[]];
	const optionHelp = node.edges.map(edge => `${edge.option}: ${edge.description}`).join(" | ");
	const advanceShape: Record<string, z.ZodType> = {
		option: z.enum(options).describe(`Which outgoing edge to take. ${optionHelp}`),
	};
	if (node.why) advanceShape.why = z.string().min(1).describe(node.why);

	return [
		{
			name: "advance",
			label: "Advance",
			description: "Leave this step by choosing one of its outgoing options.",
			parameters: z.object(advanceShape),
			execute: async (_id, params: { option: string; why?: string }) => {
				if (node.gate) {
					const cwd = node.gate.cwd === "." ? dir : `${dir}/${node.gate.cwd}`;
					const { ok, output } = await runGate(node.gate.command, cwd, node.gate.emptyOutput);
					trajectory.write({ type: "gate_result", nodeId: node.id, command: node.gate.command, ok, output });
					if (!ok) {
						return {
							content: [{ type: "text", text: `gate failed, stay in this step and fix it:\n${output}` }],
							isError: true,
						};
					}
				}
				if (node.why) {
					trajectory.write({
						type: "why_answer",
						nodeId: node.id,
						question: node.why,
						answer: params.why ?? "",
						artifacts: [...artifacts],
					});
				}
				commit({ option: params.option, why: params.why });
				return { content: [{ type: "text", text: `advancing via ${params.option}` }] };
			},
		},
		{
			name: "escape_graph",
			label: "Escape Graph",
			description: "Leave the graph because it cannot express the work this task actually needs.",
			parameters: z.object({
				reason: z.string().min(1).describe("What the task needs that no outgoing option offers."),
			}),
			execute: async (_id, params: { reason: string }) => {
				commit({ option: ESCAPE_OPTION, escapeReason: params.reason });
				return { content: [{ type: "text", text: "leaving the graph" }] };
			},
		},
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
	const workspaceTools = createWorkspaceTools(options.dir);
	const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
	const maxNodeEntries = options.maxNodeEntries ?? DEFAULT_MAX_NODE_ENTRIES;
	const usage = emptyUsage();

	const agent = new Agent({
		streamFn: (model, context, streamOptions) => streamSimple(model, context, { ...streamOptions, maxTokens }),
		initialState: { systemPrompt: [graph.systemPrompt], model: options.model, tools: [] },
	});

	let artifacts = new Set<string>();
	let turnsInNode = 0;
	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "turn_end") turnsInNode += 1;
		if (event.type === "message_end" && event.message.role === "assistant") {
			const messageUsage = event.message.usage;
			if (messageUsage) {
				usage.input += messageUsage.input;
				usage.output += messageUsage.output;
				usage.cacheRead += messageUsage.cacheRead;
				usage.cacheWrite += messageUsage.cacheWrite;
				usage.totalTokens += messageUsage.totalTokens;
				usage.cost += messageUsage.cost?.total ?? 0;
			}
		}
		if (event.type === "tool_execution_end" && event.result?.details?.mutated) {
			artifacts.add(event.result.details.path);
		}
	});

	const visits = new Map<string, number>();
	let currentId = graph.entry;
	let nodesEntered = 0;

	try {
		while (true) {
			const node = nodes.get(currentId);
			if (!node) throw new Error(`walk reached unknown node: ${currentId}`);
			if (nodesEntered >= maxNodeEntries) {
				return finish("stuck", currentId, nodesEntered, usage, `node entry ceiling ${maxNodeEntries} reached`);
			}

			const visit = (visits.get(node.id) ?? 0) + 1;
			visits.set(node.id, visit);
			nodesEntered += 1;
			artifacts = new Set<string>();
			turnsInNode = 0;

			let decision: NodeDecision | undefined;
			const control = createControlTools(node, options.dir, options.trajectory, artifacts, d => {
				decision = d;
			});
			const allowed = node.tools.map(name => {
				const tool = workspaceTools.get(name);
				if (!tool) throw new Error(`node ${node.id} allowlists unknown tool: ${name}`);
				return tool;
			});
			agent.setTools([...allowed, ...control]);

			const prompt = Handlebars.compile(node.prompt, { noEscape: true })({
				task: options.task,
				dir: options.dir,
				visit,
			});
			options.trajectory.write({
				type: "node_enter",
				nodeId: node.id,
				visit,
				prompt,
				tools: [...node.tools, "advance", "escape_graph"],
			});
			options.onProgress?.(`-> ${node.id} (visit ${visit})`);

			await agent.prompt(prompt);
			for (let nudge = 0; !decision && nudge < MAX_ADVANCE_NUDGES; nudge++) {
				if (turnsInNode > node.maxTurns) break;
				await agent.prompt(advanceRequiredPrompt);
			}
			if (agent.state.error) return finish("error", node.id, nodesEntered, usage, agent.state.error);
			if (!decision) {
				return finish("stuck", node.id, nodesEntered, usage, `node ${node.id} never called a control tool`);
			}

			const committed = decision as NodeDecision;
			if (committed.option === ESCAPE_OPTION) {
				options.trajectory.write({ type: "escape", nodeId: node.id, reason: committed.escapeReason ?? "" });
				return finish("escaped", node.id, nodesEntered, usage);
			}

			const edge = node.edges.find(e => e.option === committed.option);
			if (!edge) throw new Error(`node ${node.id} produced unknown option: ${committed.option}`);
			options.trajectory.write({
				type: "node_exit",
				nodeId: node.id,
				option: edge.option,
				nextNodeId: edge.to,
				artifacts: [...artifacts],
			});
			options.onProgress?.(`   ${node.id} --${edge.option}--> ${edge.to}`);

			if (edge.to === DONE_NODE) return finish("done", node.id, nodesEntered, usage);
			currentId = edge.to;
		}
	} catch (err) {
		return finish("error", currentId, nodesEntered, usage, err instanceof Error ? err.message : String(err));
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

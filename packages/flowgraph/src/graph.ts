/**
 * Flow-graph definition format.
 *
 * A graph is authored data, never code: nodes carry a prompt template, the
 * context the engine gathers for that question, the typed blank the node
 * collects, an optional deterministic gate, an optional why-question, and the
 * outgoing edges the model may choose between. The walk engine
 * ({@link ../walk}) is the only thing that interprets it, so improving agent
 * behaviour is a data edit rather than a harness change.
 *
 * A node carries no tool list. The walk has exactly one tool for its whole
 * length ({@link ../answer}); what varies per node is the question, not the
 * surface.
 */
import { z } from "@oh-my-pi/pi-ai";
import { PAYLOAD_KINDS, type PayloadKind } from "./payload";

/** Reserved edge target that ends the walk successfully. */
export const DONE_NODE = "__done";

/**
 * Reserved option every node offers. The model selects it when the graph is
 * wrong for the work, which ends the walk with a recorded reason instead of
 * forcing a bad trajectory.
 */
export const ESCAPE_OPTION = "escape";

/** Observations the engine may gather and paste into a node's question. */
export const CONTEXT_KINDS = ["package_doc", "sources", "artifact", "build", "vet", "tests", "todo"] as const;

/** One kind of observation a node can request. */
export type ContextKind = (typeof CONTEXT_KINDS)[number];

const edgeSchema = z.object({
	/** Value the model passes to `answer` to take this edge. */
	option: z.string().min(1),
	/** Target node id, or {@link DONE_NODE}. */
	to: z.string().min(1),
	/** Shown to the model beside the option so the choice is informed. */
	description: z.string().min(1),
	/**
	 * Payload this edge collects instead of the node's own kind.
	 *
	 * A node's blank is the right one for the work it repeats, but not always
	 * for the way it is left. An edge that can also just exit, such as a
	 * fill-body loop reporting that nothing is left to fill, sets `none` here.
	 * The kinds are alternatives: an answer that fills the node's blank still
	 * uses the node's kind, and one that fills nothing uses the edge's, so the
	 * last body can leave on the exit edge and an exhausted loop can leave
	 * empty-handed.
	 */
	payload: z.enum(PAYLOAD_KINDS as [PayloadKind, ...PayloadKind[]]).optional(),
});

const gateSchema = z.object({
	/** Argv of a deterministic check that must pass before the node may exit. */
	command: z.array(z.string().min(1)).min(1),
	/** Working directory relative to the walk's target directory. */
	cwd: z.string().default("."),
	/**
	 * Also require empty output. Reporting tools such as `gofmt -l` exit zero
	 * while listing the files they object to, so exit status alone would let a
	 * node walk past its own gate.
	 */
	emptyOutput: z.boolean().default(false),
});

const nodeSchema = z.object({
	id: z.string().min(1),
	/** Handlebars template appended to the session as a user message on entry. */
	prompt: z.string().min(1),
	/** Observations the engine gathers and pastes into this node's question. */
	context: z.array(z.enum(CONTEXT_KINDS)).default([]),
	/** The typed blank this node collects, from {@link ../payload}. */
	payload: z.enum(PAYLOAD_KINDS as [PayloadKind, ...PayloadKind[]]).default("none"),
	/** Question answered as typed data on every exit from this node. */
	why: z.string().min(1).optional(),
	/** Deterministic check the node cannot exit without passing. */
	gate: gateSchema.optional(),
	edges: z.array(edgeSchema).min(1),
	/** Turn budget before the walk aborts this node as stuck. */
	maxTurns: z.number().int().positive().default(12),
});

const graphSchema = z.object({
	id: z.string().min(1),
	description: z.string().min(1),
	/**
	 * System prompt for the whole walk. Part of the stable cached prefix, so it
	 * is set once at session construction and never touched again.
	 */
	systemPrompt: z.string().min(1),
	/**
	 * Orientation appended once after the system prompt: how a walk works, read
	 * before the first question. Also prefix, also never re-sent.
	 */
	orientation: z.string().min(1),
	/** Package the walk builds into, used when the artifact is first created. */
	packageName: z.string().min(1),
	entry: z.string().min(1),
	nodes: z.array(nodeSchema).min(1),
});

/** One outgoing edge. The option the model picks selects the edge. */
export type FlowEdge = z.infer<typeof edgeSchema>;

/** A deterministic exit gate: a command that must succeed before the node exits. */
export type FlowGate = z.infer<typeof gateSchema>;

/** One node: a prompt, a narrowed tool surface, a gate, and outgoing edges. */
export type FlowNode = z.infer<typeof nodeSchema>;

/** A whole authored graph, indexed by {@link indexGraph} before a walk. */
export type FlowGraph = z.infer<typeof graphSchema>;

/** A validated graph with its node lookup, ready to walk. */
export interface IndexedGraph {
	graph: FlowGraph;
	nodes: ReadonlyMap<string, FlowNode>;
}

/**
 * Parse and structurally validate a graph. Schema validity is not enough: a
 * dangling edge or a duplicate id only fails mid-walk, after tokens are spent,
 * so both are rejected at load time.
 */
export function indexGraph(input: unknown): IndexedGraph {
	const graph = graphSchema.parse(input);
	const nodes = new Map<string, FlowNode>();
	for (const node of graph.nodes) {
		if (nodes.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
		nodes.set(node.id, node);
	}
	if (!nodes.has(graph.entry)) throw new Error(`entry node not found: ${graph.entry}`);
	for (const node of graph.nodes) {
		const options = new Set<string>();
		for (const edge of node.edges) {
			if (edge.option === ESCAPE_OPTION) throw new Error(`node ${node.id} redefines the reserved escape option`);
			if (options.has(edge.option)) throw new Error(`node ${node.id} has duplicate option: ${edge.option}`);
			options.add(edge.option);
			if (edge.to !== DONE_NODE && !nodes.has(edge.to)) {
				throw new Error(`node ${node.id} edge ${edge.option} targets unknown node: ${edge.to}`);
			}
		}
	}
	return { graph, nodes };
}

/** Load a graph from a JSON file and index it. */
export async function loadGraph(path: string): Promise<IndexedGraph> {
	return indexGraph(await Bun.file(path).json());
}

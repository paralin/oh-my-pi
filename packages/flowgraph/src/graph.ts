/**
 * Flow-graph definition format.
 *
 * A graph is authored data, never code: nodes carry a prompt template, a tool
 * allowlist, an optional deterministic gate, an optional why-question, and the
 * outgoing edges the model may choose between. The walk engine
 * ({@link ../walk}) is the only thing that interprets it, so improving agent
 * behaviour is a data edit rather than a harness change.
 */
import { z } from "@oh-my-pi/pi-ai";

/** Reserved edge target that ends the walk successfully. */
export const DONE_NODE = "__done";

/**
 * Reserved option every node offers. The model selects it when the graph is
 * wrong for the work, which ends the walk with a recorded reason instead of
 * forcing a bad trajectory.
 */
export const ESCAPE_OPTION = "__escape";

const edgeSchema = z.object({
	/** Value the model passes to `advance` to take this edge. */
	option: z.string().min(1),
	/** Target node id, or {@link DONE_NODE}. */
	to: z.string().min(1),
	/** Shown to the model beside the option so the choice is informed. */
	description: z.string().min(1),
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
	/** Names of workspace tools this node exposes, from {@link ../tools}. */
	tools: z.array(z.string().min(1)).default([]),
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
	/** System prompt for the whole walk. Node prompts carry the per-step task. */
	systemPrompt: z.string().min(1),
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

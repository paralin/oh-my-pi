/**
 * Typed trajectory records.
 *
 * The trajectory is the product of a walk, not a debugging aid: every node
 * entry, gate result, why-answer, and edge choice lands here as data so a later
 * consumer can trace a line of code back to the question that produced it.
 * Human-facing progress output is separate and carries no record duty.
 */
import * as fs from "node:fs/promises";

/** Common envelope on every record. */
export interface TrajectoryBase {
	/** Monotonic index within the walk, so a reader can order records without clocks. */
	seq: number;
	/** Wall-clock stamp, for cost and duration analysis only. */
	at: number;
}

/** Opens the file: what was walked, against what, with which model. */
export interface WalkStartRecord extends TrajectoryBase {
	type: "walk_start";
	walkId: string;
	graphId: string;
	task: string;
	dir: string;
	model: string;
}

/** The model entered a node: this question was injected and these options offered. */
export interface NodeEnterRecord extends TrajectoryBase {
	type: "node_enter";
	nodeId: string;
	visit: number;
	prompt: string;
	/** Payload kind the node collects, so a reader knows the shape of its answer. */
	payload: string;
	options: string[];
}

/** A deterministic gate ran. A failed gate keeps the model inside the node. */
export interface GateResultRecord extends TrajectoryBase {
	type: "gate_result";
	nodeId: string;
	command: string[];
	ok: boolean;
	output: string;
}

/**
 * One accepted `answer` call: the whole of what happened at a node.
 *
 * Nothing here is reconstructed from tool events. The model's single call
 * carries the edge, the rationale, and the typed payload together, so the call
 * is the record and a reader can bind a line of code to the question that
 * produced it without interpreting a transcript.
 */
export interface AnswerRecord extends TrajectoryBase {
	type: "answer";
	nodeId: string;
	visit: number;
	option: string;
	why: string;
	payload: Record<string, unknown>;
	/** What the engine did to the artifact when it applied the payload. */
	applied: string;
}

/**
 * A node's work-in-progress state, dumped by the session at a context boundary.
 *
 * This is the walk's continuity surface. A session near the end of its window
 * writes what it knows into the node it occupies, and the next session is primed
 * from this record rather than from a compacted transcript or a scratch file, so
 * the trajectory is the only thing that has to survive.
 */
export interface CheckpointRecord extends TrajectoryBase {
	type: "checkpoint";
	nodeId: string;
	visit: number;
	/** Prompt tokens on the request that triggered the dump, beside the window it was measured against. */
	promptTokens: number;
	contextWindow: number;
	state: { progress: string; open: string[]; facts: string[]; next: string };
}

/** One provider request, so the per-node token distribution is visible. */
export interface RequestRecord extends TrajectoryBase, WalkUsage {
	type: "request";
	nodeId: string;
}

/** Closes the file with the outcome and the aggregate cost of the walk. */
export interface WalkEndRecord extends TrajectoryBase {
	type: "walk_end";
	walkId: string;
	status: "done" | "escaped" | "stuck" | "error";
	finalNodeId: string;
	nodesEntered: number;
	error?: string;
	usage: WalkUsage;
}

/**
 * Token and cost totals accumulated across every node of a walk.
 *
 * Cache reads are tracked separately because a graph walk re-sends one growing
 * session at every node, so almost all of its prompt cost lands there rather
 * than in `input`. Collapsing them would make a walk look far cheaper than it is.
 */
export interface WalkUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

/** Every record shape a trajectory file may contain. */
export type TrajectoryRecord =
	| WalkStartRecord
	| NodeEnterRecord
	| GateResultRecord
	| AnswerRecord
	| CheckpointRecord
	| RequestRecord
	| WalkEndRecord;

/**
 * A record as its producer writes it: everything but the envelope the writer
 * assigns. Distributive so each member keeps its own discriminated shape.
 */
export type TrajectoryRecordInput<T = TrajectoryRecord> = T extends TrajectoryRecord ? Omit<T, "seq" | "at"> : never;

/** Appends typed records to a JSONL file, assigning sequence and timestamp. */
export class TrajectoryWriter {
	#seq = 0;
	#queue: Promise<void> = Promise.resolve();
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	/** Append one record. Writes are serialized so lines never interleave. */
	write(record: TrajectoryRecordInput): void {
		const line = `${JSON.stringify({ ...record, seq: this.#seq++, at: Date.now() })}\n`;
		this.#queue = this.#queue.then(() => fs.appendFile(this.path, line));
	}

	/** Resolve once every queued append has landed on disk. */
	async flush(): Promise<void> {
		await this.#queue;
	}
}

/** Read a trajectory file back into typed records. */
export async function readTrajectory(path: string): Promise<TrajectoryRecord[]> {
	const text = await Bun.file(path).text();
	return Bun.JSONL.parse(text) as TrajectoryRecord[];
}

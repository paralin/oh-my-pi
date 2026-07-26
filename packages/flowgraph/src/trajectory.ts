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

/** The model entered a node: this prompt was injected and these tools exposed. */
export interface NodeEnterRecord extends TrajectoryBase {
	type: "node_enter";
	nodeId: string;
	visit: number;
	prompt: string;
	tools: string[];
}

/** A deterministic gate ran. A failed gate keeps the model inside the node. */
export interface GateResultRecord extends TrajectoryBase {
	type: "gate_result";
	nodeId: string;
	command: string[];
	ok: boolean;
	output: string;
}

/** The recorded rationale for a structural transition. */
export interface WhyAnswerRecord extends TrajectoryBase {
	type: "why_answer";
	nodeId: string;
	question: string;
	answer: string;
	/** Files the node touched before answering, so rationale binds to artifacts. */
	artifacts: string[];
}

/** The model chose an edge and the walk advanced. */
export interface NodeExitRecord extends TrajectoryBase {
	type: "node_exit";
	nodeId: string;
	option: string;
	nextNodeId: string;
	artifacts: string[];
}

/** The model declared the graph wrong for the work and left legally. */
export interface EscapeRecord extends TrajectoryBase {
	type: "escape";
	nodeId: string;
	reason: string;
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
	| WhyAnswerRecord
	| NodeExitRecord
	| EscapeRecord
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

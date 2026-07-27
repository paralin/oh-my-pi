import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { indexGraph } from "../src/graph";
import { toolWalk } from "../src/toolwalk";
import { TrajectoryWriter } from "../src/trajectory";

registerMockApi();

function stepGraph() {
	return indexGraph({
		id: "compaction",
		description: "test graph",
		systemPrompt: "Answer the step.",
		orientation: "Use the next_node tool.",
		packageName: "scratchpkg",
		entry: "step",
		nodes: [
			{
				id: "step",
				prompt: "Do the work, then answer.",
				context: [],
				payload: "none",
				edges: [{ option: "finish", to: "__done", description: "finish" }],
				maxTurns: 4,
			},
		],
	});
}

const state = {
	progress: "The struct is declared and the gate passes.",
	open: ["fill Spend"],
	facts: ["budget.go holds Budget"],
	next: "answer the step with finish",
};

/**
 * The compaction boundary, end to end against a scripted model.
 *
 * The window fills, the session dumps state while also trying to answer, and
 * the walk must cross the boundary anyway: the answer is dropped, the session
 * is cleared, and a fresh one primed from the state answers the same step.
 */
describe("flowgraph tool walk compaction", () => {
	it("forces a state-only boundary and resumes a cleared session from the dump", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-toolwalk-"));
		const trajectory = new TrajectoryWriter(path.join(dir, "walk.jsonl"));
		const model = createMockModel({
			contextWindow: 200_000,
			responses: [
				// A first request establishes the session's baseline. Nothing to
				// reclaim yet, so no dump is demanded however small the threshold.
				{ content: ["Reading budget.go before I answer."], usage: { input: 1_000 } },
				// The window is now past the threshold, and the model tries to bank
				// its state and answer in the same call.
				{
					content: [
						{
							type: "toolCall",
							name: "next_node",
							arguments: { option: "finish", why: "The work is done.", state },
						},
					],
					usage: { input: 150_000 },
				},
				// The resumed session answers the step it was handed back.
				{
					content: [
						{
							type: "toolCall",
							name: "next_node",
							arguments: { option: "finish", why: "Confirmed the state and finished." },
						},
					],
					usage: { input: 2_000 },
				},
			],
		});

		try {
			const result = await toolWalk({
				graph: stepGraph(),
				walkId: "compaction-walk",
				dir,
				task: "finish the step",
				model,
				trajectory,
				checkpointAt: 0.5,
			});
			await trajectory.flush();

			expect(result.status).toBe("done");
			expect(model.calls).toHaveLength(3);

			const records = (await Bun.file(path.join(dir, "walk.jsonl")).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			const checkpoints = records.filter(r => r.type === "checkpoint");
			expect(checkpoints).toHaveLength(1);
			expect(checkpoints[0].forced).toBe(true);
			expect(checkpoints[0].state.next).toBe(state.next);

			// The forced call's answer never became an answer: the only one recorded
			// is the resumed session's.
			const answers = records.filter(r => r.type === "answer");
			expect(answers).toHaveLength(1);
			expect(answers[0].why).toBe("Confirmed the state and finished.");

			// The third request is a fresh session: primed from the dump, with none
			// of the transcript that filled the window.
			const resumed = JSON.stringify(model.calls[2]?.context.messages);
			expect(resumed).toContain("Resuming");
			expect(resumed).toContain(state.progress);
			expect(resumed).not.toContain("Reading budget.go");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps a voluntary dump and its answer in the same call", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-toolwalk-"));
		const trajectory = new TrajectoryWriter(path.join(dir, "walk.jsonl"));
		const model = createMockModel({
			contextWindow: 200_000,
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "next_node",
							arguments: { option: "finish", why: "Banked the state on the way out.", state },
						},
					],
					usage: { input: 1_000 },
				},
			],
		});

		try {
			const result = await toolWalk({
				graph: stepGraph(),
				walkId: "voluntary-walk",
				dir,
				task: "finish the step",
				model,
				trajectory,
				checkpointAt: 0.5,
			});
			await trajectory.flush();

			expect(result.status).toBe("done");
			expect(model.calls).toHaveLength(1);

			const records = (await Bun.file(path.join(dir, "walk.jsonl")).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(records.filter(r => r.type === "checkpoint")[0].forced).toBe(false);
			expect(records.filter(r => r.type === "answer")).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

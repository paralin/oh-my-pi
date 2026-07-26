import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { indexGraph } from "../src/graph";
import { TrajectoryWriter } from "../src/trajectory";
import { walk } from "../src/walk";

registerMockApi();

function testGraph() {
	return indexGraph({
		id: "termination",
		description: "test graph",
		systemPrompt: "Answer the step.",
		orientation: "Use the answer tool.",
		packageName: "scratchpkg",
		entry: "step",
		nodes: [
			{
				id: "step",
				prompt: "Choose the only option.",
				context: [],
				payload: "none",
				edges: [{ option: "finish", to: "__done", description: "finish" }],
				maxTurns: 2,
			},
		],
	});
}

async function runWalk(responses: Parameters<typeof createMockModel>[0]["responses"]) {
	const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-walk-"));
	const trajectory = new TrajectoryWriter(path.join(dir, "walk.jsonl"));
	const model = createMockModel({ responses });
	try {
		const result = await walk({
			graph: testGraph(),
			walkId: "test-walk",
			dir,
			task: "finish the task",
			model,
			trajectory,
		});
		await trajectory.flush();
		return { model, result };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("flowgraph walk answer termination", () => {
	it("ends the node turn after a valid answer without a closing completion", async () => {
		const { model, result } = await runWalk([
			{
				content: [
					{ type: "toolCall", name: "answer", arguments: { option: "finish", why: "The step is complete." } },
				],
			},
		]);

		expect(result.status).toBe("done");
		expect(model.calls).toHaveLength(1);
	});

	it("continues after an invalid answer and stops after the corrected answer", async () => {
		const { model, result } = await runWalk([
			{
				content: [{ type: "toolCall", name: "answer", arguments: { option: "wrong", why: "Retry." } }],
			},
			{
				content: [
					{ type: "toolCall", name: "answer", arguments: { option: "finish", why: "The step is complete." } },
				],
			},
		]);

		expect(result.status).toBe("done");
		expect(model.calls).toHaveLength(2);
	});
});

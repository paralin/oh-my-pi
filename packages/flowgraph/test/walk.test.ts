import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { emptyArtifact, renderArtifact, renderTests, testFileName } from "../src/artifact";
import { indexGraph, loadGraph } from "../src/graph";
import { applyPayload } from "../src/payload";
import { TrajectoryWriter } from "../src/trajectory";
import { type WalkOptions, walk } from "../src/walk";

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

async function runWalk(
	responses: Parameters<typeof createMockModel>[0]["responses"],
	options: Pick<WalkOptions, "reasoning"> = {},
) {
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
			...options,
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
	it("forwards the requested reasoning effort to every provider request", async () => {
		const { model, result } = await runWalk(
			[{ content: [{ type: "toolCall", name: "answer", arguments: { option: "finish", why: "Done." } }] }],
			{ reasoning: "xhigh" },
		);

		expect(result.status).toBe("done");
		expect(model.calls).toHaveLength(1);
		expect(model.calls[0]?.options?.reasoning).toBe("xhigh");
	});
});

describe("flowgraph artifact invariants", () => {
	it("normalizes every method stub to a deterministic receiver name", () => {
		const artifact = emptyArtifact("budget.go", "scratchpkg");
		artifact.structs.push({ name: "Budget", doc: "Budget tracks spending.", fields: [] });

		const result = applyPayload(
			"stubs",
			{
				funcs: [
					{ name: "NewBudget", receiver: "", params: "", results: "", doc: "NewBudget creates a budget." },
					{ name: "Spend", receiver: "*Budget", params: "amount int", results: "bool", doc: "Spend deducts." },
					{ name: "Balance", receiver: "ignored *Budget", params: "", results: "int", doc: "Balance reports." },
				],
			},
			artifact,
		);

		expect(result.ok).toBe(true);
		expect(artifact.funcs.map(fn => fn.receiver)).toEqual(["", "b *Budget", "b *Budget"]);
	});

	it("renders the test set into its own file with the testing import supplied", () => {
		const artifact = emptyArtifact("budget.go", "scratchpkg");

		const result = applyPayload(
			"tests",
			{
				imports: ["time"],
				tests: [{ name: "TestSpend", doc: "TestSpend covers the boundary.", code: "_ = time.Now()" }],
			},
			artifact,
		);

		expect(result.ok).toBe(true);
		expect(testFileName(artifact)).toBe("budget_test.go");
		// The engine writes the signature, so it owns the import that signature needs.
		expect(artifact.testImports).toEqual(["testing", "time"]);
		expect(renderTests(artifact)).toContain("func TestSpend(t *testing.T) {");
		// The test file is separate, so `testing` never reaches the implementation.
		expect(renderArtifact(artifact)).not.toContain("testing");
	});

	it("rejects a test set that names the same test twice", () => {
		const artifact = emptyArtifact("budget.go", "scratchpkg");
		const duplicate = { name: "TestSpend", doc: "TestSpend covers spending.", code: "t.Fail()" };

		const result = applyPayload("tests", { tests: [duplicate, duplicate] }, artifact);

		expect(result).toEqual({ ok: false, reason: "duplicate test: TestSpend" });
	});

	it("keeps the ladder repair edge from body filling to stub declaration", async () => {
		const graph = await loadGraph(new URL("../graphs/go-ladder.json", import.meta.url).pathname);
		const fillBody = graph.nodes.get("fill_body");

		expect(fillBody?.edges).toContainEqual({
			option: "revise_stubs",
			to: "declare_stubs",
			description: "A structural signature mistake needs correction before bodies can be filled.",
		});
	});
});

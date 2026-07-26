import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { emptyArtifact, renderArtifact, renderTests, resolvePackageName, testFileName } from "../src/artifact";
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

describe("flowgraph walk repair", () => {
	/** A ladder in miniature: implement one body, then get a chance to replace it. */
	function repairGraph() {
		return indexGraph({
			id: "repair",
			description: "test graph",
			systemPrompt: "Answer the step.",
			orientation: "Use the answer tool.",
			packageName: "scratchpkg",
			entry: "stub",
			nodes: [
				{
					id: "stub",
					prompt: "Declare the struct.",
					payload: "struct",
					edges: [{ option: "declared", to: "stubs", description: "declared" }],
					maxTurns: 2,
				},
				{
					id: "stubs",
					prompt: "Declare the stubs.",
					payload: "stubs",
					edges: [{ option: "stubbed", to: "fill", description: "stubbed" }],
					maxTurns: 2,
				},
				{
					id: "fill",
					prompt: "Implement the body.",
					payload: "body",
					edges: [{ option: "filled", to: "repair", description: "implemented" }],
					maxTurns: 2,
				},
				{
					id: "repair",
					prompt: "Replace the body if it is wrong.",
					payload: "revision",
					edges: [{ option: "repaired", to: "__done", description: "repaired" }],
					maxTurns: 2,
				},
			],
		});
	}

	it("replaces a body a later node found defective and records the defect", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-repair-"));
		const trajectory = new TrajectoryWriter(path.join(dir, "walk.jsonl"));
		const model = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "answer",
							arguments: {
								option: "declared",
								why: "Budget owns the spend.",
								payload: { file: "budget.go", name: "Budget", doc: "Budget tracks spending." },
							},
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "answer",
							arguments: {
								option: "stubbed",
								why: "One method is enough.",
								payload: { funcs: [{ name: "Spend", results: "int", doc: "Spend deducts." }] },
							},
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "answer",
							arguments: { option: "filled", why: "Filled.", payload: { func: "Spend", code: "return 1" } },
						},
					],
				},
				{
					content: [
						{
							type: "toolCall",
							name: "answer",
							arguments: {
								option: "repaired",
								why: "The body was off by one.",
								payload: { func: "Spend", code: "return 2", defect: "off by one" },
							},
						},
					],
				},
			],
		});

		try {
			const result = await walk({
				graph: repairGraph(),
				walkId: "repair-walk",
				dir,
				task: "repair the body",
				model,
				trajectory,
			});
			await trajectory.flush();

			expect(result.status).toBe("done");
			expect(await Bun.file(path.join(dir, "budget.go")).text()).toContain("return 2");
			const records = (await Bun.file(path.join(dir, "walk.jsonl")).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(records.find(r => r.nodeId === "repair" && r.type === "answer")?.applied).toBe(
				"revised Spend: off by one",
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("flowgraph loop exits", () => {
	/** A loop that collects a body, with an exit that may also collect nothing. */
	function loopGraph() {
		return indexGraph({
			id: "loop",
			description: "test graph",
			systemPrompt: "Answer the step.",
			orientation: "Use the answer tool.",
			packageName: "scratchpkg",
			entry: "declare",
			nodes: [
				{
					id: "declare",
					prompt: "Declare the struct.",
					payload: "struct",
					edges: [{ option: "declared", to: "stubs", description: "declared" }],
					maxTurns: 2,
				},
				{
					id: "stubs",
					prompt: "Declare the stubs.",
					payload: "stubs",
					edges: [{ option: "stubbed", to: "loop", description: "stubbed" }],
					maxTurns: 2,
				},
				{
					id: "loop",
					prompt: "Implement one body, or leave if none are left.",
					payload: "body",
					edges: [
						{ option: "next", to: "loop", description: "more to do" },
						{ option: "done", to: "__done", description: "nothing left", payload: "none" },
					],
					maxTurns: 2,
				},
			],
		});
	}

	function answers(...calls: { option: string; payload?: unknown }[]) {
		return calls.map(call => ({
			content: [
				{ type: "toolCall" as const, name: "answer", arguments: { option: call.option, why: "Because.", ...call } },
			],
		}));
	}

	/** The two setup answers every loop test shares, before the exit under test. */
	const setup = answers(
		{ option: "declared", payload: { file: "budget.go", name: "Budget", doc: "Budget tracks spending." } },
		{ option: "stubbed", payload: { funcs: [{ name: "Spend", results: "int", doc: "Spend deducts." }] } },
	);

	async function runLoop(responses: Parameters<typeof createMockModel>[0]["responses"]) {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-loop-"));
		const trajectory = new TrajectoryWriter(path.join(dir, "walk.jsonl"));
		try {
			const result = await walk({
				graph: loopGraph(),
				walkId: "loop-walk",
				dir,
				task: "fill the bodies",
				model: createMockModel({ responses: [...setup, ...responses] }),
				trajectory,
			});
			await trajectory.flush();
			return result;
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	// Two walks in the archived corpus escaped here: every body was filled, so
	// the loop had nothing left to collect, and the only exit still demanded the
	// payload the loop collects. No legal answer existed.
	it("lets an exhausted loop leave without the payload it repeats", async () => {
		const result = await runLoop(answers({ option: "done" }));

		expect(result.status).toBe("done");
	});

	it("still lets the exit carry the last payload out", async () => {
		const result = await runLoop(answers({ option: "done", payload: { func: "Spend", code: "return 1" } }));

		expect(result.status).toBe("done");
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

	it("replaces an implemented body without disturbing the rest of the artifact", () => {
		const artifact = emptyArtifact("budget.go", "scratchpkg");
		applyPayload("stubs", { funcs: [{ name: "Spend", doc: "Spend deducts." }] }, artifact);
		applyPayload("body", { func: "Spend", code: "return 1" }, artifact);

		const result = applyPayload(
			"revision",
			{ func: "Spend", code: "return 2", defect: "off by one" },
			artifact,
		);

		expect(result).toEqual({ ok: true, summary: "revised Spend: off by one" });
		expect(artifact.funcs[0]?.body).toBe("return 2");
	});

	it("refuses to revise a body that was never implemented", () => {
		const artifact = emptyArtifact("budget.go", "scratchpkg");
		applyPayload("stubs", { funcs: [{ name: "Spend", doc: "Spend deducts." }] }, artifact);

		const result = applyPayload("revision", { func: "Spend", code: "return 2", defect: "wrong" }, artifact);

		expect(result).toEqual({ ok: false, reason: "Spend is not implemented yet" });
	});

	it("leaves the final gate a way back to every step that can repair", async () => {
		const graph = await loadGraph(new URL("../graphs/go-ladder.json", import.meta.url).pathname);
		const finalGate = graph.nodes.get("final_gate");

		// A terminal gate whose only options are `clean` and `escape` forces a
		// walk that is one defect from done to either lie or abandon the work.
		expect(finalGate?.edges.map(edge => edge.to)).toEqual(["__done", "repair_body", "write_tests"]);
	});

	it("holds back an import until a body names it", () => {
		const artifact = emptyArtifact("cache.go", "scratchpkg");
		applyPayload(
			"stubs",
			{ imports: ["errors"], funcs: [{ name: "New", results: "error", doc: "New builds a cache." }] },
			artifact,
		);

		// Stub bodies panic, so an import the bodies will need is unused and the
		// stub file would not build.
		expect(renderArtifact(artifact)).not.toContain('"errors"');

		applyPayload("body", { func: "New", code: 'return errors.New("nope")' }, artifact);

		expect(renderArtifact(artifact)).toContain('import "errors"');
	});

	it("keeps a second struct in the file the artifact already occupies", () => {
		const artifact = emptyArtifact("", "scratchpkg");
		applyPayload("struct", { file: "cache.go", name: "Cache", doc: "Cache caches." }, artifact);

		const result = applyPayload("struct", { file: "entry.go", name: "entry", doc: "entry is one item." }, artifact);

		// A second file would carry a second copy of Cache, which the build rejects.
		expect(result).toEqual({ ok: true, summary: "declared struct entry in cache.go" });
		expect(artifact.file).toBe("cache.go");
	});

	it("takes the package clause from the directory the walk writes into", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-pkg-"));
		try {
			await Bun.write(path.join(dir, "doc.go"), "// Package ttlcache caches.\npackage ttlcache\n");

			// The graph's name would put a second package clause in a directory that
			// already has one, which no payload in the graph can repair.
			expect(await resolvePackageName(dir, "scratchpkg")).toBe("ttlcache");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("falls back to the graph's package name in a directory with no Go", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "flowgraph-pkg-"));
		try {
			expect(await resolvePackageName(dir, "scratchpkg")).toBe("scratchpkg");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

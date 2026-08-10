import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HindsightSessionState } from "../../src/hindsight/state";
import type { IpythonHostRequest } from "../../src/ipython/controller";
import {
	type IpythonLongTermMemoryOwner,
	IpythonLongTermMemoryService,
} from "../../src/ipython/long-term-memory-service";
import { IPYTHON_PYTHON_ASSETS } from "../../src/ipython/python-assets";
import type { MnemopiSessionState } from "../../src/mnemopi/state";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function request(
	type: string,
	data: Readonly<Record<string, unknown>> = {},
	signal = new AbortController().signal,
): IpythonHostRequest {
	return {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data: { type, ...data },
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("long-term memory does not allocate artifacts");
		},
	};
}

function owner(options: {
	backend: IpythonLongTermMemoryOwner["backend"];
	hindsight?: HindsightSessionState;
	mnemopi?: MnemopiSessionState;
	autolearn?: boolean;
}): IpythonLongTermMemoryOwner {
	return {
		backend: options.backend,
		cwd: () => "/workspace",
		agentDir: () => "/agent",
		autolearnEnabled: () => options.autolearn ?? true,
		hindsight: () => options.hindsight,
		mnemopi: () => options.mnemopi,
	};
}

function handler(service: IpythonLongTermMemoryService, type: string) {
	const value = service.handlers[type];
	if (!value) throw new Error(`missing handler ${type}`);
	return value;
}

describe("IPython configured long-term memory", () => {
	test("uses the configured Hindsight state for queued retain, scoped recall, and bank-backed reflection", async () => {
		const queued: Array<{ content: string; context: string | undefined }> = [];
		const recalls: Array<Record<string, unknown>> = [];
		const reflects: Array<Record<string, unknown>> = [];
		const state = {
			bankId: "project-bank",
			config: {
				recallBudget: "high",
				recallMaxTokens: 77,
				recallTypes: ["fact"],
			},
			recallTags: ["project:workspace"],
			recallTagsMatch: "any",
			banksSet: new Set<string>(),
			enqueueRetain: (content: string, context?: string) => queued.push({ content, context }),
			client: {
				recall: async (_bank: string, query: string, options: Record<string, unknown>) => {
					recalls.push({ query, ...options });
					return { results: [{ id: "r1", text: "remembered", type: "fact", mentioned_at: "2026-08-10" }] };
				},
				reflect: async (_bank: string, query: string, options: Record<string, unknown>) => {
					reflects.push({ query, ...options });
					return { text: "synthesized" };
				},
			},
		} as unknown as HindsightSessionState;
		const ensured: HindsightSessionState[] = [];
		const service = new IpythonLongTermMemoryService({
			owner: owner({ backend: () => "hindsight", hindsight: state }),
			ensureHindsightBank: async value => {
				ensured.push(value);
			},
		});

		expect(
			await handler(
				service,
				"long_term_memory.retain",
			)(
				request("long_term_memory.retain", {
					items: [{ content: "durable choice", context: "user said so" }],
				}),
			),
		).toEqual({ backend: "hindsight", queued: 1 });
		expect(queued).toEqual([{ content: "durable choice", context: "user said so" }]);

		expect(
			await handler(service, "long_term_memory.recall")(request("long_term_memory.recall", { query: "choice" })),
		).toEqual({
			backend: "hindsight",
			query: "choice",
			count: 1,
			items: [{ id: "r1", content: "remembered", type: "fact", mentioned_at: "2026-08-10" }],
		});
		expect(recalls).toMatchObject([
			{
				query: "choice",
				budget: "high",
				maxTokens: 77,
				types: ["fact"],
				tags: ["project:workspace"],
				tagsMatch: "any",
			},
		]);

		expect(
			await handler(
				service,
				"long_term_memory.reflect",
			)(
				request("long_term_memory.reflect", {
					query: "what matters?",
					context: "current task",
				}),
			),
		).toEqual({ backend: "hindsight", text: "synthesized" });
		expect(ensured).toEqual([state]);
		expect(reflects).toMatchObject([
			{
				query: "what matters?",
				context: "current task",
				budget: "high",
				tags: ["project:workspace"],
				tagsMatch: "any",
			},
		]);
	});

	test("cancels an in-flight Hindsight recall without changing the configured request", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		const state = {
			bankId: "project-bank",
			config: { recallBudget: "low", recallMaxTokens: 32, recallTypes: [] },
			recallTags: ["project:workspace"],
			recallTagsMatch: "all",
			client: {
				recall: async (_bank: string, _query: string, options: { signal?: AbortSignal }) => {
					signal = options.signal;
					started.resolve();
					await release.promise;
					return { results: [] };
				},
			},
		} as unknown as HindsightSessionState;
		const service = new IpythonLongTermMemoryService({
			owner: owner({ backend: () => "hindsight", hindsight: state }),
		});
		const controller = new AbortController();
		const pending = handler(
			service,
			"long_term_memory.recall",
		)(request("long_term_memory.recall", { query: "choice" }, controller.signal));
		await started.promise;
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(signal).toBe(controller.signal);
		release.resolve();
	});

	test("uses the configured Mnemopi state without rebuilding bank scope, extraction, or entity selection", async () => {
		const remembered: Array<{ content: string; options: Record<string, unknown> }> = [];
		const edits: Array<{ op: string; id: string; options: Record<string, unknown> }> = [];
		const recalls: string[] = [];
		const state = {
			sessionId: "session-1",
			rememberScoped: (content: string, options: Record<string, unknown>) => {
				remembered.push({ content, options });
				return "memory-1";
			},
			recallResultsScoped: async (query: string) => {
				recalls.push(query);
				return [{ id: "memory-1", content: "stored fact", source: "coding-agent-retain", score: 0.9 }];
			},
			formatContextScoped: () => "- stored fact",
			editScopedMemory: (op: string, id: string, options: Record<string, unknown>) => {
				edits.push({ op, id, options });
				return { status: "updated", bank: "project", store: "working" };
			},
		} as unknown as MnemopiSessionState;
		const service = new IpythonLongTermMemoryService({ owner: owner({ backend: () => "mnemopi", mnemopi: state }) });

		expect(
			await handler(
				service,
				"long_term_memory.retain",
			)(
				request("long_term_memory.retain", {
					items: [{ content: "stored fact", context: "context" }],
				}),
			),
		).toEqual({ backend: "mnemopi", stored: 1, ids: ["memory-1"] });
		expect(remembered[0]).toMatchObject({
			content: "stored fact",
			options: {
				source: "coding-agent-retain",
				importance: 0.75,
				scope: "bank",
				extract: true,
				extractEntities: true,
				veracity: "tool",
				memoryType: "fact",
				metadata: { session_id: "session-1", cwd: "/workspace", context: "context", tool: "retain" },
			},
		});

		expect(
			await handler(service, "long_term_memory.recall")(request("long_term_memory.recall", { query: "stored" })),
		).toEqual({
			backend: "mnemopi",
			query: "stored",
			count: 1,
			items: [{ id: "memory-1", content: "stored fact", source: "coding-agent-retain", score: 0.9 }],
		});
		expect(
			await handler(
				service,
				"long_term_memory.reflect",
			)(
				request("long_term_memory.reflect", {
					query: "what was stored?",
					context: "for this project",
				}),
			),
		).toEqual({ backend: "mnemopi", text: "Based on recalled memories:\n\n- stored fact", count: 1 });
		expect(recalls).toEqual(["stored", "what was stored?\n\nAdditional context:\nfor this project"]);

		expect(
			await handler(
				service,
				"long_term_memory.edit",
			)(
				request("long_term_memory.edit", {
					op: "update",
					id: "memory-1",
					importance: 3,
				}),
			),
		).toEqual({ status: "updated", bank: "project", store: "working" });
		expect(edits).toEqual([
			{ op: "update", id: "memory-1", options: { content: undefined, importance: 1, replacementId: undefined } },
		]);
	});

	test("keeps a stored local lesson when the optional managed-skill write fails", async () => {
		const saves: Array<{ context: Record<string, unknown>; input: Record<string, unknown> }> = [];
		const service = new IpythonLongTermMemoryService({
			owner: owner({ backend: () => "local" }),
			saveLocalLesson: async (context, input) => {
				saves.push({ context, input });
				return { backend: "local", stored: 1 };
			},
			writeManagedSkill: async () => {
				throw new Error("disk full");
			},
		});

		expect(
			await handler(
				service,
				"long_term_memory.learn",
			)(
				request("long_term_memory.learn", {
					memory: "Use the typed memory owner.",
					context: "review",
					skill: {
						action: "create",
						name: "memory-owner",
						description: "Use when storing memory.",
						body: "# Keep it typed",
					},
				}),
			),
		).toEqual({
			backend: "local",
			memory: { status: "stored", stored: 1 },
			skill: { status: "failed", name: "memory-owner", reason: "disk full" },
			partial: true,
		});
		expect(saves).toEqual([
			{
				context: { agentDir: "/agent", cwd: "/workspace" },
				input: {
					content: "Use the typed memory owner.",
					context: "review",
					source: "coding-agent-learn",
					importance: 0.8,
				},
			},
		]);
	});

	test("rejects unadvertised request fields before state owners are invoked", async () => {
		const service = new IpythonLongTermMemoryService({ owner: owner({ backend: () => "mnemopi" }) });
		await expect(
			handler(service, "long_term_memory.recall")(request("long_term_memory.recall", { query: "x", bank: "other" })),
		).rejects.toThrow("unknown field: bank");
		await expect(
			handler(service, "long_term_memory.edit")(request("long_term_memory.edit", { op: "update", id: "x" })),
		).rejects.toThrow("requires content or importance");
		expect(Object.keys(service.handlers).sort()).toEqual([
			"long_term_memory.edit",
			"long_term_memory.learn",
			"long_term_memory.recall",
			"long_term_memory.reflect",
			"long_term_memory.retain",
		]);
	});

	test("cold-imports the bundled Python module and publishes its capability index", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-long-term-memory-"));
		roots.push(root);
		for (const asset of IPYTHON_PYTHON_ASSETS) {
			await Bun.write(path.join(root, asset.path), asset.content);
		}
		await fs.rm(path.join(root, "rlm"), { recursive: true, force: true });
		await Bun.write(
			path.join(root, "rlm.py"),
			"requests = []\nasync def host_request(kind, data=None):\n    requests.append((kind, data))\n    return {}\nharness = object()\n",
		);
		await Bun.write(path.join(root, "omp", "world.py"), "");
		const python = Bun.which("python3");
		if (!python) throw new Error("python3 is required for the IPython Python ABI test");
		const process = Bun.spawn(
			[
				python,
				"-c",
				[
					"import asyncio",
					"import omp",
					"import rlm",
					"from omp import long_term_memory",
					"async def verify():",
					"    await long_term_memory.retain([{'content': 'fact'}])",
					"    await long_term_memory.recall('fact')",
					"    await long_term_memory.reflect('fact', context='context')",
					"    await long_term_memory.edit('forget', 'memory-1')",
					"    await long_term_memory.update('memory-1', content='replacement')",
					"    await long_term_memory.forget('memory-1')",
					"    await long_term_memory.invalidate('memory-1', replacement_id='memory-2')",
					"    await long_term_memory.learn('lesson')",
					"asyncio.run(verify())",
					"assert [kind for kind, _ in rlm.requests] == [",
					"    'long_term_memory.retain', 'long_term_memory.recall', 'long_term_memory.reflect',",
					"    'long_term_memory.edit', 'long_term_memory.edit', 'long_term_memory.edit',",
					"    'long_term_memory.edit', 'long_term_memory.learn',",
					"]",
					"assert any(item.name == 'omp.long_term_memory' for item in omp.capabilities())",
					"assert 'continual-harness' in next(item.summary for item in omp.capabilities() if item.name == 'omp.memory')",
				].join("\n"),
			],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(process.stderr).text();
		expect(await process.exited).toBe(0);
		expect(stderr).toBe("");
	});
});

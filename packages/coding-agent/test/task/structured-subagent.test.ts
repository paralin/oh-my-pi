import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	artifactsDirsFromRegistry,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as claudeCodeRuntime from "@oh-my-pi/pi-coding-agent/task/claude-code-runtime";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationRunner from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	buildStructuredSubagentRecoveryHint,
	resolveEffectiveSubagentPolicy,
	runStructuredSubagent,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "../../src/session/tool-session.js";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
	tools: ["read", "write", "ast_grep"],
	output: { type: "object", properties: { agent: { type: "boolean" } } },
};

function session(
	options: {
		outputSchema?: unknown;
		maxDepth?: number;
		isolationMode?: "none" | "worktree";
		isolationApply?: boolean;
		modelRoles?: Record<string, string>;
	} = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		outputSchema: options.outputSchema,
		settings: Settings.isolated({
			"task.maxRecursionDepth": options.maxDepth ?? 2,
			"task.isolation.mode": options.isolationMode ?? "none",
			"task.enableLsp": true,
			...(options.modelRoles ? { modelRoles: options.modelRoles } : {}),
			...(options.isolationApply !== undefined ? { "task.isolation.apply": options.isolationApply } : {}),
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function result(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: '{"ok":true}',
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

function mockDiscovery(agent: AgentDefinition = AGENT): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
}

afterEach(() => {
	vi.restoreAllMocks();
	resetRegisteredArtifactDirsForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("structured subagent primitive", () => {
	it("uses caller, agent, then session schemas in precedence order", async () => {
		mockDiscovery();
		const callerSchema = { type: "object", properties: { caller: { type: "string" } } };
		const caller = await resolveEffectiveSubagentPolicy(
			request({ outputSchema: callerSchema, schemaMode: "strict" }),
		);
		expect(caller.schema).toEqual({
			schema: callerSchema,
			source: "caller",
			mode: "strict",
			outputSchemaOverridesAgent: true,
		});

		const agent = await resolveEffectiveSubagentPolicy(
			request({ session: session({ outputSchema: { session: true } }) }),
		);
		expect(agent.schema.source).toBe("agent");
		expect(agent.schema.schema).toBe(AGENT.output);

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const inheritedSession = session({ outputSchema: { session: true } });
		inheritedSession.outputSchemaMode = "strict";
		const inherited = await resolveEffectiveSubagentPolicy(request({ session: inheritedSession }));
		expect(inherited.schema).toMatchObject({ source: "session", mode: "strict", outputSchemaOverridesAgent: false });
	});

	it("accepts a model-role key without a matching agent file as a Task-derived agent", async () => {
		const roleSession = session({
			modelRoles: { "role-only-test": "openai-codex/gpt-5.6-luna:high" },
		});

		const policy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, agent: "role-only-test" }));

		expect(policy.agent).toMatchObject({
			name: "role-only-test",
			model: ["@role-only-test"],
			source: "bundled",
		});
		expect(policy.modelOverride).toEqual(["openai-codex/gpt-5.6-luna:high"]);
	});

	it("propagates a custom thinking-suffixed role alias through policy, dispatch, and settlement", async () => {
		const customAgent = { ...AGENT, model: ["@reviewer:high"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return { ...result(), modelRole: options.modelRole };
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, agent: "worker", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBe("reviewer");
		expect(dispatched[0]?.modelRole).toBe("reviewer");
		expect(settled.result.modelRole).toBe("reviewer");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("derives modelRole from the raw selector source in request, override, definition order", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const roleSession = session({
			modelRoles: {
				request: "openai/gpt-4o",
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		roleSession.settings.override("task.agentModelOverrides", { worker: "@override" });

		const requestPolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession, model: "@request" }));
		expect(requestPolicy.modelRole).toBe("request");

		const overridePolicy = await resolveEffectiveSubagentPolicy(request({ session: roleSession }));
		expect(overridePolicy.modelRole).toBe("override");

		const concreteOverrideSession = session({
			modelRoles: {
				override: "openai/gpt-4o",
				definition: "openai/gpt-4o",
			},
		});
		concreteOverrideSession.settings.override("task.agentModelOverrides", { worker: "openai/gpt-4o" });
		const concreteOverridePolicy = await resolveEffectiveSubagentPolicy(
			request({ session: concreteOverrideSession }),
		);
		expect(concreteOverridePolicy.modelRole).toBeUndefined();

		const definitionPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ modelRoles: { definition: "openai/gpt-4o" } }) }),
		);
		expect(definitionPolicy.modelRole).toBe("definition");
	});
	it("falls through an empty request selector to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession, model: "" }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("falls through an empty configured override to the agent definition role", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});
	it("falls through a configured alias that expands to no patterns", async () => {
		const customAgent = { ...AGENT, model: ["@definition"] };
		mockDiscovery(customAgent);
		const childSession = session({ modelRoles: { empty: "", definition: "openai/gpt-4o" } });
		childSession.settings.override("task.agentModelOverrides", { worker: "@empty" });

		const policy = await resolveEffectiveSubagentPolicy(request({ session: childSession }));

		expect(policy.modelRole).toBe("definition");
		expect(policy.modelOverride).toEqual(["openai/gpt-4o"]);
	});

	it("does not assign a role when a child uses an explicit model selector", async () => {
		mockDiscovery();
		const childSession = session({ modelRoles: { reviewer: "openai/gpt-4o" } });
		const dispatched: executorModule.ExecutorOptions[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			dispatched.push(options);
			return result();
		});

		const settled = await runStructuredSubagent(
			request({ session: childSession, model: "openai/gpt-4o", retainArtifacts: true }),
		);

		expect(settled.policy.modelRole).toBeUndefined();
		expect(dispatched[0]?.modelRole).toBeUndefined();
		expect(settled.result.modelRole).toBeUndefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("leases temporary artifacts for a retained invocation and registers them for agent URLs", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			expect(await fs.stat(options.artifactsDir ?? "")).toBeDefined();
			return result();
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));
		expect(settled.temporaryArtifacts).toBe(true);
		expect(artifactsDir).toBe(settled.artifactsDir);
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(settled.result.structuredOutput).toMatchObject({
			source: "agent",
			mode: "permissive",
			data: { ok: true },
		});
		expect(path.basename(settled.artifactsDir)).toStartWith("omp-task-");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
	it("applies configured LSP and IRC policy to Task invocations", async () => {
		mockDiscovery();
		const policy = await resolveEffectiveSubagentPolicy(request());

		expect(policy.enableLsp).toBe(true);
		expect(policy.enableIrc).toBe(true);
	});
	it("rejects an invalid caller schema before executor dispatch in either schema mode", async () => {
		mockDiscovery();
		const dispatch = vi.spyOn(executorModule, "runSubprocess");

		for (const schemaMode of ["permissive", "strict"] as const) {
			await expect(runStructuredSubagent(request({ outputSchema: false, schemaMode }))).rejects.toThrow(
				schemaMode === "strict"
					? "Invalid strict caller output schema: boolean false schema rejects all outputs"
					: "Invalid caller output schema: boolean false schema rejects all outputs",
			);
		}
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("does not return unavailable structured metadata without an effective schema", async () => {
		const unstructuredAgent = { ...AGENT, output: undefined };
		mockDiscovery(unstructuredAgent);
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async () => {
			const completed = result();
			completed.structuredOutput = { source: "none", mode: "permissive", status: "unavailable" };
			return completed;
		});

		const settled = await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(settled.result).not.toHaveProperty("structuredOutput");
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("keeps invalid inherited schemas permissive but rejects them when session strict mode is inherited", async () => {
		const invalidAgent = { ...AGENT, output: false };
		mockDiscovery(invalidAgent);
		expect((await resolveEffectiveSubagentPolicy(request())).schema).toMatchObject({
			source: "agent",
			mode: "permissive",
		});

		const noAgentOutput = { ...AGENT, output: undefined };
		mockDiscovery(noAgentOutput);
		const strictSession = session({ outputSchema: false });
		strictSession.outputSchemaMode = "strict";
		await expect(resolveEffectiveSubagentPolicy(request({ session: strictSession }))).rejects.toThrow(
			"Invalid strict effective output schema: boolean false schema rejects all outputs",
		);
	});

	it("persists nested patch text with the compatible recovery path and wording", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-structured-subagent-"));
		const completed = result();
		completed.patchPath = "/recovery/Worker.patch";
		completed.branchName = "omp/task/Worker";
		completed.nestedPatches = [{ relativePath: "sub/nested", patch: "diff --git a/file b/file\n" }];

		const hint = await buildStructuredSubagentRecoveryHint(completed, artifactsDir);
		const nestedPath = path.join(artifactsDir, "Worker.nested-0-sub_nested.patch");

		expect(hint).toContain("Captured patch preserved at /recovery/Worker.patch.");
		expect(hint).toContain(`Captured nested patch preserved at ${nestedPath}.`);
		expect(hint).toContain("Captured branch preserved as omp/task/Worker.");
		expect(await fs.readFile(nestedPath, "utf8")).toBe("diff --git a/file b/file\n");
		await fs.rm(artifactsDir, { recursive: true, force: true });
	});

	it("cleans ephemeral artifacts when isolation setup fails without recovery", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockRejectedValue(new Error("not a repository"));

		await expect(
			runStructuredSubagent(
				request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
			),
		).rejects.toThrow("Isolated subagent execution requires a git repository");
		expect(artifactsDirsFromRegistry()).toEqual([]);
	});

	it("reuses a cached output manager across concurrent allocations and sanitizes artifact ids", async () => {
		mockDiscovery();
		const sharedSession = session();
		const ids: string[] = [];
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			ids.push(options.id);
			return result();
		});

		const settled = await Promise.all([
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
			runStructuredSubagent(
				request({ session: sharedSession, identity: { label: "../../Worker" }, retainArtifacts: true }),
			),
		]);

		expect(ids.sort()).toEqual(["Worker", "Worker-2"]);
		expect(sharedSession.agentOutputManager).toBeDefined();
		for (const run of settled) await fs.rm(run.artifactsDir, { recursive: true, force: true });
	});

	it("unregisters and removes a temporary lease when output ID allocation fails", async () => {
		mockDiscovery();
		const failingSession = session();
		failingSession.agentOutputManager = {
			allocate: async () => {
				throw new Error("allocate failed");
			},
		} as unknown as ToolSession["agentOutputManager"];
		const remove = vi.spyOn(fs, "rm");

		await expect(runStructuredSubagent(request({ session: failingSession }))).rejects.toThrow(
			"Subagent execution failed: allocate failed",
		);

		const artifactsDir = remove.mock.calls[0]?.[0];
		expect(typeof artifactsDir).toBe("string");
		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir as string)).rejects.toThrow();
	});

	it("cleans failed nonisolated handle artifacts", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			artifactsDir = options.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed" };
		});

		await runStructuredSubagent(request({ retainArtifacts: true }));

		expect(artifactsDirsFromRegistry()).toEqual([]);
		await expect(fs.stat(artifactsDir ?? "")).rejects.toThrow();
	});

	it("runs an isolated Claude task through the shared isolation owner", async () => {
		mockDiscovery();
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges").mockResolvedValue({
			summary: "",
			changesApplied: true,
			hadAnyChanges: false,
			mergedBranchForNestedPatches: false,
		});
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions, runSubagent }) => ({
			...(await runSubagent({ ...baseOptions, worktree: "/tmp/isolated" })),
			patchPath: "/tmp/Worker.patch",
		}));
		const claude = vi.spyOn(claudeCodeRuntime, "runClaudeCodeSubprocess").mockResolvedValue(result());
		const pi = vi.spyOn(executorModule, "runSubprocess");

		await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree" }),
				model: "claude-code/claude-opus-5",
				isolation: { requested: true },
			}),
		);

		expect(claude).toHaveBeenCalledWith({
			options: expect.objectContaining({ worktree: "/tmp/isolated" }),
			model: "claude-opus-5",
		});
		expect(pi).not.toHaveBeenCalled();
		expect(merge).toHaveBeenCalledWith({
			result: expect.objectContaining({ patchPath: "/tmp/Worker.patch" }),
			repoRoot: "/tmp",
			mergeMode: "patch",
		});
	});

	it("retains isolated failure artifacts needed for recovery", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), exitCode: 1, error: "agent failed", patchPath: "/recovery/Worker.patch" };
		});

		const settled = await runStructuredSubagent(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);

		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});

	it("defaults task isolation to auto-apply and lets config retain artifacts", async () => {
		mockDiscovery();
		const defaultPolicy = await resolveEffectiveSubagentPolicy(
			request({ session: session({ isolationMode: "worktree" }), isolation: { requested: true } }),
		);
		expect(defaultPolicy.applyChanges).toBe(true);

		const capturePolicy = await resolveEffectiveSubagentPolicy(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);
		expect(capturePolicy.applyChanges).toBe(false);
	});

	it("retains successful isolated task artifacts when auto-apply is disabled", async () => {
		mockDiscovery();
		let artifactsDir: string | undefined;
		vi.spyOn(isolationRunner, "prepareIsolationContext").mockResolvedValue({ repoRoot: "/tmp" } as never);
		vi.spyOn(isolationRunner, "runIsolatedSubprocess").mockImplementation(async ({ baseOptions }) => {
			artifactsDir = baseOptions.artifactsDir;
			return { ...result(), patchPath: "/recovery/Worker.patch" };
		});
		const merge = vi.spyOn(isolationRunner, "mergeIsolatedChanges");

		const settled = await runStructuredSubagent(
			request({
				session: session({ isolationMode: "worktree", isolationApply: false }),
				isolation: { requested: true },
			}),
		);

		expect(merge).not.toHaveBeenCalled();
		expect(settled.changesApplied).toBeNull();
		expect(settled.mergeSummary).toContain("/recovery/Worker.patch");
		expect(artifactsDirsFromRegistry()).toContain(settled.artifactsDir);
		expect(await fs.stat(artifactsDir ?? "")).toBeDefined();
		await fs.rm(settled.artifactsDir, { recursive: true, force: true });
	});
});

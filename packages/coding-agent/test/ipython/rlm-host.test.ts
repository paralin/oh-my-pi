import { describe, expect, test } from "bun:test";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { createRlmIpythonHostHandlers } from "../../src/ipython/rlm-host.js";
import type { TaskAdmissionRequest, TaskAdmissionService, TaskChildProjection } from "../../src/task/admission.js";

function hostRequest(data: Readonly<Record<string, unknown>>): IpythonHostRequest {
	return {
		requestId: "request-1",
		executionId: "execution-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal: new AbortController().signal,
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 7,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("not used");
		},
	};
}

function fakeService(): TaskAdmissionService & { admissions: TaskAdmissionRequest[]; deleted: string[] } {
	const admissions: TaskAdmissionRequest[] = [];
	const deleted: string[] = [];
	const child: TaskChildProjection = {
		id: "reviewer",
		name: "reviewer",
		activeSessionId: "child-session",
		sessionId: "child-session",
		sessionDir: "/sessions/child",
		status: "running",
		lifecycleStatus: "running",
		model: "provider/model",
	};
	return {
		admissions,
		deleted,
		async admit(request) {
			admissions.push(request);
			return {
				id: child.id,
				name: child.name,
				jobId: child.id,
				sessionId: child.sessionId,
				sessionDir: child.sessionDir,
				model: child.model!,
				cwd: "/workspace",
			};
		},
		findModels(query, limit) {
			return [{ provider: "provider", id: "model", name: `Model ${query}`, selector: "provider/model" }].slice(
				0,
				limit,
			);
		},
		async listDirectChildren() {
			return [child];
		},
		async deleteDirectChild(target) {
			deleted.push(target);
			return { ...child, activeSessionId: undefined, status: "error", lifecycleStatus: "aborted" };
		},
	};
}

describe("RLM IPython host handlers", () => {
	test("translates a Prime-shaped call once into Task admission and returns its handle", async () => {
		const task = fakeService();
		const handlers = createRlmIpythonHostHandlers(task);
		const result = await handlers["rlm.run"]?.(
			hostRequest({
				type: "rlm.run",
				prompt: "Inspect the API.",
				kwargs: { name: "reviewer", model: "provider/model", isolated: true, apply: false, merge: "patch" },
			}),
		);
		expect(result).toEqual({
			rlm_child_id: "reviewer",
			name: "reviewer",
			session_dir: "/sessions/child",
			model: "provider/model",
		});
		expect(task.admissions).toHaveLength(1);
		expect(task.admissions[0]).toMatchObject({
			assignment: "Inspect the API.",
			name: "reviewer",
			model: "provider/model",
			isolation: { requested: true, apply: false, merge: "patch" },
			sourceId: "ipython:session-1:cell-1:7",
		});
	});

	test("rejects unknown keywords, oversized names, and detached isolation controls", async () => {
		const handlers = createRlmIpythonHostHandlers(fakeService());
		await expect(
			handlers["rlm.run"]?.(hostRequest({ type: "rlm.run", prompt: "work", kwargs: { agent: "task" } })),
		).rejects.toThrow("unsupported rlm() keyword");
		await expect(
			handlers["rlm.run"]?.(hostRequest({ type: "rlm.run", prompt: "work", kwargs: { name: "x".repeat(65) } })),
		).rejects.toThrow("at most 64 characters");
		await expect(
			handlers["rlm.run"]?.(hostRequest({ type: "rlm.run", prompt: "work", kwargs: { apply: true } })),
		).rejects.toThrow("require isolated=True");
		await expect(
			handlers["rlm.run"]?.(hostRequest({ type: "rlm.run", prompt: "work", kwargs: { service_tier: "turbo" } })),
		).rejects.toThrow("service_tier must be one of");
	});

	test("projects model lookup and direct-child list/delete without a second roster", async () => {
		const task = fakeService();
		const handlers = createRlmIpythonHostHandlers(task);
		expect(
			await handlers["rlm.find_models"]?.(hostRequest({ type: "rlm.find_models", query: "fast", limit: 4 })),
		).toEqual({
			models: [
				{
					provider: "provider",
					id: "model",
					name: "Model fast",
					selector: "provider/model",
					// Host emits the camelCase concreteSelector + availability per Prime.
					concreteSelector: "provider/model",
					available: true,
				},
			],
		});
		expect(await handlers["rlm.find_models"]?.(hostRequest({ type: "rlm.find_models" }))).toEqual({
			models: [
				expect.objectContaining({
					selector: "provider/model",
					concreteSelector: "provider/model",
					available: true,
				}),
			],
		});
		expect(await handlers["rlm.list_subagents"]?.(hostRequest({ type: "rlm.list_subagents" }))).toEqual({
			subagents: [
				{
					rlm_child_id: "reviewer",
					active_session_id: "child-session",
					session_id: "child-session",
					session_name: "reviewer",
					session_dir: "/sessions/child",
					status: "running",
					lifecycle_status: "running",
					model: "provider/model",
				},
			],
		});
		const removed = await handlers["rlm.delete_subagent"]?.(
			hostRequest({ type: "rlm.delete_subagent", target: "reviewer" }),
		);
		expect(task.deleted).toEqual(["reviewer"]);
		expect(removed).toMatchObject({
			subagent: { rlm_child_id: "reviewer", status: "error", lifecycle_status: "aborted" },
		});
	});

	test("fails clearly when the session has no Task admission owner", async () => {
		const handlers = createRlmIpythonHostHandlers(undefined);
		await expect(handlers["rlm.list_subagents"]?.(hostRequest({ type: "rlm.list_subagents" }))).rejects.toThrow(
			"Task admission is unavailable",
		);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { IpythonWorldService } from "../../src/ipython/world-service.js";
import type { WorldOperationOwner } from "../../src/world/operation-executor.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(owner?: WorldOperationOwner) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-world-"));
	roots.push(root);
	const service = new IpythonWorldService({ owner: () => owner });
	const call = async (operation: string, data: Readonly<Record<string, unknown>>) => {
		const handler = service.handlers[operation];
		if (!handler) throw new Error(`missing handler ${operation}`);
		const request: IpythonHostRequest = {
			requestId: "request-1",
			executionId: "execution-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { ...data, type: operation },
			signal: new AbortController().signal,
			sessionId: "session-1",
			cwd: root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async () => {},
			publishDisplay: async () => {},
			allocateArtifact: async artifact => ({ path: path.join(root, `result${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { call, root };
}

function owner(): WorldOperationOwner {
	return {
		submitDispatch: async () => ({
			requestId: "submit-1",
			intentKey: "intent-1",
			session: undefined,
			custody: undefined,
		}),
		async *watchDispatch() {},
		answerQuestion: async input => ({
			requestId: input.requestId,
			questionObjectKey: input.questionObjectKey,
			decisionObjectKey: "decision-1",
			evidenceObjectKey: "evidence-1",
			goalObjectKey: "goal-1",
			questionState: "ANSWERED",
			goalState: "RUNNING",
			resumeTriggerObjectKey: "trigger-1",
			replayed: false,
		}),
		sendSessionInput: async input => ({
			requestId: input.requestId,
			operation: "session_input",
			targetSessionObjectKey: input.targetSessionObjectKey,
			dispatchKey: "dispatch-1",
			acceptedSequence: 7n,
			detail: "accepted",
			replayed: false,
		}),
		interruptSession: async input => ({
			requestId: input.requestId,
			operation: "session_interrupt",
			targetSessionObjectKey: input.targetSessionObjectKey,
			dispatchKey: "dispatch-1",
			acceptedSequence: 8n,
			detail: "accepted",
			replayed: false,
		}),
	};
}

describe("IPython World service", () => {
	test("runs the five authority-owned operations and projects bigint values", async () => {
		const f = await fixture(owner());
		expect(
			await f.call("world.dispatch_submit", {
				objective: "implement",
				worktree_path: "/tmp/worktree",
				working_directory: "/tmp/worktree/pkg",
				worktree_identity: "branch",
				deliverable_paths: ["pkg/result.ts"],
				write_surfaces: ["pkg"],
			}),
		).toMatchObject({ kind: "ok", op: "dispatch_submit", result: { intentKey: "intent-1" } });
		expect(await f.call("world.dispatch_watch", { intent_key: "intent-1", stop: "terminal" })).toMatchObject({
			kind: "ok",
			op: "dispatch_watch",
			snapshot: null,
		});
		expect(
			await f.call("world.question_answer", { request_id: "answer-1", question: "question-1", summary: "yes" }),
		).toMatchObject({ kind: "ok", result: { decisionObjectKey: "decision-1" } });
		expect(
			await f.call("world.session_input", { request_id: "input-1", session: "session-2", text: "continue" }),
		).toMatchObject({ kind: "ok", result: { acceptedSequence: "7" } });
		expect(
			await f.call("world.session_interrupt", { request_id: "stop-1", session: "session-2", reason: "done" }),
		).toMatchObject({ kind: "ok", result: { acceptedSequence: "8" } });
	});

	test("rejects irrelevant and unbounded fields before calling World", async () => {
		const f = await fixture(owner());
		await expect(f.call("world.dispatch_watch", { intent_key: "intent-1", objective: "ignored" })).rejects.toThrow(
			"unknown field",
		);
		await expect(
			f.call("world.session_input", { request_id: "input-1", session: "session-2", text: "x".repeat(65_537) }),
		).rejects.toThrow("too large");
	});

	test("spills oversized World results into the active cell", async () => {
		const large = owner();
		large.sendSessionInput = async input => ({
			requestId: input.requestId,
			operation: "session_input",
			targetSessionObjectKey: input.targetSessionObjectKey,
			dispatchKey: "dispatch-1",
			acceptedSequence: 9n,
			detail: "x".repeat(1024 * 1024),
			replayed: false,
		});
		const f = await fixture(large);
		const result = await f.call("world.session_input", {
			request_id: "input-1",
			session: "session-2",
			text: "continue",
		});
		expect(result).toMatchObject({ kind: "artifact", artifact: { mime_type: "application/json" } });
		expect((await fs.stat(path.join(f.root, "result.json"))).size).toBeGreaterThan(1024 * 1024);
	});

	test("reports an unavailable runtime without exposing host state", async () => {
		const f = await fixture();
		expect(await f.call("world.dispatch_watch", { intent_key: "intent-1" })).toEqual({
			kind: "unavailable",
			operation: "dispatch_watch",
			message: "World runtime is unavailable",
		});
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpHarnessService } from "../../src/ipython/harness-service";
import {
	createSessionControlIpythonHostHandlers,
	OmpSessionControlService,
	type RlmHeartbeat,
	type SessionControlHost,
} from "../../src/ipython/session-controls";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-controls-test-"));
	roots.push(root);
	let sessionId = "session-a";
	let now = Date.parse("2026-08-06T10:00:00Z");
	const wait = Promise.withResolvers<void>();
	const compacted = Promise.withResolvers<string | undefined>();
	const refined = Promise.withResolvers<{ instructions: string | undefined; global: boolean }>();
	const delivered = Promise.withResolvers<RlmHeartbeat>();
	const rewound = Promise.withResolvers<string>();
	const timers: Array<() => void> = [];
	const goal = { current: null as Record<string, unknown> | null };
	const todoCalls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
	const failures: string[] = [];
	const rewindReports: string[] = [];
	const host: SessionControlHost = {
		sessionId: () => sessionId,
		isDisposed: () => false,
		goalGet: () => ({ goal: goal.current, remaining_tokens: 100, completion_budget_report: null }),
		goalCreate: async (objective, tokenBudget) => {
			goal.current = { objective, tokenBudget, status: "active" };
			return host.goalGet();
		},
		goalComplete: async () => {
			if (goal.current) goal.current.status = "complete";
			return host.goalGet();
		},
		goalPause: async reason => {
			if (goal.current) {
				goal.current.status = "paused";
				goal.current.reason = reason;
			}
			return host.goalGet();
		},
		goalResume: async () => {
			if (goal.current) {
				goal.current.status = "active";
				delete goal.current.reason;
			}
			return host.goalGet();
		},
		contextUsage: () => ({ tokens: 120, contextWindow: 1_000, percent: 12 }),
		waitForIdle: async () => await wait.promise,
		runCompaction: async instructions => compacted.resolve(instructions),
		resumeAfterCompaction: async () => undefined,
		resumeRefinement: async (instructions, global) => refined.resolve({ instructions, global }),
		createCheckpoint: async label => ({ scheduled: true, label: label ?? null }),
		hasCheckpoint: () => true,
		runRewind: async report => {
			rewindReports.push(report);
			rewound.resolve(report);
		},
		applyTodo: async (operation, payload) => {
			todoCalls.push({ operation, payload });
			return { operation, phases: [] };
		},
		deliverHeartbeat: async heartbeat => delivered.resolve(heartbeat),
		reportFailure: message => failures.push(message),
	};
	const harness = new OmpHarnessService({
		localRoot: () => path.join(root, "local"),
		globalRoot: path.join(root, "global"),
	});
	const service = new OmpSessionControlService({
		host,
		harness,
		now: () => now,
		setTimer: callback => {
			timers.push(callback);
			return timers.length as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimer: () => undefined,
	});
	const handlers = createSessionControlIpythonHostHandlers(service);
	const call = async (type: string, data: Record<string, unknown> = {}, origin: "model" | "direct" = "model") => {
		const handler = handlers[type];
		if (!handler) throw new Error(`Missing handler ${type}`);
		return await handler({
			requestId: `request-${type}`,
			commId: `comm-${type}`,
			targetName: "host.request",
			data: { type, ...data },
			signal: new AbortController().signal,
			executionId: "execution-1",
			sessionId: "session-a",
			cwd: root,
			origin,
			cellId: "cell-1",
			sequence: 1,
			authority: "trusted-cell",
			publishProgress: async () => undefined,
			publishDisplay: async () => undefined,
			allocateArtifact: async () => ({
				id: "artifact-1",
				path: path.join(root, "artifact"),
				writePath: path.join(root, "artifact"),
				mimeType: undefined,
				label: undefined,
			}),
		});
	};
	return {
		service,
		call,
		wait,
		compacted,
		refined,
		delivered,
		rewound,
		timers,
		todoCalls,
		failures,
		rewindReports,
		advance: (milliseconds: number) => {
			now += milliseconds;
		},
		transition: () => {
			sessionId = "session-b";
		},
	};
}

describe("IPython session control host handlers", () => {
	test("adapts goal, checkpoint, todo, and harness operations", async () => {
		const { call, todoCalls } = await fixture();
		expect(await call("goal.get")).toMatchObject({ goal: null, remaining_tokens: 100 });
		expect(await call("goal.create", { objective: "Finish the runtime", token_budget: 5_000 })).toMatchObject({
			goal: { objective: "Finish the runtime", tokenBudget: 5_000, status: "active" },
		});
		expect(await call("goal.pause", { reason: "waiting for review" })).toMatchObject({
			goal: { status: "paused", reason: "waiting for review" },
		});
		expect(await call("goal.resume")).toMatchObject({ goal: { status: "active" } });
		expect(await call("goal.complete")).toMatchObject({ goal: { status: "complete" } });
		expect(await call("checkpoint.create", { label: "before-rewrite" })).toEqual({
			scheduled: true,
			label: "before-rewrite",
		});
		expect(await call("todo.apply", { operation: "append", payload: { phase: "Runtime", items: ["Test"] } })).toEqual(
			{
				operation: "append",
				phases: [],
			},
		);
		expect(todoCalls).toEqual([{ operation: "append", payload: { phase: "Runtime", items: ["Test"] } }]);

		const created = (
			await call("harness.create", {
				kind: "memory",
				id: "runtime-lesson",
				title: "Runtime lesson",
				content: "Use the session owner.",
			})
		).entry as { version: number };
		expect(created.version).toBe(1);
		expect((await call("harness.list", { kind: "memory" })).entries).toHaveLength(1);
		expect((await call("harness.snapshot")).snapshot).toMatchObject({ scope: "local" });
		expect(await call("harness.delete", { kind: "memory", id: "runtime-lesson" })).toEqual({ deleted: true });
	});

	test("schedules compaction and refinement after the active model turn", async () => {
		const { call, wait, compacted, refined } = await fixture();
		expect(await call("compact.status")).toEqual({
			tokens: 120,
			context_window: 1_000,
			percent: 12,
			scheduled: false,
			in_flight: false,
		});
		expect(await call("compact.run", { instructions: "Keep runtime facts" }, "direct")).toMatchObject({
			scheduled: false,
		});
		expect(await call("compact.run", { instructions: "Keep runtime facts" })).toMatchObject({ scheduled: true });
		expect(await call("compact.run")).toMatchObject({ scheduled: false });
		wait.resolve();
		expect(await compacted.promise).toBe("Keep runtime facts");
		expect(await call("refine.run", { instructions: "Harden cancellation", global: true })).toMatchObject({
			scheduled: true,
		});
		expect(await refined.promise).toEqual({ instructions: "Harden cancellation", global: true });
	});

	test("defers one rewind until the active cell and turn are idle", async () => {
		const { call, wait, rewound } = await fixture();
		expect(await call("checkpoint.status")).toEqual({ available: true, scheduled: false, in_flight: false });
		expect(await call("checkpoint.rewind", { report: "Found the root cause" }, "direct")).toMatchObject({
			scheduled: true,
		});
		expect(await call("checkpoint.rewind", { report: "Duplicate" })).toMatchObject({ scheduled: false });
		wait.resolve();
		expect(await rewound.promise).toBe("Found the root cause");
	});

	test("cancels a deferred rewind across session transition and disposal", async () => {
		const transitioned = await fixture();
		expect(await transitioned.call("checkpoint.rewind", { report: "stale" })).toMatchObject({ scheduled: true });
		transitioned.transition();
		transitioned.wait.resolve();
		await transitioned.wait.promise;
		await transitioned.service.waitForDeferred();
		expect(transitioned.rewindReports).toEqual([]);
		expect(transitioned.service.rewindStatus()).toMatchObject({ scheduled: false, in_flight: false });

		const disposed = await fixture();
		expect(await disposed.call("checkpoint.rewind", { report: "disposed" })).toMatchObject({ scheduled: true });
		disposed.service.dispose();
		await disposed.service.waitForDeferred();
		expect(disposed.rewindReports).toEqual([]);
		expect(disposed.service.rewindStatus()).toMatchObject({ scheduled: false, in_flight: false });
	});

	test("runs session-bound event-driven heartbeats and supports pause, resume, and delete", async () => {
		const { call, delivered, timers, advance, transition } = await fixture();
		const created = (
			await call("rlm_heartbeat.create", {
				instruction: "Check the build",
				interval: "1s",
				label: "build",
				delivery_mode: "follow_up",
			})
		).heartbeat as RlmHeartbeat;
		expect(created).toMatchObject({
			status: "active",
			instruction: "Check the build",
			delivery_mode: "follow_up",
			run_count: 0,
		});
		expect(timers).toHaveLength(1);
		advance(1_000);
		timers.shift()?.();
		expect(await delivered.promise).toMatchObject({ id: created.id, run_count: 1 });
		const paused = (await call("rlm_heartbeat.update", { id: created.id, status: "pause" }))
			.heartbeat as RlmHeartbeat;
		expect(paused.status).toBe("paused");
		expect(paused.next_run_at).toBeNull();
		expect((await call("rlm_heartbeat.list")).heartbeats).toEqual([paused]);
		const resumed = (await call("rlm_heartbeat.update", { id: created.id, status: "resume", interval: "2s" }))
			.heartbeat as RlmHeartbeat;
		expect(resumed.status).toBe("active");
		expect(resumed.schedule).toBe("2s");
		expect((await call("rlm_heartbeat.delete", { id: created.id })).heartbeat).toMatchObject({ status: "cancelled" });
		expect((await call("rlm_heartbeat.list", { include_inactive: true })).heartbeats).toEqual([]);

		await call("rlm_heartbeat.create", { instruction: "Old session", interval: "1s" });
		transition();
		expect((await call("rlm_heartbeat.list", { include_inactive: true })).heartbeats).toEqual([]);
	});

	test("rejects unknown fields and invalid heartbeat schedules", async () => {
		const { call } = await fixture();
		await expect(call("goal.get", { extra: true })).rejects.toThrow("unknown field");
		await expect(call("rlm_heartbeat.create", { instruction: "Too fast", interval: "100ms" })).rejects.toThrow(
			"1 second",
		);
		await expect(call("harness.get", { kind: "other", id: "x" })).rejects.toThrow("harness kind");
	});
});

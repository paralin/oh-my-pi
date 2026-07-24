import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CronManager, type CronTimer, nextCronFire, parseCronExpression } from "../cron";

function fakeClock(start: number) {
	let current = start;
	let idle = true;
	const timers: Array<() => void> = [];
	return {
		now: () => current,
		setNow: (value: number) => {
			current = value;
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		isIdle: () => idle,
		timers,
		setTimer: (callback: () => void): CronTimer => {
			timers.push(callback);
			return {} as CronTimer;
		},
		clearTimer: () => undefined,
	};
}

describe("cron scheduling", () => {
	it("parses standard fields and finds the next local-time match", () => {
		const schedule = parseCronExpression("*/15 9-17 * * 1-5");
		expect(schedule.minutes.has(30)).toBe(true);
		expect(schedule.hours.has(12)).toBe(true);
		const after = new Date(2026, 0, 2, 17, 46, 0);
		const next = nextCronFire("*/15 9-17 * * 1-5", after);
		expect(next.getFullYear()).toBe(2026);
		expect(next.getMonth()).toBe(0);
		expect(next.getDate()).toBe(5);
		expect(next.getHours()).toBe(9);
		expect(next.getMinutes()).toBe(0);
	});

	it("delivers a one-shot on fire during an active turn without waiting for idle", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			isIdle: clock.isIdle,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "1 10 * * *", prompt: "check in", recurring: false });
		clock.setNow(job.nextFireAt);
		// Active turn: the scheduler must still hand the fired job to its delivery
		// owner immediately. Waiting for idle (a turn end or Escape abort) is the bug.
		clock.setIdle(false);
		clock.timers.shift()?.();
		await Promise.resolve();
		await Promise.resolve();
		expect(prompts).toEqual(["check in"]);
		expect(manager.list()).toHaveLength(0);
		// No Escape / idle event is required for delivery, and re-firing notifyIdle
		// never re-delivers the consumed one-shot.
		clock.setIdle(true);
		manager.notifyIdle();
		await Promise.resolve();
		expect(prompts).toEqual(["check in"]);
		manager.dispose();
	});

	it("enqueues an overdue recurring job once at an idle boundary", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			isIdle: clock.isIdle,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "* * * * *", prompt: "pulse" });
		clock.setNow(new Date(2026, 0, 1, 12, 0).getTime());

		manager.notifyIdle();
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;

		expect(prompts).toEqual(["pulse"]);
		expect(manager.list()[0]?.id).toBe(job.id);
		expect(manager.list()[0]?.nextFireAt).toBe(new Date(2026, 0, 1, 12, 1).getTime());
		manager.dispose();
	});

	it("round-trips durable jobs and exposes missed one-shots for catch-up", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "omp-cron-"));
		try {
			const sessionFile = path.join(directory, "session.jsonl");
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const first = new CronManager({
				sessionFile,
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			const created = await first.create({
				expression: "0 11 * * *",
				prompt: "catch up",
				recurring: false,
				durable: true,
			});
			clock.setNow(new Date(2026, 0, 1, 12, 0).getTime());
			first.dispose();
			const resumed = new CronManager({
				sessionFile,
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			await resumed.load();
			expect(resumed.list()[0]).toMatchObject({ id: created.id, durable: true, nextFireAt: clock.now() });
			resumed.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("isolates durable jobs by session file", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "omp-cron-isolation-"));
		try {
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const first = new CronManager({
				sessionFile: path.join(directory, "main.jsonl"),
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			const created = await first.create({
				expression: "0 11 * * *",
				prompt: "main only",
				recurring: false,
				durable: true,
			});
			const second = new CronManager({
				sessionFile: path.join(directory, "worker.jsonl"),
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			await second.load();
			expect(second.list()).toEqual([]);
			expect(created.prompt).toBe("main only");
			first.dispose();
			second.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("refreshes durable and in-memory jobs when the session file changes", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "omp-cron-switch-"));
		try {
			let activeSessionFile = path.join(directory, "main.jsonl");
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const workerSessionFile = path.join(directory, "worker.jsonl");
			const workerManager = new CronManager({
				sessionFile: workerSessionFile,
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			const workerJob = await workerManager.create({
				expression: "0 13 * * *",
				prompt: "worker only",
				recurring: false,
				durable: true,
			});
			workerManager.dispose();
			const manager = new CronManager({
				getSessionFile: () => activeSessionFile,
				isIdle: clock.isIdle,
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			const mainJob = await manager.create({
				expression: "0 11 * * *",
				prompt: "main only",
				recurring: false,
				durable: true,
			});
			const mainSessionOnlyJob = await manager.create({
				expression: "0 12 * * *",
				prompt: "main memory only",
				recurring: false,
			});

			activeSessionFile = workerSessionFile;
			expect(manager.list()).toEqual([workerJob]);

			activeSessionFile = path.join(directory, "main.jsonl");
			expect(manager.list()).toEqual([mainJob, mainSessionOnlyJob]);

			activeSessionFile = path.join(directory, "worker.jsonl");
			expect(await manager.delete(workerJob.id)).toBe(true);
			expect(manager.list()).toEqual([]);
			manager.dispose();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("isolates in-memory jobs by session id without persisted files", async () => {
		let activeSessionId = "main";
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const manager = new CronManager({
			getSessionFile: () => undefined,
			getSessionId: () => activeSessionId,
			isIdle: clock.isIdle,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => undefined,
		});
		const mainJob = await manager.create({
			expression: "0 11 * * *",
			prompt: "main only",
			recurring: false,
		});
		activeSessionId = "worker";
		expect(manager.list()).toEqual([]);
		const workerJob = await manager.create({
			expression: "0 12 * * *",
			prompt: "worker only",
			recurring: false,
		});
		expect(manager.list()).toEqual([workerJob]);
		activeSessionId = "main";
		expect(manager.list()).toEqual([mainJob]);
		manager.dispose();
	});
});

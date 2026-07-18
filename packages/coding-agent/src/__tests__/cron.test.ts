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

	it("auto-deletes one-shots and waits for idle before enqueueing", async () => {
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
		clock.setIdle(false);
		clock.timers.shift()?.();
		await Promise.resolve();
		expect(prompts).toEqual([]);
		expect(manager.list()).toHaveLength(1);
		clock.setIdle(true);
		manager.notifyIdle();
		await Promise.resolve();
		await Promise.resolve();
		expect(prompts).toEqual(["check in"]);
		expect(manager.list()).toHaveLength(0);
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
});

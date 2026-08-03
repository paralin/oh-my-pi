import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { CronManager, type CronTimer, nextCronFire, parseCronExpression } from "../cron";
import { getThemeByName } from "../modes/theme/theme";
import { sessionSidecarDir } from "../session/session-paths";
import { FileSessionStorage, MemorySessionStorage } from "../session/session-storage";
import { CronCreateTool, CronDeleteTool, cronCreateToolRenderer, cronDeleteToolRenderer } from "../tools/cron";

function fakeClock(start: number) {
	let current = start;
	const timers: Array<() => void> = [];
	const delays: number[] = [];
	return {
		now: () => current,
		setNow: (value: number) => {
			current = value;
		},
		timers,
		delays,
		setTimer: (callback: () => void, delay: number): CronTimer => {
			timers.push(callback);
			delays.push(delay);
			return {} as CronTimer;
		},
		clearTimer: () => undefined,
	};
}

/** Let the scheduler's delivery-and-persist chain run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("cron tool policy", () => {
	it("requires write approval for schedule mutations", () => {
		expect(new CronCreateTool({} as never).approval).toBe("write");
		expect(new CronDeleteTool({} as never).approval).toBe("write");
	});
});

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

	it("rejects ranges with an empty endpoint", () => {
		expect(() => parseCronExpression("-5 * * * *")).toThrow("Invalid cron range");
		expect(() => parseCronExpression("5- * * * *")).toThrow("Invalid cron range");
	});

	it("rejects JavaScript numeric syntax", () => {
		expect(() => parseCronExpression("1e1 * * * *")).toThrow("Invalid cron value");
		expect(() => parseCronExpression("0x10 * * * *")).toThrow("Invalid cron value");
		expect(() => parseCronExpression("*/0x2 * * * *")).toThrow("Invalid cron step");
	});

	it("treats stepped stars as unrestricted day fields", () => {
		const next = nextCronFire("0 0 */1 * 1", new Date(2026, 0, 6));
		expect(next.getDay()).toBe(1);
		expect(next).toEqual(new Date(2026, 0, 12));
	});

	it("normalizes leading-zero unit wildcard steps for day matching", () => {
		expect(nextCronFire("0 0 */01 * 1", new Date(2026, 0, 6))).toEqual(new Date(2026, 0, 12));
	});

	it("treats a unit wildcard list member as an unrestricted day field", () => {
		expect(nextCronFire("0 0 *,1 * 1", new Date(2026, 0, 6))).toEqual(new Date(2026, 0, 12));
		expect(nextCronFire("0 0 1 * *,2", new Date(2026, 0, 2))).toEqual(new Date(2026, 1, 1));
	});

	it("keeps restricted stepped day fields in cron OR matching", () => {
		const next = nextCronFire("0 0 */2 * 1", new Date(2026, 0, 2));
		expect(next).toEqual(new Date(2026, 0, 3));
	});

	it("keeps explicit full day ranges restricted for cron OR matching", () => {
		expect(nextCronFire("0 0 1-31 * 1", new Date(2026, 0, 6))).toEqual(new Date(2026, 0, 7));
		expect(nextCronFire("0 0 1 * 0-7", new Date(2026, 0, 2))).toEqual(new Date(2026, 0, 3));
	});

	it("finds sparse leap-day schedules beyond one year", () => {
		const next = nextCronFire("0 0 29 2 *", new Date(2025, 2, 1));
		expect(next).toEqual(new Date(2028, 1, 29));
	});

	it("hands a fired one-shot to its delivery owner and drops it", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "1 10 * * *", prompt: "check in", recurring: false });
		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();
		await settle();

		expect(prompts).toEqual(["check in"]);
		expect(manager.list()).toHaveLength(0);
		// A consumed one-shot arms no further timer, so it can never fire twice.
		expect(clock.timers).toHaveLength(0);
		manager.dispose();
	});

	it("starts every prompt due in one tick before awaiting acceptance", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const accepted = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
				await accepted.promise;
			},
		});
		const first = await manager.create({ expression: "1 10 * * *", prompt: "first", recurring: false });
		await manager.create({ expression: "1 10 * * *", prompt: "second", recurring: false });
		clock.setNow(first.nextFireAt);
		clock.timers.at(-1)?.();
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;

		expect(prompts).toEqual(["first", "second"]);
		accepted.resolve();
		await settle();
		expect(manager.list()).toEqual([]);
		manager.dispose();
	});

	it("restores and re-arms a delivered job when durable consumption fails to publish", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-due-rollback-"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "retry me",
				recurring: false,
				durable: true,
			});
			const atomicWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockRejectedValueOnce(new Error("disk"));
			try {
				clock.setNow(job.nextFireAt);
				clock.timers.shift()?.();
				await settle();

				expect(prompts).toEqual(["retry me"]);
				expect(manager.list()).toEqual([job]);
				expect(clock.timers).toHaveLength(1);
				expect(clock.delays.at(-1)).toBe(1_000);
				clock.timers.shift()?.();
				await settle();
				expect(prompts).toEqual(["retry me"]);
				expect(manager.list()).toEqual([job]);

				clock.setNow(job.nextFireAt + 1_000);
				clock.timers.shift()?.();
				await settle();
				expect(prompts).toEqual(["retry me"]);
				expect(manager.list()).toEqual([]);
			} finally {
				atomicWrite.mockRestore();
			}
		} finally {
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("retains a durable one-shot until delivery is accepted", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-pending-delivery-"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const deliveryStarted = Promise.withResolvers<void>();
		const acceptDelivery = Promise.withResolvers<void>();
		const manager = new CronManager({
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {
				deliveryStarted.resolve();
				await acceptDelivery.promise;
			},
		});
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "keep until accepted",
				recurring: false,
				durable: true,
			});
			const consumed = Promise.withResolvers<void>();
			const originalWrite = FileSessionStorage.prototype.writeTextAtomic;
			const atomicWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockImplementation(async function (this: FileSessionStorage, file, text) {
					await originalWrite.call(this, file, text);
					consumed.resolve();
				});
			try {
				clock.setNow(job.nextFireAt);
				clock.timers.shift()?.();
				await deliveryStarted.promise;

				expect(await Bun.file(manager.storePath()).json()).toEqual([job]);
				acceptDelivery.resolve();
				await consumed.promise;
				expect(await Bun.file(manager.storePath()).json()).toEqual([]);
			} finally {
				atomicWrite.mockRestore();
			}
		} finally {
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps the final canonical store when one write observes an A to B to A move", async () => {
		const storage = new MemorySessionStorage();
		const sessionA = path.join(os.tmpdir(), `cron-a-${crypto.randomUUID()}.jsonl`);
		const sessionB = path.join(os.tmpdir(), `cron-b-${crypto.randomUUID()}.jsonl`);
		let activeSessionFile = sessionA;
		const manager = new CronManager({
			getSessionFile: () => activeSessionFile,
			getSessionId: () => "stable-session",
			storage,
			enqueuePrompt: async () => undefined,
		});
		const originalWrite = storage.writeTextAtomic.bind(storage);
		let writes = 0;
		const write = vi.spyOn(storage, "writeTextAtomic").mockImplementation(async (file, text) => {
			await originalWrite(file, text);
			writes++;
			if (writes === 1) activeSessionFile = sessionB;
			else if (writes === 2) activeSessionFile = sessionA;
		});
		try {
			const job = await manager.create({
				expression: "0 11 * * *",
				prompt: "survive final move",
				recurring: false,
				durable: true,
			});
			const canonicalStore = path.join(sessionSidecarDir(sessionA), "scheduled_tasks.json");
			const obsoleteStore = path.join(sessionSidecarDir(sessionB), "scheduled_tasks.json");
			expect(await storage.exists(canonicalStore)).toBe(true);
			expect(await storage.exists(obsoleteStore)).toBe(false);

			const resumed = new CronManager({ sessionFile: sessionA, storage, enqueuePrompt: async () => undefined });
			await resumed.load();
			expect(resumed.list()).toEqual([job]);
		} finally {
			write.mockRestore();
			manager.dispose();
		}
	});

	it("treats a missing backend fork store as empty", async () => {
		const storage = new MemorySessionStorage();
		const sessionA = path.join(os.tmpdir(), `cron-empty-parent-${crypto.randomUUID()}.jsonl`);
		const sessionB = path.join(os.tmpdir(), `cron-empty-fork-${crypto.randomUUID()}.jsonl`);
		const manager = new CronManager({ sessionFile: sessionA, storage, enqueuePrompt: async () => undefined });

		await expect(manager.copyForkStore(sessionA, sessionB)).resolves.toBeUndefined();
		expect(await storage.exists(path.join(sessionSidecarDir(sessionB), "scheduled_tasks.json"))).toBe(false);
		manager.dispose();
	});

	it("does not recopy a fork store when scheduler resumption is retried", async () => {
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-retry-${crypto.randomUUID()}.jsonl`),
			enqueuePrompt: async () => undefined,
		});
		const copy = vi.spyOn(manager, "copyForkStore").mockResolvedValue();
		const resume = vi
			.spyOn(manager, "resume")
			.mockRejectedValueOnce(new Error("resume failed"))
			.mockResolvedValueOnce();
		const result = {
			oldSessionFile: path.join(os.tmpdir(), "cron-parent.jsonl"),
			newSessionFile: path.join(os.tmpdir(), "cron-fork.jsonl"),
		};

		await manager.suspendForFork();
		await expect(manager.completeFork(result)).rejects.toThrow("resume failed");
		await expect(manager.completeFork(result)).resolves.toBeUndefined();
		expect(copy).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledTimes(2);
		manager.dispose();
	});

	it("copies a backend cron store before resuming a forked session", async () => {
		const storage = new MemorySessionStorage();
		const sessionA = path.join(os.tmpdir(), `cron-parent-${crypto.randomUUID()}.jsonl`);
		const sessionB = path.join(os.tmpdir(), `cron-fork-${crypto.randomUUID()}.jsonl`);
		let activeSessionFile = sessionA;
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const manager = new CronManager({
			getSessionFile: () => activeSessionFile,
			getSessionId: () => activeSessionFile,
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => undefined,
		});
		const job = await manager.create({
			expression: "0 11 * * *",
			prompt: "forked backend job",
			recurring: false,
			durable: true,
		});
		const staleTimer = clock.timers.at(-1);
		await manager.suspend();
		activeSessionFile = sessionB;
		staleTimer?.();
		await settle();
		await manager.copyForkStore(sessionA, sessionB);
		await manager.resume();

		expect(manager.list()).toEqual([job]);
		expect(await storage.exists(path.join(sessionSidecarDir(sessionB), "scheduled_tasks.json"))).toBe(true);
		manager.dispose();
	});

	it("keeps a moved durable store committed when obsolete cleanup fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-due-move-"));
		const oldSessionFile = path.join(directory, "old", "session.jsonl");
		const newSessionFile = path.join(directory, "new", "session.jsonl");
		let activeSessionFile = oldSessionFile;
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const delivered = Promise.withResolvers<void>();
		const manager = new CronManager({
			getSessionFile: () => activeSessionFile,
			getSessionId: () => "session-1",
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
				delivered.resolve();
			},
		});
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "move safely",
				recurring: false,
				durable: true,
			});
			const oldSidecar = path.dirname(manager.storePath());
			const newSidecar = path.join(path.dirname(newSessionFile), path.basename(oldSidecar));
			const newStore = path.join(newSidecar, "scheduled_tasks.json");
			const published = Promise.withResolvers<void>();
			await fs.mkdir(path.dirname(newSidecar), { recursive: true });
			const originalWrite = FileSessionStorage.prototype.writeTextAtomic;
			let moved = false;
			const atomicWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockImplementation(async function (this: FileSessionStorage, file, text) {
					if (!moved) {
						moved = true;
						await fs.rename(oldSidecar, newSidecar);
						activeSessionFile = newSessionFile;
					}
					await originalWrite.call(this, file, text);
					if (path.resolve(file) === newStore) published.resolve();
				});
			const unlink = vi.spyOn(FileSessionStorage.prototype, "unlink").mockRejectedValue(new Error("cleanup failed"));
			try {
				clock.setNow(job.nextFireAt);
				clock.timers.shift()?.();
				await delivered.promise;
				await published.promise;
				await settle();

				expect(await Bun.file(newStore).json()).toEqual([]);
				expect(await Bun.file(path.join(oldSidecar, "scheduled_tasks.json")).exists()).toBe(true);
				expect(prompts).toEqual(["move safely"]);
			} finally {
				atomicWrite.mockRestore();
				unlink.mockRestore();
			}
		} finally {
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("restores an earlier store when canonical publication fails after a session move", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-create-move-"));
		const oldSessionFile = path.join(directory, "old", "session.jsonl");
		const newSessionFile = path.join(directory, "new", "session.jsonl");
		let activeSessionFile = oldSessionFile;
		const manager = new CronManager({
			getSessionFile: () => activeSessionFile,
			getSessionId: () => "session-1",
			enqueuePrompt: async () => undefined,
		});
		const originalWrite = FileSessionStorage.prototype.writeTextAtomic;
		let writes = 0;
		const atomicWrite = vi.spyOn(FileSessionStorage.prototype, "writeTextAtomic").mockImplementation(async function (
			this: FileSessionStorage,
			file,
			text,
		) {
			writes++;
			if (writes === 2) throw new Error("canonical write failed");
			await originalWrite.call(this, file, text);
			if (writes === 1) activeSessionFile = newSessionFile;
		});
		try {
			await expect(
				manager.create({
					expression: "0 11 * * *",
					prompt: "do not partially publish",
					recurring: false,
					durable: true,
				}),
			).rejects.toThrow("canonical write failed");
			expect(manager.list()).toEqual([]);
			expect(await Bun.file(path.join(sessionSidecarDir(oldSessionFile), "scheduled_tasks.json")).exists()).toBe(
				false,
			);
			expect(await Bun.file(path.join(sessionSidecarDir(newSessionFile), "scheduled_tasks.json")).exists()).toBe(
				false,
			);
		} finally {
			atomicWrite.mockRestore();
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("re-arms an overdue recurring job at its next match after one delivery", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "* * * * *", prompt: "pulse" });
		// The process was busy for two hours; a per-minute job is long overdue and
		// must deliver once, not once per missed minute.
		clock.setNow(new Date(2026, 0, 1, 12, 0).getTime());
		clock.timers.shift()?.();
		await settle();

		expect(prompts).toEqual(["pulse"]);
		expect(manager.list()[0]?.id).toBe(job.id);
		expect(manager.list()[0]?.nextFireAt).toBe(new Date(2026, 0, 1, 12, 1).getTime());
		manager.dispose();
	});

	it("does not rearm after disposal interrupts due-job delivery", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const delivery = Promise.withResolvers<void>();
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: () => delivery.promise,
		});
		const job = await manager.create({ expression: "0 11 * * *", prompt: "pulse" });
		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();
		await settle();

		manager.dispose();
		delivery.resolve();
		await settle();

		expect(clock.timers).toHaveLength(0);
	});
	it("expires recurring jobs before a later scheduled occurrence", async () => {
		const clock = fakeClock(new Date(2026, 0, 2, 0, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "0 0 1 * *", prompt: "monthly" });
		if (job.expiresAt === undefined) throw new Error("Expected a recurring expiry");
		clock.setNow(job.expiresAt);
		clock.timers.shift()?.();
		await settle();

		expect(prompts).toEqual([]);
		expect(manager.list()).toEqual([]);

		manager.dispose();
	});

	it("treats a store removed during load as empty", async () => {
		const sessionFile = path.join(os.tmpdir(), `removed-${crypto.randomUUID()}.jsonl`);
		const manager = new CronManager({ sessionFile, enqueuePrompt: async () => undefined });
		const exists = vi.spyOn(FileSessionStorage.prototype, "exists").mockResolvedValue(true);
		const readText = vi
			.spyOn(FileSessionStorage.prototype, "readText")
			.mockRejectedValue(Object.assign(new Error("removed"), { code: "ENOENT" }));
		try {
			await expect(manager.load()).resolves.toBeUndefined();
			expect(manager.list()).toEqual([]);
			expect(exists).not.toHaveBeenCalled();
		} finally {
			readText.mockRestore();
			exists.mockRestore();
			manager.dispose();
		}
	});

	it("skips malformed persisted jobs while loading valid entries", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `mixed-${crypto.randomUUID()}.jsonl`);
		const manager = new CronManager({ sessionFile, storage, enqueuePrompt: async () => undefined });
		const valid = {
			id: "valid",
			expression: "0 11 * * *",
			prompt: "keep me",
			recurring: false,
			durable: true,
			createdAt: Date.now(),
			nextFireAt: Date.now() + 60_000,
		};
		await storage.writeTextAtomic(
			manager.storePath(),
			JSON.stringify([{ ...valid, id: "malformed", expression: "invalid" }, valid]),
		);

		await manager.load();
		expect(manager.list()).toEqual([valid]);
		manager.dispose();
	});

	it("treats a malformed scheduled task store as empty", async () => {
		for (const text of ["{", "{}"]) {
			const storage = new MemorySessionStorage();
			const sessionFile = path.join(os.tmpdir(), `malformed-${crypto.randomUUID()}.jsonl`);
			const manager = new CronManager({ sessionFile, storage, enqueuePrompt: async () => undefined });
			await storage.writeTextAtomic(manager.storePath(), text);

			await expect(manager.load()).resolves.toBeUndefined();
			expect(manager.list()).toEqual([]);
			manager.dispose();
		}
	});
	it("round-trips durable jobs through the configured session storage backend", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `virtual-${crypto.randomUUID()}.jsonl`);
		const first = new CronManager({ sessionFile, storage, enqueuePrompt: async () => undefined });
		const created = await first.create({
			expression: "0 11 * * *",
			prompt: "backend job",
			recurring: false,
			durable: true,
		});
		first.dispose();

		const resumed = new CronManager({ sessionFile, storage, enqueuePrompt: async () => undefined });
		await resumed.load();
		expect(resumed.list()).toEqual([created]);
		expect(await storage.exists(resumed.storePath())).toBe(true);
		expect(await Bun.file(resumed.storePath()).exists()).toBe(false);
		resumed.dispose();
	});

	it("logs delivery failures without writing a process warning", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {
				throw new Error("delivery failed");
			},
		});
		const job = await manager.create({ expression: "1 10 * * *", prompt: "fail", recurring: false });
		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();
		await settle();

		expect(warn).toHaveBeenCalledWith("Cron job delivery failed", { error: expect.any(Error) });
		manager.dispose();
		warn.mockRestore();
	});

	it("round-trips durable jobs and exposes missed one-shots for catch-up", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-"));
		try {
			const sessionFile = path.join(directory, "session.jsonl");
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const first = new CronManager({
				sessionFile,
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
				now: clock.now,
				setTimer: clock.setTimer,
				clearTimer: clock.clearTimer,
				enqueuePrompt: async () => undefined,
			});
			await resumed.load();
			expect(resumed.list()[0]).toMatchObject({ id: created.id, durable: true, nextFireAt: clock.now() });
			resumed.dispose();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("rolls back a created job when durable publication fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-create-rollback-"));
		const atomicWrite = vi
			.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
			.mockRejectedValueOnce(new Error("disk"));
		try {
			const manager = new CronManager({
				sessionFile: path.join(directory, "session.jsonl"),
				enqueuePrompt: async () => undefined,
			});
			await expect(
				manager.create({ expression: "0 11 * * *", prompt: "must not run", durable: true }),
			).rejects.toThrow("disk");
			expect(manager.list()).toEqual([]);
			manager.dispose();
		} finally {
			atomicWrite.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("restores a deleted job when durable publication fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-delete-rollback-"));
		try {
			const manager = new CronManager({
				sessionFile: path.join(directory, "session.jsonl"),
				enqueuePrompt: async () => undefined,
			});
			const job = await manager.create({
				expression: "0 11 * * *",
				prompt: "must remain",
				durable: true,
			});
			const atomicWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockRejectedValueOnce(new Error("disk"));
			try {
				await expect(manager.delete(job.id)).rejects.toThrow("disk");
				expect(manager.list()).toEqual([job]);
			} finally {
				atomicWrite.mockRestore();
				manager.dispose();
			}
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps session-only due jobs independent of durable storage", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-session-only-"));
		const atomicWrite = vi
			.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
			.mockRejectedValue(new Error("disk"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const delivered = Promise.withResolvers<void>();
		const manager = new CronManager({
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => delivered.resolve(),
		});
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "memory only",
				recurring: false,
				durable: false,
			});
			clock.setNow(job.nextFireAt);
			clock.timers.shift()?.();
			await delivered.promise;
			expect(manager.list()).toEqual([]);
			expect(atomicWrite).not.toHaveBeenCalled();
		} finally {
			manager.dispose();
			atomicWrite.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("isolates durable jobs by session file", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-isolation-"));
		try {
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const first = new CronManager({
				sessionFile: path.join(directory, "main.jsonl"),
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
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("refreshes durable and in-memory jobs when the session file changes", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-switch-"));
		try {
			let activeSessionFile = path.join(directory, "main.jsonl");
			const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
			const workerSessionFile = path.join(directory, "worker.jsonl");
			const workerManager = new CronManager({
				sessionFile: workerSessionFile,
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
			await manager.load();
			expect(manager.list()).toEqual([workerJob]);

			activeSessionFile = path.join(directory, "main.jsonl");
			await manager.load();
			expect(manager.list()).toEqual([mainJob, mainSessionOnlyJob]);

			activeSessionFile = path.join(directory, "worker.jsonl");
			expect(await manager.delete(workerJob.id)).toBe(true);
			expect(manager.list()).toEqual([]);
			manager.dispose();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
	it("isolates in-memory jobs by session id without persisted files", async () => {
		let activeSessionId = "main";
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const manager = new CronManager({
			getSessionFile: () => undefined,
			getSessionId: () => activeSessionId,
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

	it("preserves session-only jobs when a session path moves", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-move-"));
		try {
			let activeSessionFile = path.join(directory, "before.jsonl");
			const manager = new CronManager({
				getSessionFile: () => activeSessionFile,
				getSessionId: () => "stable-session",
				enqueuePrompt: async () => undefined,
			});
			const job = await manager.create({ expression: "0 11 * * *", prompt: "keep after move", recurring: false });

			activeSessionFile = path.join(directory, "after.jsonl");

			expect(manager.list()).toEqual([job]);
			manager.dispose();
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("serializes concurrent durable mutations and publishes atomically", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-mutations-"));
		const atomicWrite = vi.spyOn(FileSessionStorage.prototype, "writeTextAtomic");
		try {
			const sessionFile = path.join(directory, "session.jsonl");
			const manager = new CronManager({ sessionFile, enqueuePrompt: async () => undefined });
			const first = await manager.create({
				expression: "0 11 * * *",
				prompt: "delete me",
				recurring: false,
				durable: true,
			});
			const [, deleted] = await Promise.all([
				manager.create({
					expression: "0 12 * * *",
					prompt: "keep me",
					recurring: false,
					durable: true,
				}),
				manager.delete(first.id),
			]);

			expect(deleted).toBe(true);
			expect(manager.list().map(job => job.prompt)).toEqual(["keep me"]);
			expect(atomicWrite).toHaveBeenCalled();
			manager.dispose();
		} finally {
			atomicWrite.mockRestore();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("sanitizes and bounds pending delete identifiers", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const rendered = Bun.stripANSI(
			cronDeleteToolRenderer
				.renderCall(
					{ id: `cron\tbad\u0007\n\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007${"x".repeat(120)}` },
					{ expanded: false, isPartial: true },
					theme,
				)
				.render(200)
				.join("\n"),
		);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\u0007");
		expect(rendered).not.toContain("\u001b");
		expect(rendered).not.toContain("x".repeat(80));
	});

	it("sanitizes completed delete identifiers", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const rendered = Bun.stripANSI(
			cronDeleteToolRenderer
				.renderResult({ content: [], details: { deleted: false } }, { expanded: false, isPartial: false }, theme, {
					id: "cron\tbad\u0007\n\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007",
				})
				.render(200)
				.join("\n"),
		);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\u0007");
		expect(rendered).not.toContain("\u001b");
	});

	it("sanitizes and bounds completed create expressions", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const expression = `0\t11\t*\t*\t${"1".repeat(120)}`;
		const rendered = Bun.stripANSI(
			cronCreateToolRenderer
				.renderResult(
					{
						content: [],
						details: {
							id: "cron-1",
							expression,
							prompt: "first\nsecond\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007",
							recurring: false,
							durable: false,
							createdAt: 0,
							nextFireAt: Date.now(),
						},
					},
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(200)
				.join("\n"),
		);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("1".repeat(80));
		expect(rendered).toContain("first second");
		expect(rendered).not.toContain("\u001b");
	});

	it("sanitizes cron error output into one display line", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		const rendered = Bun.stripANSI(
			cronCreateToolRenderer
				.renderResult(
					{
						content: [
							{ type: "text", text: "bad\nerror\u001b]8;;https://example.com\u0007linked\u001b]8;;\u0007" },
						],
						isError: true,
					},
					{ expanded: false, isPartial: false },
					theme,
				)
				.render(200)
				.join("\n"),
		);
		expect(rendered).toContain("bad errorlinked");
		expect(rendered).not.toContain("\u001b");
	});
});

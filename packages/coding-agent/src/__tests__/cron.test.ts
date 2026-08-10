import { describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type CronJob, CronManager, type CronTimer, nextCronFire, parseCronExpression } from "../cron";
import { sessionSidecarDir } from "../session/session-paths";
import { FileSessionStorage, MemorySessionStorage } from "../session/session-storage";

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

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (await condition()) return;
		await Bun.sleep(1);
	}
	throw new Error(message);
}

describe("cron scheduling", () => {
	it("updates session-only jobs while preserving identity and next fire until expression changes", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {},
		});
		try {
			const original = await manager.create({ expression: "5 11 * * *", prompt: "first", recurring: true });
			clock.setNow(clock.now() + 30 * 60_000);
			const promptUpdated = await manager.update(original.id, { prompt: "second" });
			expect(promptUpdated).toMatchObject({
				id: original.id,
				durable: false,
				createdAt: original.createdAt,
				nextFireAt: original.nextFireAt,
				prompt: "second",
			});
			const expressionUpdated = await manager.update(original.id, { expression: "10 12 * * *", recurring: false });
			expect(expressionUpdated).toMatchObject({
				id: original.id,
				durable: false,
				createdAt: original.createdAt,
				expression: "10 12 * * *",
				recurring: false,
				expiresAt: undefined,
			});
			expect(expressionUpdated?.nextFireAt).toBe(nextCronFire("10 12 * * *", new Date(clock.now())).getTime());
		} finally {
			await manager.dispose();
		}
	});

	it("updates durable jobs through the claim and restores them when publication fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-update-rollback-"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const manager = new CronManager({
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {},
		});
		try {
			await manager.load();
			const original = await manager.create({
				expression: "5 11 * * *",
				prompt: "first",
				recurring: true,
				durable: true,
			});
			const failedWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockRejectedValueOnce(new Error("disk"));
			try {
				await expect(manager.update(original.id, { prompt: "second" })).rejects.toThrow("disk");
				expect(manager.list()).toEqual([original]);
				expect(await Bun.file(manager.storePath()).json()).toEqual([original]);
			} finally {
				failedWrite.mockRestore();
			}
			const updated = await manager.update(original.id, { prompt: "second", recurring: false });
			expect(updated).toMatchObject({
				id: original.id,
				durable: true,
				createdAt: original.createdAt,
				prompt: "second",
				recurring: false,
				expiresAt: undefined,
				nextFireAt: original.nextFireAt,
			});
			expect(await Bun.file(manager.storePath()).json()).toEqual([updated]);
		} finally {
			await manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

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

	it("advances a recurring job from delayed acceptance", async () => {
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
		const job = await manager.create({ expression: "* * * * *", prompt: "recurring", recurring: true });
		clock.setNow(job.nextFireAt);
		clock.timers.at(-1)?.();
		await waitFor(() => prompts.length === 1, "recurring delivery did not start");

		clock.setNow(job.nextFireAt + 3 * 60_000);
		accepted.resolve();
		await settle();

		expect(prompts).toEqual(["recurring"]);
		expect(manager.list()[0]?.nextFireAt).toBe(nextCronFire(job.expression, new Date(clock.now())).getTime());
		expect(clock.delays.at(-1)).toBe(60_000);
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
			await manager.load();
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
				await waitFor(() => prompts.length === 1 && clock.timers.length === 1, "delivery failure did not re-arm");

				expect(prompts).toEqual(["retry me"]);
				expect(manager.list()).toEqual([job]);
				expect(clock.timers).toHaveLength(1);
				expect(clock.delays.at(-1)).toBe(1_000);
				clock.timers.shift()?.();
				await waitFor(() => clock.timers.length === 1, "early retry did not re-arm");
				expect(prompts).toEqual(["retry me"]);
				expect(manager.list()).toEqual([job]);

				clock.setNow(job.nextFireAt + 1_000);
				clock.timers.shift()?.();
				await waitFor(() => manager.list().length === 0, "accepted retry did not persist");
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
			await manager.load();
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
			const renewLease = vi.spyOn(FileSessionStorage.prototype, "renewLease");
			try {
				clock.setNow(job.nextFireAt);
				clock.timers.shift()?.();
				await deliveryStarted.promise;

				expect(await Bun.file(manager.storePath()).json()).toEqual([job]);
				acceptDelivery.resolve();
				await consumed.promise;
				expect(renewLease).toHaveBeenCalled();
				expect(await Bun.file(manager.storePath()).json()).toEqual([]);
			} finally {
				atomicWrite.mockRestore();
				renewLease.mockRestore();
			}
		} finally {
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("waits for accepted durable consumption before disposal resolves", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-dispose-drain-"));
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
			await manager.load();
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "consume before teardown",
				recurring: false,
				durable: true,
			});
			const store = manager.storePath();
			const consumptionStarted = Promise.withResolvers<void>();
			const releaseConsumption = Promise.withResolvers<void>();
			let consumed = false;
			let leaseReleased = false;
			const originalWrite = FileSessionStorage.prototype.writeTextAtomic;
			const originalRelease = FileSessionStorage.prototype.releaseLease;
			const atomicWrite = vi
				.spyOn(FileSessionStorage.prototype, "writeTextAtomic")
				.mockImplementation(async function (this: FileSessionStorage, file, text) {
					consumptionStarted.resolve();
					await releaseConsumption.promise;
					await originalWrite.call(this, file, text);
					consumed = true;
				});
			const releaseLease = vi.spyOn(FileSessionStorage.prototype, "releaseLease").mockImplementation(async function (
				this: FileSessionStorage,
				leasePath,
				owner,
			) {
				await originalRelease.call(this, leasePath, owner);
				leaseReleased = true;
			});
			try {
				clock.setNow(job.nextFireAt);
				clock.timers.shift()?.();
				await deliveryStarted.promise;
				acceptDelivery.resolve();
				// The prompt is accepted and the consuming write is held open, so the
				// occurrence is owned by neither the store nor a retry right now.
				await consumptionStarted.promise;

				let disposed = false;
				const disposal = manager.dispose().then(() => {
					disposed = true;
				});
				await settle();
				expect(disposed).toBe(false);
				expect(consumed).toBe(false);
				expect(leaseReleased).toBe(false);

				releaseConsumption.resolve();
				await disposal;
				expect(consumed).toBe(true);
				expect(leaseReleased).toBe(true);
				expect(await Bun.file(store).json()).toEqual([]);
			} finally {
				atomicWrite.mockRestore();
				releaseLease.mockRestore();
			}
		} finally {
			await manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("disposes without deadlock when a delivery tears the scheduler down", async () => {
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		let disposedFromDelivery = false;
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {
				await manager.dispose();
				disposedFromDelivery = true;
			},
		});
		const job = await manager.create({ expression: "0 11 * * *", prompt: "tear down" });
		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();

		await waitFor(() => disposedFromDelivery, "disposal from inside a delivery never resolved");
		expect(clock.timers).toHaveLength(0);
	});

	it("claims a durable occurrence before overlapping managers deliver it", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-delivery-claim-"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const timersA: Array<() => void> = [];
		const timersB: Array<() => void> = [];
		const deliveryStarted = Promise.withResolvers<void>();
		const deliveryAccepted = Promise.withResolvers<void>();
		const acceptDelivery = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const options = {
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			clearTimer: () => undefined,
			enqueuePrompt: async (prompt: string) => {
				prompts.push(prompt);
				deliveryStarted.resolve();
				await acceptDelivery.promise;
				deliveryAccepted.resolve();
			},
		};
		const managerA = new CronManager({
			...options,
			setTimer: callback => {
				timersA.push(callback);
				return {} as CronTimer;
			},
		});
		const managerB = new CronManager({
			...options,
			setTimer: callback => {
				timersB.push(callback);
				return {} as CronTimer;
			},
		});
		try {
			const job = await managerA.create({
				expression: "1 10 * * *",
				prompt: "deliver once",
				recurring: false,
				durable: true,
			});
			await managerA.load();
			await managerB.load();
			clock.setNow(job.nextFireAt);
			timersA.at(-1)?.();
			await deliveryStarted.promise;
			timersB.at(-1)?.();
			await waitFor(() => timersB.length >= 2, "second manager did not defer its claimed occurrence");

			expect(prompts).toEqual(["deliver once"]);
			acceptDelivery.resolve();
			await deliveryAccepted.promise;
			await waitFor(
				async () => ((await Bun.file(managerA.storePath()).json()) as unknown[]).length === 0,
				"durable consumption was not persisted",
			);
			clock.setNow(job.nextFireAt + 1_000);
			timersB.at(-1)?.();
			await waitFor(() => managerB.list().length === 0, "second manager did not refresh the durable store");

			expect(prompts).toEqual(["deliver once"]);
			expect(managerB.list()).toEqual([]);
		} finally {
			managerA.dispose();
			managerB.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("serializes durable view refresh with an in-flight due delivery", async () => {
		const storage = new MemorySessionStorage();
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const deliveryStarted = Promise.withResolvers<void>();
		const acceptDelivery = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-refresh-delivery-${crypto.randomUUID()}.jsonl`),
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
				deliveryStarted.resolve();
				await acceptDelivery.promise;
			},
		});
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "deliver once",
				recurring: false,
				durable: true,
			});
			await manager.load();
			clock.setNow(job.nextFireAt);
			clock.timers.at(-1)?.();
			await deliveryStarted.promise;

			let refreshed = false;
			const refresh = manager.load().then(() => {
				refreshed = true;
			});
			await settle();
			expect(refreshed).toBe(false);

			acceptDelivery.resolve();
			await refresh;
			expect(prompts).toEqual(["deliver once"]);
			expect(manager.list()).toEqual([]);
		} finally {
			manager.dispose();
		}
	});

	it("preserves an occurrence that becomes due during durable view refresh", async () => {
		const storage = new MemorySessionStorage();
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-refresh-crosses-due-${crypto.randomUUID()}.jsonl`),
			storage,
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
				prompt: "crossed due boundary",
				recurring: false,
				durable: true,
			});
			const readStarted = Promise.withResolvers<void>();
			const releaseRead = Promise.withResolvers<void>();
			const readStore = storage.readText.bind(storage);
			let pause = true;
			vi.spyOn(storage, "readText").mockImplementation(async file => {
				if (pause) {
					pause = false;
					readStarted.resolve();
					await releaseRead.promise;
				}
				return readStore(file);
			});

			const refresh = manager.load();
			await readStarted.promise;
			clock.setNow(job.nextFireAt);
			releaseRead.resolve();
			await refresh;

			expect(manager.list()[0]?.nextFireAt).toBe(job.nextFireAt);
			clock.timers.at(-1)?.();
			await waitFor(() => prompts.length > 0, "the refreshed due occurrence was skipped");
			expect(prompts).toEqual(["crossed due boundary"]);
		} finally {
			manager.dispose();
		}
	});

	it("claims a durable occurrence through the configured storage", async () => {
		const storage = new MemorySessionStorage();
		const renewLease = vi.spyOn(storage, "renewLease");
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const timersA: Array<() => void> = [];
		const timersB: Array<() => void> = [];
		const deliveryStarted = Promise.withResolvers<void>();
		const acceptDelivery = Promise.withResolvers<void>();
		const prompts: string[] = [];
		const options = {
			sessionFile: path.join(os.tmpdir(), `cron-shared-claim-${crypto.randomUUID()}.jsonl`),
			storage,
			now: clock.now,
			clearTimer: () => undefined,
			enqueuePrompt: async (prompt: string) => {
				prompts.push(prompt);
				deliveryStarted.resolve();
				await acceptDelivery.promise;
			},
		};
		const managerA = new CronManager({
			...options,
			setTimer: callback => {
				timersA.push(callback);
				return {} as CronTimer;
			},
		});
		const managerB = new CronManager({
			...options,
			setTimer: callback => {
				timersB.push(callback);
				return {} as CronTimer;
			},
		});
		try {
			const job = await managerA.create({
				expression: "1 10 * * *",
				prompt: "deliver through shared storage",
				recurring: false,
				durable: true,
			});
			await managerA.load();
			await managerB.load();
			renewLease.mockClear();
			clock.setNow(job.nextFireAt);
			timersA.at(-1)?.();
			await deliveryStarted.promise;
			timersB.at(-1)?.();
			await waitFor(() => timersB.length >= 2, "second manager did not defer the shared lease");

			expect(prompts).toEqual(["deliver through shared storage"]);
			acceptDelivery.resolve();
			await waitFor(() => renewLease.mock.calls.length > 0, "accepted occurrence did not renew its lease");
			expect(managerA.list()).toEqual([]);
			clock.setNow(job.nextFireAt + 1_000);
			timersB.at(-1)?.();
			await waitFor(() => managerB.list().length === 0, "second manager did not refresh the shared store");
			expect(prompts).toEqual(["deliver through shared storage"]);
		} finally {
			managerA.dispose();
			managerB.dispose();
			renewLease.mockRestore();
		}
	});

	it("releases a durable delivery claim when refreshing the store fails", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cron-delivery-claim-read-"));
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(directory, "session.jsonl"),
			now: clock.now,
			setTimer: (callback, delay) => {
				timers.push(callback);
				delays.push(delay);
				return {} as CronTimer;
			},
			clearTimer: () => undefined,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const readStarted = Promise.withResolvers<void>();
		let readText: Mock<FileSessionStorage["readText"]> | undefined;
		try {
			const job = await manager.create({
				expression: "1 10 * * *",
				prompt: "deliver after reload",
				recurring: false,
				durable: true,
			});
			await manager.load();
			readText = vi.spyOn(FileSessionStorage.prototype, "readText").mockImplementationOnce(async () => {
				readStarted.resolve();
				throw new Error("backend unavailable");
			});

			clock.setNow(job.nextFireAt);
			timers.at(-1)?.();
			await readStarted.promise;
			const claimPath = `${manager.storePath()}.delivery`;
			const probe = new FileSessionStorage();
			await waitFor(
				() => probe.acquireLease(claimPath, "probe", clock.now() + 5 * 60 * 1_000, clock.now()),
				"failed reload retained the delivery claim",
			);
			await probe.releaseLease(claimPath, "probe");
			await waitFor(() => timers.length >= 2, "failed reload did not schedule a retry");

			expect(prompts).toEqual([]);
			expect(manager.list()).toEqual([job]);
			expect(delays.at(-1)).toBe(1_000);
		} finally {
			readText?.mockRestore();
			manager.dispose();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	it("delivers session-only work in a mixed batch when the durable backend fails", async () => {
		const storage = new MemorySessionStorage();
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-mixed-batch-${crypto.randomUUID()}.jsonl`),
			storage,
			now: clock.now,
			setTimer: (callback, delay) => {
				timers.push(callback);
				delays.push(delay);
				return {} as CronTimer;
			},
			clearTimer: () => undefined,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		let acquireLease: Mock<MemorySessionStorage["acquireLease"]> | undefined;
		try {
			const durable = await manager.create({
				expression: "1 10 * * *",
				prompt: "durable occurrence",
				recurring: true,
				durable: true,
			});
			await manager.create({
				expression: "1 10 * * *",
				prompt: "session-only occurrence",
				recurring: false,
				durable: false,
			});
			await manager.load();
			acquireLease = vi.spyOn(storage, "acquireLease").mockImplementation(async () => {
				throw new Error("durable backend offline");
			});

			clock.setNow(durable.nextFireAt);
			timers.at(-1)?.();
			await waitFor(() => prompts.length > 0, "durable failure starved the session-only occurrence");
			await settle();

			// The session-only half lands; the durable half waits on the ladder.
			expect(prompts).toEqual(["session-only occurrence"]);
			expect(manager.list().map(job => job.prompt)).toEqual(["durable occurrence"]);
			// Never re-arm at zero delay: that is what spun the failing backend.
			expect(delays.at(-1)).toBe(1_000);
			expect(acquireLease.mock.calls.length).toBe(1);

			// The retry wake probes durable storage once more, still without spinning.
			clock.setNow(durable.nextFireAt + 1_000);
			timers.at(-1)?.();
			await settle();
			expect(prompts).toEqual(["session-only occurrence"]);
			expect(acquireLease.mock.calls.length).toBe(2);
			expect(delays.at(-1)).toBe(2_000);
		} finally {
			acquireLease?.mockRestore();
			manager.dispose();
		}
	});

	it("backs off an expired durable occurrence instead of waking on its stale expiry", async () => {
		const storage = new MemorySessionStorage();
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const timers: Array<() => void> = [];
		const delays: number[] = [];
		const prompts: string[] = [];
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-stale-expiry-${crypto.randomUUID()}.jsonl`),
			storage,
			now: clock.now,
			setTimer: (callback, delay) => {
				timers.push(callback);
				delays.push(delay);
				return {} as CronTimer;
			},
			clearTimer: () => undefined,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		let acquireLease: Mock<MemorySessionStorage["acquireLease"]> | undefined;
		try {
			const durable = await manager.create({
				expression: "1 10 * * *",
				prompt: "expired durable occurrence",
				recurring: true,
				durable: true,
			});
			await manager.load();
			acquireLease = vi.spyOn(storage, "acquireLease").mockImplementation(async () => {
				throw new Error("durable backend offline");
			});

			// Past its lifetime, so the sweep wants to retire it but cannot.
			const expiresAt = durable.expiresAt;
			expect(expiresAt).toBeDefined();
			clock.setNow((expiresAt ?? 0) + 60_000);
			timers.at(-1)?.();
			await waitFor(() => delays.length >= 2, "failed expiry sweep did not re-arm");
			await settle();

			expect(prompts).toEqual([]);
			expect(manager.list().map(job => job.prompt)).toEqual(["expired durable occurrence"]);
			// A retirement that failed leaves `expiresAt` in the past; the wake has
			// to follow the retry instead.
			expect(delays.at(-1)).toBe(1_000);
			expect(acquireLease.mock.calls.length).toBe(1);
		} finally {
			acquireLease?.mockRestore();
			manager.dispose();
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

	it("refreshes indexed storage before copying a fork store", async () => {
		const storage = new MemorySessionStorage();
		const sessionA = path.join(os.tmpdir(), `cron-stale-parent-${crypto.randomUUID()}.jsonl`);
		const sessionB = path.join(os.tmpdir(), `cron-stale-fork-${crypto.randomUUID()}.jsonl`);
		const oldStore = path.join(sessionSidecarDir(sessionA), "scheduled_tasks.json");
		const newStore = path.join(sessionSidecarDir(sessionB), "scheduled_tasks.json");
		const text = '[{"id":"durable"}]\n';
		await storage.writeText(oldStore, text);
		let refreshed = false;
		const readText = storage.readText.bind(storage);
		vi.spyOn(storage, "readText").mockImplementation(async file => {
			if (file === oldStore && !refreshed) {
				throw Object.assign(new Error("stale index"), { code: "ENOENT" });
			}
			return readText(file);
		});
		Object.defineProperty(storage, "refresh", {
			value: async () => {
				refreshed = true;
			},
		});
		const manager = new CronManager({ sessionFile: sessionA, storage, enqueuePrompt: async () => undefined });

		await manager.copyForkStore(sessionA, sessionB);

		expect(refreshed).toBe(true);
		expect(await storage.readText(newStore)).toBe(text);
		await manager.dispose();
	});

	it("cancels a durable lease wait when the scheduler is suspended", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-suspend-lease-${crypto.randomUUID()}.jsonl`);
		const manager = new CronManager({ sessionFile, storage, enqueuePrompt: async () => undefined });
		const acquireLease = vi.spyOn(storage, "acquireLease").mockResolvedValue(false);
		const create = manager.create({
			expression: "0 11 * * *",
			prompt: "never acquire",
			durable: true,
		});
		await waitFor(() => acquireLease.mock.calls.length > 0, "durable mutation never attempted its lease");

		const suspended = await Promise.race([manager.suspend().then(() => true), Bun.sleep(500).then(() => false)]);

		expect(suspended).toBe(true);
		await expect(create).rejects.toThrow("Cron session changed while acquiring durable storage.");
		await manager.dispose();
	});

	it("retries a transient refresh load failure for the current session", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-refresh-${crypto.randomUUID()}.jsonl`);
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const job = {
			id: "cron-recovered",
			expression: "0 11 * * *",
			prompt: "recover me",
			recurring: false,
			durable: true,
			createdAt: clock.now(),
			nextFireAt: new Date(2026, 0, 1, 11, 0).getTime(),
		};
		const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
		await storage.writeText(store, JSON.stringify([job]));
		const readText = vi.spyOn(storage, "readText").mockRejectedValueOnce(new Error("backend unavailable"));
		const manager = new CronManager({
			sessionFile,
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => undefined,
		});

		manager.refresh();
		await settle();
		expect(clock.delays).toEqual([250]);
		clock.timers.shift()?.();
		await settle();
		expect(manager.list()).toEqual([job]);
		expect(readText).toHaveBeenCalledTimes(2);
		manager.dispose();
	});

	it("keeps retrying an initial schedule load past the startup attempt window", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-load-outage-${crypto.randomUUID()}.jsonl`);
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const job = {
			id: "cron-outage-survivor",
			expression: "0 11 * * *",
			prompt: "survive the outage",
			recurring: false,
			durable: true,
			createdAt: clock.now(),
			nextFireAt: new Date(2026, 0, 1, 11, 0).getTime(),
		};
		const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
		await storage.writeText(store, JSON.stringify([job]));
		const readStore = storage.readText.bind(storage);
		// Two failures beyond the six attempts the old finite window allowed, so
		// the recovery below is only reachable if the ladder outlives it.
		let failures = 8;
		const readText = vi.spyOn(storage, "readText").mockImplementation(async target => {
			if (failures > 0) {
				failures--;
				throw new Error("backend unavailable");
			}
			return readStore(target);
		});
		const manager = new CronManager({
			sessionFile,
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => undefined,
		});

		try {
			manager.refresh();
			await settle();

			const ladder: number[] = [];
			for (let wake = 0; wake < 8; wake++) {
				ladder.push(clock.delays.at(-1) ?? -1);
				clock.timers.at(-1)?.();
				await settle();
			}

			// Bounded backoff that saturates instead of ending: the sixth entry is
			// where the old horizon dropped the session with no timer armed.
			expect(ladder).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
			expect(manager.list()).toEqual([job]);
			expect(failures).toBe(0);
		} finally {
			readText.mockRestore();
			manager.dispose();
		}
	});

	it("creates and fires a session-only job while the durable store is unreadable", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-session-only-outage-${crypto.randomUUID()}.jsonl`);
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const stored = {
			id: "cron-durable-stored",
			expression: "0 11 * * *",
			prompt: "durable occurrence",
			recurring: false,
			durable: true,
			createdAt: clock.now(),
			nextFireAt: new Date(2026, 0, 1, 11, 0).getTime(),
		};
		const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
		await storage.writeText(store, JSON.stringify([stored]));
		const readStore = storage.readText.bind(storage);
		let offline = true;
		const readText = vi.spyOn(storage, "readText").mockImplementation(async target => {
			if (offline) throw new Error("backend unavailable");
			return readStore(target);
		});
		const manager = new CronManager({
			sessionFile,
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});

		try {
			manager.refresh();
			await settle();
			const retryWake = clock.timers[0];

			// The store is unreadable, so the durable view has not landed. A job
			// that needs no persistence must not be held hostage by that.
			const sessionOnly = await manager.create({
				expression: "30 10 * * *",
				prompt: "session-only occurrence",
				recurring: false,
				durable: false,
			});
			const cancelled = await manager.create({
				expression: "45 10 * * *",
				prompt: "cancel during outage",
				recurring: false,
				durable: false,
			});
			expect(await manager.delete(cancelled.id)).toBe(true);
			// The session is still not marked loaded: only the in-memory job is
			// visible, so nothing can arm against a map missing the stored one.
			expect(manager.list().map(entry => entry.prompt)).toEqual(["session-only occurrence"]);

			clock.setNow(sessionOnly.nextFireAt);
			clock.timers.at(-1)?.();
			await waitFor(() => prompts.length > 0, "the store outage starved the session-only occurrence");
			await settle();

			// It fires on its own schedule, before the durable view recovers.
			expect(prompts).toEqual(["session-only occurrence"]);
			expect(manager.list()).toEqual([]);

			offline = false;
			retryWake?.();
			await waitFor(() => manager.list().length > 0, "the retry ladder never landed the durable view");
			await settle();

			// The ladder lands the durable view and reconciles the stored job.
			expect(manager.list().map(entry => entry.prompt)).toEqual(["durable occurrence"]);

			clock.setNow(stored.nextFireAt);
			clock.timers.at(-1)?.();
			await waitFor(() => prompts.length > 1, "the recovered durable occurrence never fired");
			await settle();

			expect(prompts).toEqual(["session-only occurrence", "durable occurrence"]);
			expect(manager.list()).toEqual([]);
		} finally {
			readText.mockRestore();
			manager.dispose();
		}
	});

	it("reloads durable jobs a peer manager added after the first load", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-shared-reload-${crypto.randomUUID()}.jsonl`);
		const clock = fakeClock(new Date(2026, 0, 1, 10, 0).getTime());
		const prompts: string[] = [];
		const managerA = new CronManager({
			sessionFile,
			storage,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				prompts.push(prompt);
			},
		});
		const managerB = new CronManager({
			sessionFile,
			storage,
			now: clock.now,
			setTimer: () => ({}) as CronTimer,
			clearTimer: () => undefined,
			enqueuePrompt: async () => undefined,
		});

		try {
			await managerA.load();
			expect(managerA.list()).toEqual([]);

			const peerJob = await managerB.create({
				expression: "1 10 * * *",
				prompt: "peer durable occurrence",
				recurring: false,
				durable: true,
			});
			await managerB.dispose();

			// The store is shared. Marking the session loaded used to pin A to the
			// store as it stood at its first load, so a peer's durable job stayed
			// invisible and unarmed even though `cron_list` calls `load()`.
			await managerA.load();
			expect(managerA.list().map(job => job.prompt)).toEqual(["peer durable occurrence"]);

			clock.setNow(peerJob.nextFireAt);
			clock.timers.at(-1)?.();
			await waitFor(() => prompts.length > 0, "the peer's durable job was never armed");
			await settle();

			expect(prompts).toEqual(["peer durable occurrence"]);
		} finally {
			await managerA.dispose();
		}
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

	it("does not resume when a newer transition starts during fork recovery", async () => {
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-stale-recovery-${crypto.randomUUID()}.jsonl`),
			enqueuePrompt: async () => undefined,
		});
		let current = true;
		vi.spyOn(manager, "copyForkStore").mockImplementation(async () => {
			current = false;
		});
		const resume = vi.spyOn(manager, "resume");
		const result = {
			oldSessionFile: path.join(os.tmpdir(), "cron-parent.jsonl"),
			newSessionFile: path.join(os.tmpdir(), "cron-fork.jsonl"),
		};

		await manager.suspendForFork();
		await manager.completeFork(result, () => current);

		expect(resume).not.toHaveBeenCalled();
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

	it("delivers a recurring occurrence due exactly at expiry", async () => {
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
		const job = await manager.create({ expression: "0 0 * * 5", prompt: "weekly" });
		if (job.expiresAt === undefined) throw new Error("Expected a recurring expiry");
		expect(job.nextFireAt).toBe(job.expiresAt);

		clock.setNow(job.expiresAt);
		clock.timers.shift()?.();
		await settle();

		expect(prompts).toEqual(["weekly"]);
		expect(manager.list()).toEqual([]);
		manager.dispose();
	});

	it("schedules the final recurrence landing exactly on expiry", async () => {
		// Fri 2026-01-02 00:00 + the 7-day recurring lifetime lands on Fri
		// 2026-01-09 00:00, so a Mon/Fri expression fires once on the Monday and
		// then matches exactly on `expiresAt`. Advancing off that earlier
		// occurrence must schedule the boundary match rather than retire the job.
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
		const job = await manager.create({ expression: "0 0 * * 1,5", prompt: "boundary" });
		const expiresAt = job.expiresAt;
		if (expiresAt === undefined) throw new Error("Expected a recurring expiry");
		expect(job.nextFireAt).toBe(new Date(2026, 0, 5, 0, 0).getTime());
		expect(expiresAt).toBe(new Date(2026, 0, 9, 0, 0).getTime());

		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();
		await settle();

		// The occurrence before expiry delivers and the job survives, now armed
		// for the match that falls exactly on `expiresAt`.
		expect(prompts).toEqual(["boundary"]);
		expect(manager.list().map(entry => entry.nextFireAt)).toEqual([expiresAt]);

		clock.setNow(expiresAt);
		clock.timers.shift()?.();
		await settle();

		// The boundary occurrence is delivered exactly once, then retired.
		expect(prompts).toEqual(["boundary", "boundary"]);
		expect(manager.list()).toEqual([]);

		manager.dispose();
	});

	it("retries a final occurrence whose delivery failed on the expiry boundary", async () => {
		// Same Mon/Fri construction as above, so the last match lands exactly on
		// `expiresAt` and its retry necessarily falls past expiry.
		const clock = fakeClock(new Date(2026, 0, 2, 0, 0).getTime());
		const prompts: string[] = [];
		let failNext = false;
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async prompt => {
				if (failNext) {
					failNext = false;
					throw new Error("session busy");
				}
				prompts.push(prompt);
			},
		});
		const job = await manager.create({ expression: "0 0 * * 1,5", prompt: "boundary" });
		const expiresAt = job.expiresAt;
		if (expiresAt === undefined) throw new Error("Expected a recurring expiry");

		clock.setNow(job.nextFireAt);
		clock.timers.shift()?.();
		await settle();
		expect(prompts).toEqual(["boundary"]);

		// The occurrence landing exactly on expiry fails to enqueue.
		failNext = true;
		clock.setNow(expiresAt);
		clock.timers.shift()?.();
		await settle();

		// Retained with its attempt parked past `expiresAt` rather than retired:
		// the occurrence came due inside the lifetime, so it is still owed one.
		expect(prompts).toEqual(["boundary"]);
		expect(manager.list().map(entry => entry.nextFireAt)).toEqual([expiresAt]);

		clock.setNow(expiresAt + 1_000);
		clock.timers.shift()?.();
		await settle();

		// The retry lands the final prompt, then the strictly-later match retires.
		expect(prompts).toEqual(["boundary", "boundary"]);
		expect(manager.list()).toEqual([]);

		manager.dispose();
	});

	it("retires a final occurrence that never delivers within the retry grace", async () => {
		const clock = fakeClock(new Date(2026, 0, 2, 0, 0).getTime());
		const manager = new CronManager({
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
			enqueuePrompt: async () => {
				throw new Error("session busy");
			},
		});
		const job = await manager.create({ expression: "0 0 * * 1,5", prompt: "boundary" });
		const expiresAt = job.expiresAt;
		if (expiresAt === undefined) throw new Error("Expected a recurring expiry");

		clock.setNow(expiresAt);
		clock.timers.at(-1)?.();
		await settle();

		// Held for the retry rather than retired on the wall clock alone.
		expect(manager.list().map(entry => entry.prompt)).toEqual(["boundary"]);

		// The delivery ladder caps but never gives up, so the reprieve is bounded:
		// past the grace an undeliverable occurrence is abandoned instead of
		// retrying every minute for the rest of the session.
		clock.setNow(expiresAt + 5 * 60 * 1_000 + 1);
		clock.timers.at(-1)?.();
		await settle();

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

	it("rejects durable jobs when configured storage cannot lease", async () => {
		const storage = new MemorySessionStorage();
		Object.defineProperties(storage, {
			acquireLease: { value: undefined },
			releaseLease: { value: undefined },
		});
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-no-lease-${crypto.randomUUID()}.jsonl`),
			storage,
			enqueuePrompt: async () => undefined,
		});
		try {
			await expect(
				manager.create({
					expression: "0 11 * * *",
					prompt: "cannot deliver",
					recurring: false,
					durable: true,
				}),
			).rejects.toThrow("Durable cron jobs require storage lease support.");
			expect(manager.list()).toEqual([]);
		} finally {
			manager.dispose();
		}
	});

	it("keeps a committed durable mutation when lease release fails", async () => {
		const storage = new MemorySessionStorage();
		const releaseLease = vi.spyOn(storage, "releaseLease").mockRejectedValueOnce(new Error("backend unavailable"));
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		const manager = new CronManager({
			sessionFile: path.join(os.tmpdir(), `cron-release-failure-${crypto.randomUUID()}.jsonl`),
			storage,
			enqueuePrompt: async () => undefined,
		});
		try {
			const job = await manager.create({
				expression: "0 11 * * *",
				prompt: "remain committed",
				recurring: false,
				durable: true,
			});
			expect((JSON.parse(await storage.readText(manager.storePath())) as CronJob[]).map(item => item.id)).toEqual([
				job.id,
			]);
			expect(manager.list()).toEqual([job]);
			expect(warn).toHaveBeenCalledWith("Cron delivery claim release failed", {
				error: expect.any(Error),
			});
		} finally {
			manager.dispose();
			releaseLease.mockRestore();
			warn.mockRestore();
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

	it("merges durable mutations from overlapping managers", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-shared-mutations-${crypto.randomUUID()}.jsonl`);
		const now = new Date(2026, 0, 1, 10, 0).getTime();
		const options = { sessionFile, storage, now: () => now, enqueuePrompt: async () => undefined };
		const managerA = new CronManager(options);
		const managerB = new CronManager(options);
		try {
			await Promise.all([managerA.load(), managerB.load()]);
			const [first, second] = await Promise.all([
				managerA.create({
					expression: "0 11 * * *",
					prompt: "first",
					recurring: false,
					durable: true,
				}),
				managerB.create({
					expression: "0 12 * * *",
					prompt: "second",
					recurring: false,
					durable: true,
				}),
			]);
			expect(first.id).not.toBe(second.id);
			expect(
				(JSON.parse(await storage.readText(managerA.storePath())) as CronJob[]).map(job => job.prompt).sort(),
			).toEqual(["first", "second"]);

			const [deleted] = await Promise.all([
				managerA.delete(first.id),
				managerB.create({
					expression: "0 13 * * *",
					prompt: "third",
					recurring: false,
					durable: true,
				}),
			]);
			expect(deleted).toBe(true);
			expect(
				(JSON.parse(await storage.readText(managerA.storePath())) as CronJob[]).map(job => job.prompt).sort(),
			).toEqual(["second", "third"]);
		} finally {
			managerA.dispose();
			managerB.dispose();
		}
	});

	it("refreshes a stale indexed view before merging a durable mutation", async () => {
		const storage = new MemorySessionStorage();
		const sessionFile = path.join(os.tmpdir(), `cron-stale-index-${crypto.randomUUID()}.jsonl`);
		const now = new Date(2026, 0, 1, 10, 0).getTime();
		const originalReadText = storage.readText.bind(storage);
		const originalExists = storage.exists.bind(storage);
		let stale = false;
		const indexedStorage = storage as MemorySessionStorage & { refresh(): Promise<void> };
		indexedStorage.refresh = vi.fn(async () => {
			stale = false;
		});
		vi.spyOn(storage, "readText").mockImplementation(file =>
			stale
				? Promise.reject(Object.assign(new Error(`No such file: ${file}`), { code: "ENOENT" }))
				: originalReadText(file),
		);
		vi.spyOn(storage, "exists").mockImplementation(file => (stale ? Promise.resolve(false) : originalExists(file)));
		const options = { sessionFile, storage, now: () => now, enqueuePrompt: async () => undefined };
		const managerA = new CronManager(options);
		const managerB = new CronManager(options);
		try {
			await Promise.all([managerA.load(), managerB.load()]);
			await managerB.create({
				expression: "0 11 * * *",
				prompt: "peer",
				recurring: false,
				durable: true,
			});

			stale = true;
			await managerA.create({
				expression: "0 12 * * *",
				prompt: "local",
				recurring: false,
				durable: true,
			});

			expect(indexedStorage.refresh).toHaveBeenCalled();
			expect(
				(JSON.parse(await originalReadText(managerA.storePath())) as CronJob[]).map(job => job.prompt).sort(),
			).toEqual(["local", "peer"]);
		} finally {
			managerA.dispose();
			managerB.dispose();
		}
	});
});

import { describe, expect, it, mock } from "bun:test";
import { RootForegroundLease } from "./root-foreground-lease";

describe("RootForegroundLease", () => {
	it("admits root mutations in FIFO order and permits nested work from the current actor", async () => {
		const lease = new RootForegroundLease();
		const firstStarted = Promise.withResolvers<void>();
		const firstGate = Promise.withResolvers<void>();
		const order: string[] = [];
		const first = lease.run("root-cell", async () => {
			order.push("first:start");
			firstStarted.resolve();
			await lease.run("root-turn", async () => {
				order.push("first:nested");
			});
			await firstGate.promise;
			order.push("first:end");
		});
		await firstStarted.promise;
		const second = lease.run("root-turn", async () => {
			order.push("second");
		});
		const third = lease.run("compaction", async () => {
			order.push("third");
		});
		await Promise.resolve();
		expect(order).toEqual(["first:start", "first:nested"]);
		firstGate.resolve();
		await Promise.all([first, second, third]);
		expect(order).toEqual(["first:start", "first:nested", "first:end", "second", "third"]);
	});

	it("releases the holder once when foreground work fails", async () => {
		const lease = new RootForegroundLease();
		const failed = lease.run("root-cell", async () => {
			throw new Error("boom");
		});
		const later = mock(async () => {});
		const queued = lease.run("root-turn", later);
		await expect(failed).rejects.toThrow("boom");
		await queued;
		expect(later).toHaveBeenCalledTimes(1);
	});

	it("admits Act only under the correlated foreground token", async () => {
		const lease = new RootForegroundLease();
		await lease.run("root-cell", async () => {
			const nested = await lease.acquire("root-cell");
			const exit = lease.enterAct(nested.token);
			exit();
			expect(() => lease.enterAct(Symbol("other"))).toThrow("not correlated");
		});
	});

	it("rejects queued admission on abort or disposal without running work", async () => {
		const lease = new RootForegroundLease();
		const gate = Promise.withResolvers<void>();
		const active = lease.run("root-cell", () => gate.promise);
		const abort = new AbortController();
		const abortedWork = mock(async () => {});
		const aborted = lease.run("root-turn", abortedWork, abort.signal);
		abort.abort();
		await expect(aborted).rejects.toThrow("admission aborted");
		const disposedWork = mock(async () => {});
		const disposed = lease.run("compaction", disposedWork);
		lease.dispose(new Error("session gone"));
		await expect(disposed).rejects.toThrow("session gone");
		expect(abortedWork).not.toHaveBeenCalled();
		expect(disposedWork).not.toHaveBeenCalled();
		gate.resolve();
		await active;
	});
});

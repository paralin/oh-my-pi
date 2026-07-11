import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type CronParams, type CronRuntime, type CronTool, createCronRuntime } from "../src/cron/index.js";

describe("cron extension", () => {
	let tool: CronTool;
	let runtime: CronRuntime;
	let now: number;
	const sendUserMessage = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		now = Date.parse("2026-07-11T12:00:00.000Z");
		sendUserMessage.mockClear();
		runtime = createCronRuntime({ sendUserMessage }, () => now);
		tool = runtime.tool;
	});

	afterEach(() => {
		runtime.dispose();
		vi.useRealTimers();
	});

	async function execute(params: CronParams) {
		return tool.execute("call-1", params, AbortSignal.timeout(1_000), () => {}, {} as never);
	}

	it("delivers the scheduled text as a follow-up user message after the delay", async () => {
		const result = await execute({ action: "set", delay_seconds: 600, message: "Re-check the pull requests." });
		expect(result.details?.jobs).toHaveLength(1);

		vi.advanceTimersByTime(599_999);
		expect(sendUserMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(sendUserMessage).toHaveBeenCalledWith("Re-check the pull requests.", { deliverAs: "followUp" });

		const list = await execute({ action: "list" });
		expect(list.details?.jobs).toEqual([]);
	});

	it("coalesces nine missed recurring intervals into one catch-up delivery", async () => {
		await execute({
			action: "set",
			delay_seconds: 60,
			interval_seconds: 60,
			message: "Check the long-running job.",
		});

		now = Date.parse("2026-07-11T12:10:00.000Z");
		vi.runOnlyPendingTimers();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith("Check the long-running job.", { deliverAs: "followUp" });
		const list = await execute({ action: "list" });
		expect(list.details?.jobs).toEqual([
			expect.objectContaining({
				dueAt: "2026-07-11T12:11:00.000Z",
				intervalSeconds: 60,
			}),
		]);
	});

	it("delivers an overdue one-shot timer once and removes it", async () => {
		await execute({ action: "set", delay_seconds: 60, message: "Wake once." });

		now = Date.parse("2026-07-11T12:10:00.000Z");
		vi.runOnlyPendingTimers();

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const list = await execute({ action: "list" });
		expect(list.details?.jobs).toEqual([]);
	});

	it("does not replay in-process timers after runtime restart", async () => {
		await execute({
			action: "set",
			delay_seconds: 60,
			interval_seconds: 60,
			message: "Do not survive restart.",
		});
		runtime.dispose();

		runtime = createCronRuntime({ sendUserMessage }, () => now);
		tool = runtime.tool;
		now = Date.parse("2026-07-11T12:10:00.000Z");
		vi.runOnlyPendingTimers();

		expect(sendUserMessage).not.toHaveBeenCalled();
		const list = await execute({ action: "list" });
		expect(list.details?.jobs).toEqual([]);
	});

	it("cancels a pending timer", async () => {
		const result = await execute({ action: "set", delay_seconds: 60, message: "Do not deliver." });
		const id = result.details?.jobs[0]?.id;
		expect(id).toBeDefined();
		await execute({ action: "cancel", id });

		vi.advanceTimersByTime(60_000);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});

	it("clears pending timers when the session shuts down", async () => {
		await execute({ action: "set", delay_seconds: 60, message: "Do not outlive the process." });
		runtime.dispose();

		vi.advanceTimersByTime(60_000);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});

import { afterEach, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { type CronParams, type CronRuntime, type CronTool, createCronRuntime } from "../src/cron/index.js";

describe("cron extension", () => {
	let tool: CronTool;
	let runtime: CronRuntime;
	const sendUserMessage = vi.fn();

	beforeEach(() => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
		sendUserMessage.mockClear();
		runtime = createCronRuntime({ sendUserMessage });
		tool = runtime.tool;
	});

	afterEach(() => {
		runtime.dispose();
		vi.useRealTimers();
		setSystemTime();
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

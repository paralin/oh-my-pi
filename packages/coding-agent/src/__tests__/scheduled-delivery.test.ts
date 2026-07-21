import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildScheduledNotification,
	SCHEDULED_NOTIFICATION_KIND,
	type ScheduledNotificationEntry,
} from "../session/scheduled-notification";
import { YieldQueue } from "../session/yield-queue";

/** Model the exact session wiring the cron delivery owner depends on: the shared
 *  yield-queue routes a fired scheduled prompt to the next tool-call boundary
 *  while streaming (drainLazy at the aside poll) and wakes a turn while idle
 *  (scheduled flush -> injectIdle). */
function harness() {
	let streaming = false;
	const idleInjected: AgentMessage[][] = [];
	const idleFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectIdle: async messages => {
			idleInjected.push(messages);
		},
		scheduleIdleFlush: run => {
			idleFlushes.push(run);
		},
	});
	queue.register<ScheduledNotificationEntry>(SCHEDULED_NOTIFICATION_KIND, { build: buildScheduledNotification });
	queue.register<{ note: string }>("advisor", {
		skipIdleFlush: true,
		build: entries =>
			({
				role: "custom",
				customType: "advisor",
				display: false,
				content: entries.map(entry => entry.note).join(","),
				timestamp: 0,
			}) satisfies AgentMessage,
	});
	return {
		queue,
		idleInjected,
		idleFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		notifyIdle: () => queue.notifyIdle(),
		fire: (prompt: string) => queue.enqueue(SCHEDULED_NOTIFICATION_KIND, { prompt }),
		drainBoundary: (): AgentMessage[] =>
			queue
				.drainLazy()
				.map(thunk => thunk())
				.filter((message): message is AgentMessage => message !== null),
	};
}

function customMessage(message: AgentMessage): Extract<AgentMessage, { role: "custom" }> {
	if (message.role !== "custom") throw new Error("Expected a custom message.");
	return message;
}

describe("scheduled prompt delivery routing", () => {
	it("delivers a fire during an active turn at the next tool boundary, not before and not on idle", () => {
		const h = harness();
		// Active turn -> cron fires. No idle flush is scheduled: delivery does not
		// wait for Escape, idle, or any interactive input, and does not fire before
		// the tool call completes.
		h.setStreaming(true);
		h.fire("boundary ping");
		expect(h.idleFlushes).toEqual([]);
		expect(h.idleInjected).toEqual([]);
		// One completed tool call/result -> the aside poll drains the notification.
		const messages = h.drainBoundary();
		expect(messages).toHaveLength(1);
		const message = customMessage(messages[0]!);
		expect(message.attribution).toBe("agent");
		expect(message.content).toContain("boundary ping");
		// Drained exactly once: a later boundary yields no duplicate.
		expect(h.drainBoundary()).toEqual([]);
	});

	it("re-arms a late active-turn fire at the idle transition without waking skip-idle kinds", async () => {
		const h = harness();
		h.setStreaming(true);
		// The final aside poll already ran before the scheduled job fired.
		expect(h.drainBoundary()).toEqual([]);
		h.fire("tail ping");
		h.queue.enqueue("advisor", { note: "deferred advice" });

		h.setStreaming(false);
		h.notifyIdle();
		expect(h.idleFlushes).toHaveLength(1);
		await h.idleFlushes[0]!();

		const idleMessage = h.idleInjected[0]?.[0];
		if (!idleMessage) throw new Error("Expected a scheduled idle notification.");
		const notification = customMessage(idleMessage);
		expect(notification.customType).toBe("scheduled:notification");
		expect(notification.content).toContain("tail ping");
		expect(h.queue.has(SCHEDULED_NOTIFICATION_KIND)).toBe(false);
		// Advisor entries intentionally wait for a later boundary and must not be
		// drained or included in the scheduled idle wake.
		expect(h.queue.has("advisor")).toBe(true);
		h.setStreaming(true);
		const laterBoundary = h.drainBoundary();
		expect(
			laterBoundary.some(message => message.role === "custom" && message.customType === "scheduled:notification"),
		).toBe(false);
	});

	it("wakes a turn when a job fires while idle", async () => {
		const h = harness();
		h.fire("idle ping");
		expect(h.idleFlushes).toHaveLength(1);
		await h.idleFlushes[0]!();
		expect(h.idleInjected).toHaveLength(1);
		const woken = h.idleInjected[0]!;
		expect(woken).toHaveLength(1);
		const wokenMessage = customMessage(woken[0]!);
		expect(wokenMessage.attribution).toBe("agent");
		expect(wokenMessage.content).toContain("idle ping");
	});

	it("batches multiple due jobs into one boundary notification", () => {
		const h = harness();
		h.setStreaming(true);
		h.fire("first");
		h.fire("second");
		const messages = h.drainBoundary();
		expect(messages).toHaveLength(1);
		const message = customMessage(messages[0]!);
		expect(message.content).toContain("first");
		expect(message.content).toContain("second");
	});
});

import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildScheduledNotification,
	SCHEDULED_NOTIFICATION_KIND,
	type ScheduledNotificationEntry,
} from "../session/scheduled-notification";
import { YieldQueue } from "../session/yield-queue";

type SystemNotificationEntry = { content: string };

function buildSystemNotification(entries: SystemNotificationEntry[]): AgentMessage {
	return {
		role: "custom",
		customType: "system:notification",
		content: entries.map(entry => entry.content).join("\n"),
		display: true,
		attribution: "agent",
		timestamp: 0,
	};
}

/** Model the exact session wiring the notification delivery owner depends on:
 * streaming entries steer through the agent immediately, while idle entries
 * schedule a wake turn through injectIdle. */
function harness() {
	let streaming = false;
	const idleInjected: AgentMessage[][] = [];
	const streamingInjected: AgentMessage[] = [];
	const idleFlushes: Array<() => Promise<void>> = [];
	const queue = new YieldQueue({
		isStreaming: () => streaming,
		injectStreaming: message => {
			streamingInjected.push(message);
		},
		injectIdle: async messages => {
			idleInjected.push(messages);
		},
		scheduleIdleFlush: run => {
			idleFlushes.push(run);
		},
	});
	queue.register<ScheduledNotificationEntry>(SCHEDULED_NOTIFICATION_KIND, {
		build: buildScheduledNotification,
		interruptStreaming: true,
	});
	queue.register<SystemNotificationEntry>("system-notification", {
		build: buildSystemNotification,
		interruptStreaming: true,
	});
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
		streamingInjected,
		idleFlushes,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
		fire: (prompt: string) => queue.enqueue(SCHEDULED_NOTIFICATION_KIND, { prompt }),
		fireBatch: (prompts: string[]) =>
			queue.enqueueMany(
				SCHEDULED_NOTIFICATION_KIND,
				prompts.map(prompt => ({ prompt })),
			),
		drainBoundary: (): AgentMessage[] =>
			queue
				.drainLazy()
				.map(thunk => thunk())
				.filter((message): message is AgentMessage => message !== null),
		fireSystem: (content: string) => queue.enqueue("system-notification", { content }),
	};
}

function customMessage(message: AgentMessage): Extract<AgentMessage, { role: "custom" }> {
	if (message.role !== "custom") throw new Error("Expected a custom message.");
	return message;
}

function textContent(message: AgentMessage): string {
	const { content } = customMessage(message);
	if (typeof content !== "string") throw new Error("Expected textual notification content.");
	return content;
}
describe("scheduled prompt delivery routing", () => {
	it("interrupts an active turn through the streaming owner without a duplicate boundary delivery", () => {
		const h = harness();
		h.setStreaming(true);
		h.fire("blocking wait notification");
		expect(h.idleFlushes).toEqual([]);
		expect(h.idleInjected).toEqual([]);
		expect(h.streamingInjected).toHaveLength(1);
		const message = customMessage(h.streamingInjected[0]!);
		expect(message.attribution).toBe("agent");
		expect(message.content).toContain("blocking wait notification");
		expect(h.drainBoundary()).toEqual([]);
		expect(h.streamingInjected).toHaveLength(1);
	});
	it("interrupts one streaming turn with a batch of simultaneous tasks", () => {
		const h = harness();
		h.setStreaming(true);
		h.fireBatch(["first scheduled task", "second scheduled task"]);

		// The whole batch has to land before the streaming flush drains it;
		// otherwise the first prompt steers alone and the second arrives as a
		// second notification.
		expect(h.streamingInjected).toHaveLength(1);
		const content = textContent(h.streamingInjected[0]!);
		expect(content).toContain("2 scheduled tasks fired");
		expect(content).toContain("first scheduled task");
		expect(content).toContain("second scheduled task");
		expect(content.indexOf("first scheduled task")).toBeLessThan(content.indexOf("second scheduled task"));
		expect(h.idleFlushes).toEqual([]);
		expect(h.idleInjected).toEqual([]);
		expect(h.drainBoundary()).toEqual([]);
		expect(h.streamingInjected).toHaveLength(1);
	});
	it("interrupts a comparable system notification in arrival order", () => {
		const h = harness();
		h.setStreaming(true);
		h.fireSystem("first system notification");
		h.fireSystem("second system notification");

		expect(h.streamingInjected).toHaveLength(2);
		expect(h.streamingInjected.map(message => customMessage(message).content)).toEqual([
			"first system notification",
			"second system notification",
		]);
		expect(h.drainBoundary()).toEqual([]);
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

	it("batches multiple due jobs into one idle notification", async () => {
		const h = harness();
		h.fire("first");
		h.fire("second");
		expect(h.idleFlushes).toHaveLength(1);
		await h.idleFlushes[0]!();
		const batch = h.idleInjected[0];
		if (!batch?.[0]) throw new Error("Expected an idle notification batch.");
		const message = customMessage(batch[0]);
		expect(message.content).toContain("first");
		expect(message.content).toContain("second");
	});

	it("wakes one turn for a batch of simultaneous tasks while idle", async () => {
		const h = harness();
		h.fireBatch(["first idle task", "second idle task"]);
		expect(h.idleFlushes).toHaveLength(1);
		expect(h.streamingInjected).toEqual([]);
		await h.idleFlushes[0]!();
		expect(h.idleInjected).toHaveLength(1);
		const batch = h.idleInjected[0]!;
		expect(batch).toHaveLength(1);
		const content = textContent(batch[0]!);
		expect(content).toContain("2 scheduled tasks fired");
		expect(content).toContain("first idle task");
		expect(content).toContain("second idle task");
	});
	it("keeps a scheduled prompt queued when RPC custody refuses the idle wake", async () => {
		let canWakeIdle = false;
		const idleInjected: AgentMessage[][] = [];
		const queue = new YieldQueue({
			isStreaming: () => false,
			canWakeIdle: () => canWakeIdle,
			injectIdle: async messages => {
				idleInjected.push(messages);
			},
			scheduleIdleFlush: () => {},
		});
		queue.register<ScheduledNotificationEntry>(SCHEDULED_NOTIFICATION_KIND, {
			build: buildScheduledNotification,
			interruptStreaming: true,
		});
		queue.enqueue(SCHEDULED_NOTIFICATION_KIND, { prompt: "deliver after custody" });

		expect(await queue.flush("idle", SCHEDULED_NOTIFICATION_KIND)).toEqual(new Set());
		expect(queue.has(SCHEDULED_NOTIFICATION_KIND)).toBe(true);
		expect(idleInjected).toEqual([]);

		canWakeIdle = true;
		expect(await queue.flush("idle", SCHEDULED_NOTIFICATION_KIND)).toEqual(new Set([SCHEDULED_NOTIFICATION_KIND]));
		expect(queue.has(SCHEDULED_NOTIFICATION_KIND)).toBe(false);
		expect(idleInjected).toHaveLength(1);
		expect(textContent(idleInjected[0]![0]!)).toContain("deliver after custody");
	});
});

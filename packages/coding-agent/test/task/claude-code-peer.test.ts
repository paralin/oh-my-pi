import { afterEach, describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ClaudeCodeInputMailbox, ClaudeCodePeer } from "@oh-my-pi/pi-coding-agent/task/claude-code-peer";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("ClaudeCodeInputMailbox", () => {
	it("preserves turn order and distinguishes idle wakes from busy queues", async () => {
		const mailbox = new ClaudeCodeInputMailbox("initial");
		const input = mailbox[Symbol.asyncIterator]();

		expect(await input.next()).toEqual({ done: false, value: "initial" });
		expect(mailbox.turnIdle).toBe(false);
		expect(mailbox.completeTurn()).toBe(true);

		const waiting = input.next();
		expect(mailbox.enqueue("wake")).toBe("woken");
		expect(await waiting).toEqual({ done: false, value: "wake" });
		expect(mailbox.enqueue("busy follow-up")).toBe("queued");
		expect(mailbox.completeTurn()).toBe(false);
		expect(await input.next()).toEqual({ done: false, value: "busy follow-up" });
		expect(mailbox.completeTurn()).toBe(true);

		mailbox.close();
		expect(await input.next()).toEqual({ done: true, value: undefined });
	});

	it("settles eagerly consumed queued inputs at one SDK result boundary", async () => {
		const mailbox = new ClaudeCodeInputMailbox("initial");
		const input = mailbox[Symbol.asyncIterator]();
		await input.next();
		mailbox.completeTurn();

		const first = input.next();
		expect(mailbox.enqueue("first")).toBe("woken");
		expect((await first).value).toBe("first");
		const second = input.next();
		expect(mailbox.enqueue("second")).toBe("queued");
		expect((await second).value).toBe("second");

		expect(mailbox.completeTurn()).toBe(true);
		mailbox.close();
	});
});

describe("ClaudeCodePeer", () => {
	it("routes owner async results into its mailbox and removes the sink on dispose", async () => {
		const registry = AgentRegistry.global();
		const jobs = new AsyncJobManager({ retentionMs: 60_000 });
		const peer = new ClaudeCodePeer({
			id: "Claude",
			prompt: "initial",
			abortController: new AbortController(),
			registry,
			asyncJobManager: jobs,
		});
		const ref = registry.register({ id: "Claude", displayName: "claude", kind: "sub", session: peer });
		peer.bindRef(ref);
		const input = peer.input[Symbol.asyncIterator]();
		expect((await input.next()).value).toBe("initial");
		expect(peer.completeTurn()).toBe(true);

		const delivered = input.next();
		jobs.register("bash", "proof", async () => "owner result", { id: "job-1", ownerId: "Claude" });
		await jobs.waitForAll();
		expect(await jobs.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Claude" } })).toBe(true);
		const result = await delivered;
		expect(result.done).toBe(false);
		expect(result.value).toContain("job-1");
		expect(result.value).toContain("owner result");
		expect(registry.get("Claude")?.status).toBe("running");

		peer.completeTurn();
		await peer.dispose();
		expect(await input.next()).toEqual({ done: true, value: undefined });

		jobs.register("bash", "after dispose", async () => "must not arrive", {
			id: "job-2",
			ownerId: "Claude",
		});
		await jobs.waitForAll();
		expect(await jobs.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Claude" } })).toBe(true);
		expect(peer.messages.some(message => JSON.stringify(message).includes("must not arrive"))).toBe(false);
		await jobs.dispose({ timeoutMs: 1_000 });
	});
});

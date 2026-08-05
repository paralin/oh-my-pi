import { describe, expect, test } from "bun:test";
import { WORLD_MAILBOX_CAP, WorldMailboxRouter } from "@oh-my-pi/pi-coding-agent/coordination/world-mailbox";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { AgentPeer } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { WorldClient } from "@oh-my-pi/pi-coding-agent/world/client";
import type { AgentMessageSummary } from "../../src/world/generated/llmsession.pb.js";
import { PeerMessageAckOutcome } from "../../src/world/generated/llmsession.pb.js";

function summary(index: number, overrides: Partial<AgentMessageSummary> = {}): AgentMessageSummary {
	return {
		messageObjectKey: `glados/messages/${index}`,
		fromAgentObjectKey: "glados/agents/sender",
		sourceLlmSessionObjectKey: "glados/sessions/sender",
		clientMessageId: `message-${index}`,
		body: `body ${index}`,
		createdAt: `2026-08-04T12:00:${String(index % 60).padStart(2, "0")}Z`,
		inboxSequence: BigInt(index),
		...overrides,
	};
}

class MailboxClient {
	readonly messages: AgentMessageSummary[];
	readonly acknowledgements: Parameters<WorldClient["ackPeerMessage"]>[0][] = [];
	readonly processed = Promise.withResolvers<void>();
	holdOpen = true;

	constructor(messages: AgentMessageSummary[]) {
		this.messages = messages;
	}

	watchPeerMailbox(signal?: AbortSignal): ReturnType<WorldClient["watchPeerMailbox"]> {
		const messages = this.messages;
		const holdOpen = this.holdOpen;
		return (async function* () {
			for (const message of messages) yield message;
			if (holdOpen) {
				await new Promise<void>(resolve => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
		})();
	}

	async ackPeerMessage(
		request: Parameters<WorldClient["ackPeerMessage"]>[0],
	): ReturnType<WorldClient["ackPeerMessage"]> {
		this.acknowledgements.push(request);
		if (this.acknowledgements.length === this.messages.length) this.processed.resolve();
		return {
			requestId: request.requestId,
			messageObjectKey: request.messageObjectKey,
			consumedByLlmSessionObjectKey: "glados/sessions/receiver",
			consumedAt: "2026-08-04T12:01:00Z",
			replayed: false,
		};
	}
}

function receiver(
	deliveries: IrcMessage[],
	outcome: "injected" | "queued" | "woken" = "injected",
): Pick<AgentPeer, "deliverIrcMessage"> {
	return {
		deliverIrcMessage: async message => {
			deliveries.push(message);
			return outcome;
		},
	};
}

function router(client: MailboxClient, target: Pick<AgentPeer, "deliverIrcMessage">): WorldMailboxRouter {
	return new WorldMailboxRouter({
		client,
		receiverPeerId: "receiver",
		receiver: target,
		resolveSender: async () => "sender",
	});
}

describe("WorldMailboxRouter", () => {
	test("gives a matching waiter first claim and acknowledges the exact record", async () => {
		const client = new MailboxClient([
			summary(1, {
				replyToClientMessageId: "question-1",
				expectsReply: true,
			}),
		]);
		const deliveries: IrcMessage[] = [];
		const mailbox = router(client, receiver(deliveries));
		const waiting = mailbox.wait({ from: "sender", replyTo: "question-1" }, 1_000);
		mailbox.start();

		expect(await waiting).toEqual({
			id: "message-1",
			from: "sender",
			to: "receiver",
			body: "body 1",
			ts: Date.parse("2026-08-04T12:00:01Z"),
			replyTo: "question-1",
			expectsReply: true,
			inboxSequence: 1n,
			source: "world",
		});
		await client.processed.promise;
		expect(deliveries).toEqual([]);
		expect(client.acknowledgements).toEqual([
			expect.objectContaining({
				messageObjectKey: "glados/messages/1",
				outcome: PeerMessageAckOutcome.WAITER,
			}),
		]);
		expect(mailbox.inbox()).toEqual([]);
		await mailbox.close();
	});

	test("passes unmatched records through the session and retains a bounded local inbox", async () => {
		const client = new MailboxClient(Array.from({ length: WORLD_MAILBOX_CAP + 1 }, (_, index) => summary(index + 1)));
		const deliveries: IrcMessage[] = [];
		const mailbox = router(client, receiver(deliveries, "queued"));
		mailbox.start();
		await client.processed.promise;

		expect(deliveries).toHaveLength(WORLD_MAILBOX_CAP + 1);
		expect(client.acknowledgements).toHaveLength(WORLD_MAILBOX_CAP + 1);
		expect(client.acknowledgements[0]?.outcome).toBe(PeerMessageAckOutcome.QUEUED);
		const peeked = mailbox.inbox({ peek: true });
		expect(peeked).toHaveLength(WORLD_MAILBOX_CAP);
		expect(peeked[0]?.id).toBe("message-2");
		expect(mailbox.inbox()).toEqual(peeked);
		expect(mailbox.inbox()).toEqual([]);
		await mailbox.close();
	});

	test("delivers a duplicate watch record once and repeats the idempotent acknowledgement", async () => {
		const record = summary(1);
		const client = new MailboxClient([record, record]);
		const deliveries: IrcMessage[] = [];
		const mailbox = router(client, receiver(deliveries, "woken"));
		mailbox.start();
		await client.processed.promise;

		expect(deliveries).toHaveLength(1);
		expect(client.acknowledgements).toHaveLength(2);
		expect(client.acknowledgements[0]).toEqual(client.acknowledgements[1]);
		expect(client.acknowledgements[0]?.outcome).toBe(PeerMessageAckOutcome.WOKEN);
		await mailbox.close();
	});

	test("leaves failed local delivery unacknowledged so a fresh router redelivers", async () => {
		const client = new MailboxClient([summary(1)]);
		const first = router(client, {
			deliverIrcMessage: async () => {
				throw new Error("local handoff failed");
			},
		});
		first.start();
		await expect(first.done).rejects.toThrow("local handoff failed");
		expect(client.acknowledgements).toEqual([]);

		const deliveries: IrcMessage[] = [];
		const second = router(client, receiver(deliveries));
		second.start();
		await client.processed.promise;
		expect(deliveries.map(message => message.id)).toEqual(["message-1"]);
		expect(client.acknowledgements).toHaveLength(1);
		await second.close();
	});

	test("rejects a durable record without a positive inbox sequence before acknowledgement", async () => {
		const client = new MailboxClient([summary(1, { inboxSequence: 0n })]);
		const mailbox = router(client, receiver([]));
		mailbox.start();

		await expect(mailbox.done).rejects.toThrow("has no positive inbox sequence");
		expect(client.acknowledgements).toEqual([]);
		await mailbox.close();
	});

	test("treats an unexpected mailbox stream end as a routing failure", async () => {
		const client = new MailboxClient([]);
		client.holdOpen = false;
		const mailbox = router(client, receiver([]));
		mailbox.start();

		await expect(mailbox.done).rejects.toThrow("ended unexpectedly");
		await mailbox.close();
	});

	test("close cancels the watch and active waiters without acknowledgement", async () => {
		const client = new MailboxClient([]);
		client.holdOpen = true;
		const mailbox = router(client, receiver([]));
		mailbox.start();
		const waiting = mailbox.wait({ from: "sender" }, 0);

		await mailbox.close();
		await expect(waiting).rejects.toThrow("World mailbox router closed");
		expect(client.acknowledgements).toEqual([]);
	});
});

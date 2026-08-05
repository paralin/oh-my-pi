import type { IrcMessage } from "../irc/bus";
import type { AgentPeer } from "../registry/agent-registry";
import type { WorldClient } from "../world/client";
import type { AgentMessageSummary } from "../world/generated/llmsession.pb";
import { PeerMessageAckOutcome } from "../world/generated/llmsession.pb";

/** Maximum accepted World messages retained for an explicit Hub inbox drain. */
export const WORLD_MAILBOX_CAP = 100;

export interface WorldMailboxFilter {
	from?: string;
	replyTo?: string;
}

type WorldMailboxClient = Pick<WorldClient, "ackPeerMessage" | "watchPeerMailbox">;
type WorldMailboxReceiver = Pick<AgentPeer, "deliverIrcMessage">;
type AcceptedOutcome = "waiter" | "injected" | "queued" | "woken";

interface MailboxWaiter {
	filter: WorldMailboxFilter;
	resolve: (message: IrcMessage | null) => void;
	reject: (error: Error) => void;
	cancel: () => void;
}

export interface WorldMailboxRouterOptions {
	client: WorldMailboxClient;
	receiverPeerId: string;
	receiver: WorldMailboxReceiver;
	resolveSender(message: AgentMessageSummary, signal?: AbortSignal): Promise<string>;
}

const ACK_OUTCOME: Readonly<Record<AcceptedOutcome, PeerMessageAckOutcome>> = {
	waiter: PeerMessageAckOutcome.WAITER,
	injected: PeerMessageAckOutcome.INJECTED,
	queued: PeerMessageAckOutcome.QUEUED,
	woken: PeerMessageAckOutcome.WOKEN,
};

/**
 * Routes the caller-bound durable mailbox into one local session. Acknowledged
 * records are retained only in the bounded local inbox needed by Hub.
 */
export class WorldMailboxRouter {
	readonly #options: WorldMailboxRouterOptions;
	readonly #controller = new AbortController();
	readonly #mailbox: IrcMessage[] = [];
	readonly #waiters: MailboxWaiter[] = [];
	readonly #accepted = new Map<string, PeerMessageAckOutcome>();
	#pump: Promise<void> | undefined;
	#failure: Error | undefined;
	#closed = false;

	constructor(options: WorldMailboxRouterOptions) {
		this.#options = options;
	}

	/** Start the sole caller-bound watch. Idempotent. */
	start(): void {
		if (this.#pump) return;
		if (this.#closed) throw new Error("World mailbox router is closed");
		const pump = this.#run();
		pump.catch(error => {
			if (this.#controller.signal.aborted) return;
			this.#failure = error instanceof Error ? error : new Error(String(error));
			this.#cancelWaiters(this.#failure);
		});
		this.#pump = pump;
	}

	/** Exposes the watch lifetime for focused runtime checks. */
	get done(): Promise<void> | undefined {
		return this.#pump;
	}

	/** Drain or inspect matching records from the bounded locally accepted inbox. */
	inbox(options: { peek?: boolean; from?: string; replyTo?: string; limit?: number } = {}): IrcMessage[] {
		if (this.#failure) throw this.#failure;
		const filter = { from: options.from, replyTo: options.replyTo };
		const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, options.limit);
		const selected: IrcMessage[] = [];
		const remaining: IrcMessage[] = [];
		for (const message of this.#mailbox) {
			if (selected.length < limit && matches(message, filter)) selected.push(message);
			else remaining.push(message);
		}
		if (!options.peek) {
			this.#mailbox.splice(0, this.#mailbox.length, ...remaining);
		}
		return selected;
	}

	/** Consume one accepted message matching sender and reply correlation. */
	async wait(filter: WorldMailboxFilter, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null> {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("World mailbox router is closed");
		if (signal?.aborted)
			throw signal.reason instanceof Error ? signal.reason : new Error("World mailbox wait aborted");
		const pending = this.#takeInbox(filter);
		if (pending) return pending;

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const waiter: MailboxWaiter = {
			filter,
			resolve: message => {
				cleanup();
				resolve(message);
			},
			reject: error => {
				cleanup();
				reject(error);
			},
			cancel: () => cleanup(),
		};
		const cleanup = (): void => {
			const index = this.#waiters.indexOf(waiter);
			if (index !== -1) this.#waiters.splice(index, 1);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		};
		if (signal) {
			onAbort = () =>
				waiter.reject(signal.reason instanceof Error ? signal.reason : new Error("World mailbox wait aborted"));
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => waiter.resolve(null), timeoutMs);
			timer.unref?.();
		}
		this.#waiters.push(waiter);
		return await promise;
	}

	/** Stop the watch and local waiters without acknowledging another record. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const reason = new Error("World mailbox router closed");
		this.#controller.abort(reason);
		this.#cancelWaiters(reason);
		await this.#pump?.catch(() => undefined);
	}

	async #run(): Promise<void> {
		for await (const summary of this.#options.client.watchPeerMailbox(this.#controller.signal)) {
			await this.#accept(summary);
		}
		if (!this.#controller.signal.aborted) throw new Error("World mailbox watch ended unexpectedly");
	}

	async #accept(summary: AgentMessageSummary): Promise<void> {
		const messageObjectKey = summary.messageObjectKey?.trim();
		if (!messageObjectKey) throw new Error("World mailbox record has no message object key");
		const remembered = this.#accepted.get(messageObjectKey);
		if (remembered !== undefined) {
			await this.#ack(messageObjectKey, remembered);
			return;
		}
		const message = await this.#message(summary);
		const waiter = this.#takeWaiter(message);
		let outcome: AcceptedOutcome;
		if (waiter) {
			waiter.resolve(message);
			outcome = "waiter";
		} else {
			outcome = await this.#options.receiver.deliverIrcMessage(message, {
				expectsReply: message.expectsReply,
			});
			this.#mailbox.push(message);
			if (this.#mailbox.length > WORLD_MAILBOX_CAP) this.#mailbox.shift();
		}
		const wireOutcome = ACK_OUTCOME[outcome];
		this.#accepted.set(messageObjectKey, wireOutcome);
		if (this.#accepted.size > WORLD_MAILBOX_CAP) {
			const oldest = this.#accepted.keys().next();
			if (!oldest.done) this.#accepted.delete(oldest.value);
		}
		await this.#ack(messageObjectKey, wireOutcome);
	}

	async #message(summary: AgentMessageSummary): Promise<IrcMessage> {
		const id = summary.clientMessageId;
		if (!id || id.trim() !== id) throw new Error("World mailbox record has an invalid client message ID");
		const from = await this.#options.resolveSender(summary, this.#controller.signal);
		const createdAt = Date.parse(summary.createdAt ?? "");
		if (Number.isNaN(createdAt)) throw new Error(`World mailbox message ${id} has an invalid creation time`);
		const inboxSequence = summary.inboxSequence;
		if (inboxSequence === undefined || inboxSequence <= 0n) {
			throw new Error(`World mailbox message ${id} has no positive inbox sequence`);
		}
		const replyTo = summary.replyToClientMessageId;
		if (replyTo !== undefined && (!replyTo || replyTo.trim() !== replyTo)) {
			throw new Error(`World mailbox message ${id} has an invalid reply client message ID`);
		}
		return {
			id,
			from,
			to: this.#options.receiverPeerId,
			body: summary.body ?? "",
			ts: createdAt,
			...(replyTo ? { replyTo } : {}),
			expectsReply: summary.expectsReply ?? false,
			inboxSequence,
			source: "world",
		};
	}

	async #ack(messageObjectKey: string, outcome: PeerMessageAckOutcome): Promise<void> {
		const digest = Bun.SHA256.hash(`${messageObjectKey}\0${outcome}`, "hex").slice(0, 32);
		await this.#options.client.ackPeerMessage(
			{
				requestId: `world-peer-ack:${digest}`,
				messageObjectKey,
				outcome,
			},
			this.#controller.signal,
		);
	}

	#takeWaiter(message: IrcMessage): MailboxWaiter | undefined {
		const index = this.#waiters.findIndex(waiter => matches(message, waiter.filter));
		if (index === -1) return undefined;
		const [waiter] = this.#waiters.splice(index, 1);
		return waiter;
	}

	#takeInbox(filter: WorldMailboxFilter): IrcMessage | undefined {
		const index = this.#mailbox.findIndex(message => matches(message, filter));
		if (index === -1) return undefined;
		const [message] = this.#mailbox.splice(index, 1);
		return message;
	}

	#cancelWaiters(error: Error): void {
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

function matches(message: IrcMessage, filter: WorldMailboxFilter): boolean {
	return (!filter.from || message.from === filter.from) && (!filter.replyTo || message.replyTo === filter.replyTo);
}

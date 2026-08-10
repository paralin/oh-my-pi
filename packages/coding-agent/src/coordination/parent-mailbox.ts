import type { IrcMessage } from "../irc/bus";
import { type ParentClient, ParentEndpointError } from "../parent/client";
import type { AgentMessageSummary } from "../parent/generated/parent-environment.pb";
import { PeerMessageAckOutcome } from "../parent/generated/parent-environment.pb";
import type { AgentPeer } from "../registry/agent-registry";

/** Maximum accepted Parent messages retained for an explicit Hub inbox drain. */
export const PARENT_MAILBOX_CAP = 100;

export interface ParentMailboxFilter {
	from?: string;
	fromAny?: ReadonlySet<string>;
	replyTo?: string;
}

type ParentMailboxClient = Pick<ParentClient, "ackPeerMessage" | "watchPeerMailbox"> & {
	readonly connected?: boolean;
};
type ParentMailboxReceiver = Pick<AgentPeer, "deliverIrcMessage">;
type AcceptedOutcome = "waiter" | "injected" | "queued" | "woken";

interface MailboxWaiter {
	filter: ParentMailboxFilter;
	resolve: (message: IrcMessage | null) => void;
	reject: (error: Error) => void;
	cancel: () => void;
}

export interface ParentMailboxRouterOptions {
	client: ParentMailboxClient;
	receiverPeerId: string;
	receiver: ParentMailboxReceiver;
	/** Generation identity used to reject late records from a retired watch. */
	generation?: number;
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
export class ParentMailboxRouter {
	readonly #options: ParentMailboxRouterOptions;
	readonly #controller = new AbortController();
	readonly #mailbox: IrcMessage[] = [];
	readonly #waiters: MailboxWaiter[] = [];
	readonly #accepted = new Map<string, PeerMessageAckOutcome>();
	#pump: Promise<void> | undefined;
	#failure: Error | undefined;
	#restartTimer: NodeJS.Timeout | undefined;
	#closed = false;

	constructor(options: ParentMailboxRouterOptions) {
		this.#options = options;
	}

	/** Start the sole caller-bound watch. Idempotent. */
	start(): void {
		if (this.#pump) return;
		if (this.#closed) throw new Error("Parent mailbox router is closed");
		const pump = this.#run();
		this.#pump = pump;
		pump.catch(error => {
			if (this.#controller.signal.aborted) return;
			if (error instanceof ParentEndpointError || this.#options.client.connected === false) {
				this.#pump = undefined;
				this.#restartTimer = setTimeout(() => {
					this.#restartTimer = undefined;
					if (!this.#closed) this.start();
				}, 250);
				this.#restartTimer.unref?.();
				return;
			}
			this.#failure = error instanceof Error ? error : new Error(String(error));
			this.#cancelWaiters(this.#failure);
		});
	}

	/** Exposes the watch lifetime for focused runtime checks. */
	get done(): Promise<void> | undefined {
		return this.#pump;
	}

	/** Drain or inspect matching records from the bounded locally accepted inbox. */
	inbox(
		options: { peek?: boolean; from?: string; fromAny?: ReadonlySet<string>; replyTo?: string; limit?: number } = {},
	): IrcMessage[] {
		if (this.#failure) throw this.#failure;
		const filter = { from: options.from, fromAny: options.fromAny, replyTo: options.replyTo };
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
	async wait(filter: ParentMailboxFilter, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null> {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("Parent mailbox router is closed");
		if (signal?.aborted)
			throw signal.reason instanceof Error ? signal.reason : new Error("Parent mailbox wait aborted");
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
				waiter.reject(signal.reason instanceof Error ? signal.reason : new Error("Parent mailbox wait aborted"));
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
		clearTimeout(this.#restartTimer);
		this.#restartTimer = undefined;
		const reason = new Error("Parent mailbox router closed");
		this.#controller.abort(reason);
		this.#cancelWaiters(reason);
		await this.#pump?.catch(() => undefined);
	}

	async #run(): Promise<void> {
		for await (const summary of this.#options.client.watchPeerMailbox(this.#controller.signal)) {
			await this.#accept(summary);
		}
		if (!this.#controller.signal.aborted) throw new Error("Parent mailbox watch ended unexpectedly");
	}

	async #accept(summary: AgentMessageSummary): Promise<void> {
		if (this.#closed) return;
		const messageId = summary.messageId?.trim();
		if (!messageId) throw new Error("Parent mailbox record has no message object key");
		const remembered = this.#accepted.get(messageId);
		if (remembered !== undefined) {
			await this.#ack(messageId, remembered);
			return;
		}
		const message = await this.#message(summary);
		if (this.#closed) return;
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
			if (this.#mailbox.length > PARENT_MAILBOX_CAP) this.#mailbox.shift();
		}
		const wireOutcome = ACK_OUTCOME[outcome];
		this.#accepted.set(messageId, wireOutcome);
		if (this.#accepted.size > PARENT_MAILBOX_CAP) {
			const oldest = this.#accepted.keys().next();
			if (!oldest.done) this.#accepted.delete(oldest.value);
		}
		await this.#ack(messageId, wireOutcome);
	}

	async #message(summary: AgentMessageSummary): Promise<IrcMessage> {
		const id = summary.clientMessageId;
		if (!id || id.trim() !== id) throw new Error("Parent mailbox record has an invalid client message ID");
		const from = await this.#options.resolveSender(summary, this.#controller.signal);
		const createdAt = Date.parse(summary.createdAt ?? "");
		if (Number.isNaN(createdAt)) throw new Error(`Parent mailbox message ${id} has an invalid creation time`);
		const inboxSequence = summary.inboxSequence;
		if (inboxSequence === undefined || inboxSequence <= 0n) {
			throw new Error(`Parent mailbox message ${id} has no positive inbox sequence`);
		}
		const replyTo = summary.replyToClientMessageId;
		if (replyTo !== undefined && (!replyTo || replyTo.trim() !== replyTo)) {
			throw new Error(`Parent mailbox message ${id} has an invalid reply client message ID`);
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
			source: "parent",
		};
	}

	async #ack(messageId: string, outcome: PeerMessageAckOutcome): Promise<void> {
		const digest = Bun.SHA256.hash(`${messageId}\0${outcome}`, "hex").slice(0, 32);
		await this.#options.client.ackPeerMessage(
			{
				requestId: `parent-peer-ack:${digest}`,
				messageId,
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

	#takeInbox(filter: ParentMailboxFilter): IrcMessage | undefined {
		const index = this.#mailbox.findIndex(message => matches(message, filter));
		if (index === -1) return undefined;
		const [message] = this.#mailbox.splice(index, 1);
		return message;
	}

	#cancelWaiters(error: Error): void {
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

function matches(message: IrcMessage, filter: ParentMailboxFilter): boolean {
	return (
		(!filter.from || message.from === filter.from) &&
		(!filter.fromAny || filter.fromAny.has(message.from)) &&
		(!filter.replyTo || message.replyTo === filter.replyTo)
	);
}

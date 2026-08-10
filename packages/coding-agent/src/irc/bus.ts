/**
 * IrcBus - Process-global mailbox bus for agent-to-agent messaging.
 *
 * Replaces the old auto-reply model: a `send` never blocks on the recipient
 * generating anything. Delivery resolves the recipient through the global
 * AgentRegistry. Parked agents are revived through AgentLifecycleManager.
 * Idle agents wake with a real turn. Busy sessions either accept a
 * non-interrupting aside at the next step boundary or queue the message at
 * their next input boundary. Replies are real turns by
 * the recipient, observed via `wait` — with one exception: when the sender
 * awaits a reply and the recipient cannot run a real reply turn in time
 * (mid-turn with async execution disabled — possibly blocked in a
 * synchronous task spawn whose batch includes the sender — or idle in plan
 * mode, where autonomous wake turns are suppressed), the recipient session
 * generates an ephemeral side-channel auto-reply.
 */

import { logger, Snowflake } from "@oh-my-pi/pi-utils";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { isAgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";

export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/** Sender is waiting for a correlated reply. Durable parent messages preserve this bit. */
	expectsReply?: boolean;
	/** Durable target-inbox order when the message came from the parent mailbox. */
	inboxSequence?: bigint;
	/** Durable messages carry this marker so replies use the selected coordination backend. */
	source?: "parent";
}

export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "queued" | "woken" | "revived" | "failed";
	error?: string;
	/** Durable World storage state when outcome is queued. */
	queueOutcome?: "queued_live" | "queued_inactive";
}

/** Delivery failure that cannot succeed for a later generation of the recipient. */
export class PermanentIrcDeliveryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PermanentIrcDeliveryError";
	}
}

export interface IrcMessageFilter {
	from?: string;
	fromAny?: ReadonlySet<string>;
	replyTo?: string;
}

export type IrcOutboundMessage = Omit<IrcMessage, "id" | "ts"> & Partial<Pick<IrcMessage, "id" | "ts">>;

interface IrcWaiter extends IrcMessageFilter {
	resolve: (msg: IrcMessage) => void;
	cancel: () => void;
}

/** Mailbox cap per agent; oldest messages are dropped beyond it. */
const MAILBOX_CAP = 100;

export class IrcBus {
	static #global: IrcBus | undefined;

	static global(): IrcBus {
		if (!IrcBus.#global) {
			IrcBus.#global = new IrcBus();
		}
		return IrcBus.#global;
	}

	/** Reset the global bus. Test-only. */
	static resetGlobalForTests(): void {
		IrcBus.#global = undefined;
	}

	readonly #registry: AgentRegistry;
	readonly #lifecycle: () => AgentLifecycleManager;
	readonly #mailboxes = new Map<string, IrcMessage[]>();
	readonly #waiters = new Map<string, IrcWaiter[]>();

	constructor(registry: AgentRegistry = AgentRegistry.global(), lifecycle?: AgentLifecycleManager) {
		this.#registry = registry;
		// Lazy: the lifecycle global self-constructs against the global registry,
		// so only touch it when a parked recipient actually needs reviving.
		this.#lifecycle = () => lifecycle ?? AgentLifecycleManager.global();
	}

	/**
	 * Fire-and-forget delivery. Never blocks on the recipient generating
	 * anything. The receipt reports how the message reached the recipient:
	 * waiter/aside = "injected", busy input = "queued", idle wake = "woken",
	 * and park revival = "revived".
	 *
	 * Mailbox semantics: a successfully delivered message never lingers in
	 * the recipient's mailbox — injection/wake puts the full body into their
	 * context, so buffering it too would double-deliver via a later
	 * `wait`/`inbox` and inflate unread counts. Only a failed live hand-off
	 * is buffered for the recipient to drain later.
	 *
	 * `opts.expectsReply` marks sends whose caller is blocked on an answer
	 * (`send await:true`). It is forwarded to the recipient session so a
	 * mid-turn recipient that cannot reach a step boundary (async execution
	 * disabled — e.g. blocked in a synchronous task spawn awaiting the
	 * sender's own batch) can generate an ephemeral side-channel auto-reply
	 * instead of stranding the sender until timeout.
	 *
	 * `opts.suppressRelay` skips the display-only main-UI relay for this leg.
	 * Set by broadcast fan-out when the same broadcast also targets the main
	 * agent directly: the main agent then already sees the body as its own
	 * incoming card, so relaying the sibling legs would duplicate it.
	 */
	async send(
		msg: IrcOutboundMessage,
		opts?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const message: IrcMessage = { ...msg, id: msg.id ?? Snowflake.next(), ts: msg.ts ?? Date.now() };
		const ref = this.#registry.get(message.to);
		if (!ref) {
			return {
				to: message.to,
				outcome: "failed",
				error: `Unknown agent "${message.to}" — check \`irc list\` for live peers.`,
			};
		}
		if (ref.status === "aborted") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" was hard-aborted and cannot be messaged or revived. Its transcript remains readable at history://${message.to}.`,
			};
		}
		// Advisor refs are observability-only transcripts, never messageable peers.
		if (ref.kind === "advisor") {
			return {
				to: message.to,
				outcome: "failed",
				error: `Agent "${message.to}" is a read-only advisor transcript and cannot be messaged.`,
			};
		}

		// A `parked` recipient always needs the lifecycle to revive it — this is
		// read from *this* bus's registry, so it holds for any registry. The
		// mid-park / adopted checks below query the lifecycle's own state, which
		// only describes the registry it manages: consult them only when the
		// lifecycle owns this bus's registry, otherwise a custom-registry bus
		// (fallen back to the global manager) would gate a live recipient on
		// unrelated global park state. Main/non-adopted live peers skip the gate,
		// and pending waiters still win without a session.
		const lifecycle = this.#lifecycle();
		const lifecycleOwnsRegistry = lifecycle.manages(this.#registry);
		const needsLifecycleGate =
			ref.status === "parked" ||
			(lifecycleOwnsRegistry && (lifecycle.isParking(message.to) || lifecycle.has(message.to)));

		const priorSession = ref.session;
		let revived = false;
		if (needsLifecycleGate) {
			try {
				const liveSession = await lifecycle.ensureLive(message.to);
				// Revival = we did not keep the same live instance (parked start, or
				// park completed and a fresh session was rebuilt).
				revived = !priorSession || liveSession !== priorSession;
			} catch (error) {
				// Not revivable / released / revive failed. Do not buffer: a permanent
				// failure must not inflate unread counts or pretend delivery is pending.
				return {
					to: message.to,
					outcome: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}

		// A pending `wait` from the recipient consumes the message directly —
		// it is returned from their irc tool call and never hits the inbox or
		// the session injection path.
		const waiter = this.#takeMatchingWaiter(message.to, message);
		if (waiter) {
			waiter.resolve(message);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : "injected" };
		}

		const session = this.#registry.get(message.to)?.session;
		if (!session) {
			return { to: message.to, outcome: "failed", error: `Agent "${message.to}" has no live session.` };
		}

		try {
			const delivery = await session.deliverIrcMessage(message, opts);
			if (!opts?.suppressRelay) this.#relayToMainUi(message);
			return { to: message.to, outcome: revived ? "revived" : delivery };
		} catch (error) {
			// A transient live hand-off failure is buffered for a later
			// `wait`/`inbox`. A permanent runtime capability failure cannot become
			// deliverable when another generation later reuses the same ID.
			if (!(error instanceof PermanentIrcDeliveryError)) this.#enqueue(message);
			return {
				to: message.to,
				outcome: "failed",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Block until a message for `agentId` (optionally from `filter.from`)
	 * arrives; consume + return it. Null on timeout (`timeoutMs <= 0` waits
	 * forever). Rejects when `signal` aborts. By default, already-buffered
	 * mail satisfies the wait before parking a future waiter; callers that
	 * need a strictly future reply can disable that drain.
	 */
	async wait(
		agentId: string,
		filter: IrcMessageFilter,
		timeoutMs: number,
		signal?: AbortSignal,
		options?: { drainPending?: boolean; liveness?: { registry: AgentRegistry; senderId: string } },
	): Promise<IrcMessage | null> {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted");
		}

		if (options?.drainPending !== false) {
			// Already-pending mail satisfies the wait without parking a waiter.
			const pending = this.#takeFromMailbox(agentId, filter);
			if (pending) return pending;
		}

		const { promise, resolve, reject } = Promise.withResolvers<IrcMessage | null>();
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		let unsubscribeLiveness: (() => void) | undefined;

		const liveness = options?.liveness;
		const livenessReason = filter.from
			? `IRC wait aborted: agent "${filter.from}" is not running`
			: "IRC wait aborted: no running peers remain";

		const settle = (
			outcome: { kind: "message"; msg: IrcMessage } | { kind: "timeout" } | { kind: "abort"; error: Error },
		): void => {
			cleanup();
			if (outcome.kind === "message") {
				resolve(outcome.msg);
			} else if (outcome.kind === "timeout") {
				resolve(null);
			} else {
				reject(outcome.error);
			}
		};

		const cleanup = (): void => {
			this.#removeWaiter(agentId, waiter);
			clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
			unsubscribeLiveness?.();
		};

		const waiter: IrcWaiter = {
			...filter,
			resolve: msg => settle({ kind: "message", msg }),
			cancel: () => cleanup(),
		};

		if (signal) {
			onAbort = () =>
				settle({
					kind: "abort",
					error: signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"),
				});
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
			timer.unref?.();
		}

		let waiters = this.#waiters.get(agentId);
		if (!waiters) {
			waiters = [];
			this.#waiters.set(agentId, waiters);
		}
		waiters.push(waiter);

		if (liveness) {
			const { registry, senderId } = liveness;
			const hasRunningSender = (from?: string): boolean =>
				registry.listVisibleTo(senderId).some(ref => ref.status === "running" && (!from || ref.id === from));
			const check = filter.from ? () => hasRunningSender(filter.from) : () => hasRunningSender();
			unsubscribeLiveness = registry.onChange(() => {
				if (!check()) {
					settle({ kind: "abort", error: new Error(livenessReason) });
				}
			});
			if (!check()) {
				settle({ kind: "abort", error: new Error(livenessReason) });
			}
		}

		return promise;
	}

	/** Drain (or peek) pending messages for `agentId`, preserving unmatched entries. */
	inbox(
		agentId: string,
		opts?: IrcMessageFilter & { peek?: boolean; limit?: number; ids?: ReadonlySet<string> },
	): IrcMessage[] {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox || mailbox.length === 0) return [];
		const selected: IrcMessage[] = [];
		const remaining: IrcMessage[] = [];
		const limit = opts?.limit ?? Number.POSITIVE_INFINITY;
		for (const message of mailbox) {
			const matches =
				selected.length < limit &&
				(opts?.from === undefined || message.from === opts.from) &&
				(opts?.fromAny === undefined || opts.fromAny.has(message.from)) &&
				(opts?.replyTo === undefined || message.replyTo === opts.replyTo) &&
				(opts?.ids === undefined || opts.ids.has(message.id));
			if (matches) selected.push(message);
			if (!matches || opts?.peek) remaining.push(message);
		}
		if (!opts?.peek) {
			if (remaining.length > 0) this.#mailboxes.set(agentId, remaining);
			else this.#mailboxes.delete(agentId);
		}
		return selected;
	}

	unreadCount(agentId: string): number {
		return this.#mailboxes.get(agentId)?.length ?? 0;
	}

	#enqueue(message: IrcMessage): void {
		let mailbox = this.#mailboxes.get(message.to);
		if (!mailbox) {
			mailbox = [];
			this.#mailboxes.set(message.to, mailbox);
		}
		mailbox.push(message);
		if (mailbox.length > MAILBOX_CAP) {
			const dropped = mailbox.shift();
			logger.debug("IrcBus: mailbox full, dropped oldest message", {
				agentId: message.to,
				droppedId: dropped?.id,
				droppedFrom: dropped?.from,
			});
		}
	}

	/** Resolve the oldest waiter whose sender and reply filters accept the message. */
	#takeMatchingWaiter(agentId: string, message: IrcMessage): IrcWaiter | undefined {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return undefined;
		const index = waiters.findIndex(
			waiter =>
				(waiter.from === undefined || waiter.from === message.from) &&
				(waiter.fromAny === undefined || waiter.fromAny.has(message.from)) &&
				(waiter.replyTo === undefined || waiter.replyTo === message.replyTo),
		);
		if (index === -1) return undefined;
		const [waiter] = waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
		return waiter;
	}

	#removeWaiter(agentId: string, waiter: IrcWaiter): void {
		const waiters = this.#waiters.get(agentId);
		if (!waiters) return;
		const index = waiters.indexOf(waiter);
		if (index !== -1) waiters.splice(index, 1);
		if (waiters.length === 0) this.#waiters.delete(agentId);
	}

	#takeFromMailbox(agentId: string, filter: IrcMessageFilter): IrcMessage | undefined {
		const mailbox = this.#mailboxes.get(agentId);
		if (!mailbox) return undefined;
		const index = mailbox.findIndex(
			message =>
				(filter.from === undefined || message.from === filter.from) &&
				(filter.fromAny === undefined || filter.fromAny.has(message.from)) &&
				(filter.replyTo === undefined || message.replyTo === filter.replyTo),
		);
		if (index === -1 || mailbox.length === 0) return undefined;
		const [message] = mailbox.splice(index, 1);
		if (mailbox.length === 0) this.#mailboxes.delete(agentId);
		return message;
	}

	/**
	 * Surface agent↔agent traffic as a display-only card on the main session
	 * UI. Skipped when the main agent is either endpoint: as recipient its
	 * own `deliverIrcMessage` (or `wait` tool result) already shows the
	 * message, and as sender the irc send tool call already rendered the
	 * outbound body — relaying it again would duplicate it in the transcript.
	 */
	#relayToMainUi(message: IrcMessage): void {
		if (message.to === MAIN_AGENT_ID || message.from === MAIN_AGENT_ID) return;
		const mainSession = this.#registry.get(MAIN_AGENT_ID)?.session;
		if (!isAgentSession(mainSession)) return;
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:relay",
			content: `[IRC \`${message.from}\` → \`${message.to}\`]\n\n${message.body}`,
			display: true,
			details: { from: message.from, to: message.to, body: message.body },
			attribution: "agent",
			timestamp: message.ts,
		};
		try {
			mainSession.emitIrcRelayObservation(record);
		} catch (error) {
			// Display-only forwarding must never affect delivery semantics.
			logger.debug("IrcBus: main UI relay failed", { to: message.to, error: String(error) });
		}
	}
}

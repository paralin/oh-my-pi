import type { IrcMessage } from "../irc/bus";
import type { AgentHistorySnapshot, AgentPeer, AgentStatus } from "../registry/agent-registry";
import type { WorldClient } from "../world/client";
import type { SessionSnapshot, SessionSummary, SessionTurn } from "../world/generated/llmsession.pb";

/** A lifecycle value that the World projection cannot map without guessing. */
export class WorldPeerProjectionError extends Error {
	readonly peerId: string;
	readonly sessionObjectKey: string;
	readonly state: string;

	constructor(peerId: string, sessionObjectKey: string, state: string) {
		super(`World peer ${peerId} session ${sessionObjectKey} has unknown lifecycle state ${JSON.stringify(state)}`);
		this.name = "WorldPeerProjectionError";
		this.peerId = peerId;
		this.sessionObjectKey = sessionObjectKey;
		this.state = state;
	}
}

export interface WorldSessionLifecycle {
	status: AgentStatus;
	inactive: boolean;
	mailboxLive: boolean;
}

const SESSION_LIFECYCLE: Readonly<Record<string, WorldSessionLifecycle>> = {
	LLM_SESSION_STATE_CREATED: { status: "running", inactive: false, mailboxLive: true },
	LLM_SESSION_STATE_LIVE: { status: "running", inactive: false, mailboxLive: true },
	LLM_SESSION_STATE_AWAITING_PROCESS: { status: "running", inactive: false, mailboxLive: true },
	LLM_SESSION_STATE_BLOCKED: { status: "idle", inactive: false, mailboxLive: true },
	LLM_SESSION_STATE_AWAITING_USER: { status: "idle", inactive: false, mailboxLive: true },
	LLM_SESSION_STATE_DORMANT: { status: "parked", inactive: false, mailboxLive: false },
	LLM_SESSION_STATE_COMPLETE: { status: "idle", inactive: true, mailboxLive: false },
	LLM_SESSION_STATE_ARCHIVED: { status: "idle", inactive: true, mailboxLive: false },
	LLM_SESSION_STATE_FAILED: { status: "aborted", inactive: true, mailboxLive: false },
	LLM_SESSION_STATE_CANCELED: { status: "aborted", inactive: true, mailboxLive: false },
};

/** Map one exact GLaDOS LlmSession lifecycle string onto the current AgentRef states. */
export function worldSessionLifecycle(peerId: string, session: SessionSummary): WorldSessionLifecycle {
	const state = session.state ?? "";
	const lifecycle = SESSION_LIFECYCLE[state];
	if (!lifecycle) throw new WorldPeerProjectionError(peerId, session.sessionObjectKey ?? "", state);
	return lifecycle;
}

type WorldPeerClient = Pick<WorldClient, "watchSession">;

type WorldPeerDelivery = (
	message: IrcMessage,
	options?: { expectsReply?: boolean },
) => Promise<"injected" | "queued" | "woken">;

export interface WorldAgentPeerOptions {
	client: WorldPeerClient;
	peerId: string;
	session?: SessionSummary;
	deliver: WorldPeerDelivery;
	abort: (reason: string) => Promise<void>;
	onSnapshot?: (snapshot: SessionSnapshot, lifecycle: WorldSessionLifecycle) => void;
}

function historyMessageFromTurn(turn: SessionTurn): unknown {
	const role = turn.role?.trim() || "unknown";
	const content = turn.content ?? "";
	switch (role) {
		case "assistant":
			return { role, content: [{ type: "text", text: content }] };
		case "user":
		case "developer":
			return { role, content };
		default:
			return {
				role: "custom",
				customType: `world-turn:${role}`,
				content,
				display: true,
			};
	}
}

/**
 * AgentPeer backed by a durable World Agent and, when present, one exact
 * LlmSession monitor resource. Disposing the proxy closes only that monitor.
 */
export class WorldAgentPeer implements AgentPeer {
	readonly peerId: string;
	readonly sessionObjectKey: string | undefined;
	readonly #deliver: WorldPeerDelivery;
	readonly #abort: (reason: string) => Promise<void>;
	readonly #onSnapshot: WorldAgentPeerOptions["onSnapshot"];
	readonly #controller = new AbortController();
	readonly #fallbackTimestamp = Date.now();
	#summary: SessionSummary | undefined;
	#snapshot: SessionSnapshot | undefined;
	#iterator: AsyncIterator<SessionSnapshot> | undefined;
	#pump: Promise<void> | undefined;
	#watchFailure: Error | undefined;
	#disposed = false;

	private constructor(options: WorldAgentPeerOptions) {
		this.peerId = options.peerId;
		this.sessionObjectKey = options.session?.sessionObjectKey;
		this.#deliver = options.deliver;
		this.#abort = options.abort;
		this.#onSnapshot = options.onSnapshot;
		this.#summary = options.session;
	}

	/** Open the session monitor and consume its complete initial snapshot. */
	static async open(options: WorldAgentPeerOptions, signal?: AbortSignal): Promise<WorldAgentPeer> {
		const peer = new WorldAgentPeer(options);
		if (!peer.sessionObjectKey) return peer;
		const iterator = options.client
			.watchSession(peer.sessionObjectKey, peer.#controller.signal)
			[Symbol.asyncIterator]();
		peer.#iterator = iterator;
		const cancelInitial = () => peer.#controller.abort(signal?.reason);
		if (signal?.aborted) cancelInitial();
		else signal?.addEventListener("abort", cancelInitial, { once: true });
		try {
			const first = await iterator.next();
			if (first.done) throw new Error(`World peer ${peer.peerId} session watch ended before its initial snapshot`);
			peer.#applySnapshot(first.value);
			peer.#pump = peer.#pumpSnapshots(iterator);
			return peer;
		} catch (error) {
			await peer.dispose();
			throw error;
		} finally {
			signal?.removeEventListener("abort", cancelInitial);
		}
	}

	get messages(): unknown[] {
		return [...(this.#snapshot?.inboxMessages ?? [])];
	}

	get status(): AgentStatus {
		if (!this.#summary) return "idle";
		return worldSessionLifecycle(this.peerId, this.#summary).status;
	}

	get lastActivity(): number {
		const timestamp = Date.parse(this.#summary?.updatedAt ?? "");
		return Number.isNaN(timestamp) ? this.#fallbackTimestamp : timestamp;
	}

	get activity(): string | undefined {
		return this.#snapshot?.progress?.lastIntent || this.#snapshot?.progress?.activeToolName || undefined;
	}

	get mailboxLive(): boolean {
		return this.#summary ? worldSessionLifecycle(this.peerId, this.#summary).mailboxLive : false;
	}

	async readHistorySnapshot(): Promise<AgentHistorySnapshot> {
		if (this.#watchFailure) throw this.#watchFailure;
		return {
			messages: (this.#snapshot?.turns ?? []).map(historyMessageFromTurn),
			sourceLabel: this.sessionObjectKey ? `World session ${this.sessionObjectKey}` : `World Agent ${this.peerId}`,
		};
	}

	async deliverIrcMessage(
		message: IrcMessage,
		options?: { expectsReply?: boolean },
	): Promise<"injected" | "queued" | "woken"> {
		if (this.#disposed) throw new Error(`World peer ${this.peerId} proxy is disposed`);
		return await this.#deliver(message, options);
	}

	async abort(options?: { reason?: string }): Promise<void> {
		if (this.#disposed) throw new Error(`World peer ${this.peerId} proxy is disposed`);
		await this.#abort(options?.reason?.trim() || "Interrupted by a peer");
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#controller.abort(new Error(`World peer ${this.peerId} proxy disposed`));
		try {
			await this.#iterator?.return?.();
		} catch {}
		await this.#pump;
	}

	#applySnapshot(snapshot: SessionSnapshot): void {
		this.#snapshot = snapshot;
		if (snapshot.session) this.#summary = snapshot.session;
		if (!this.#summary) return;
		const lifecycle = worldSessionLifecycle(this.peerId, this.#summary);
		this.#onSnapshot?.(snapshot, lifecycle);
	}

	async #pumpSnapshots(iterator: AsyncIterator<SessionSnapshot>): Promise<void> {
		try {
			for (;;) {
				const next = await iterator.next();
				if (next.done) return;
				this.#applySnapshot(next.value);
			}
		} catch (error) {
			if (this.#controller.signal.aborted) return;
			this.#watchFailure = error instanceof Error ? error : new Error(String(error));
		}
	}
}

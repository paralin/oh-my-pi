import type { IrcMessage } from "../irc/bus";
import type { ParentClient } from "../parent/client";
import {
	ParentSessionState,
	type SessionSnapshot,
	type SessionSummary,
	type SessionTurn,
} from "../parent/generated/parent-environment.pb";
import type { AgentHistorySnapshot, AgentPeer, AgentStatus } from "../registry/agent-registry";

/** A lifecycle value that the Parent projection cannot map without guessing. */
export class ParentPeerProjectionError extends Error {
	readonly peerId: string;
	readonly sessionId: string;
	readonly state: ParentSessionState;

	constructor(peerId: string, sessionId: string, state: ParentSessionState) {
		super(
			`Parent peer ${peerId} session ${sessionId} has unknown lifecycle state ${ParentSessionState[state] ?? String(state)}`,
		);
		this.name = "ParentPeerProjectionError";
		this.peerId = peerId;
		this.sessionId = sessionId;
		this.state = state;
	}
}

export interface ParentSessionLifecycle {
	status: AgentStatus;
	inactive: boolean;
	mailboxLive: boolean;
}

const SESSION_LIFECYCLE: Readonly<Partial<Record<ParentSessionState, ParentSessionLifecycle>>> = {
	[ParentSessionState.CREATED]: { status: "running", inactive: false, mailboxLive: true },
	[ParentSessionState.ACTIVE]: { status: "running", inactive: false, mailboxLive: true },
	[ParentSessionState.AWAITING_PROCESS]: { status: "running", inactive: false, mailboxLive: true },
	[ParentSessionState.BLOCKED]: { status: "idle", inactive: false, mailboxLive: true },
	[ParentSessionState.AWAITING_USER]: { status: "idle", inactive: false, mailboxLive: true },
	[ParentSessionState.DORMANT]: { status: "parked", inactive: false, mailboxLive: false },
	[ParentSessionState.COMPLETE]: { status: "idle", inactive: true, mailboxLive: false },
	[ParentSessionState.ARCHIVED]: { status: "idle", inactive: true, mailboxLive: false },
	[ParentSessionState.FAILED]: { status: "aborted", inactive: true, mailboxLive: false },
	[ParentSessionState.CANCELED]: { status: "aborted", inactive: true, mailboxLive: false },
};

/** Map one parent session lifecycle onto the current AgentRef states. */
export function parentSessionLifecycle(peerId: string, session: SessionSummary): ParentSessionLifecycle {
	const state = session.state ?? ParentSessionState.UNKNOWN;
	const lifecycle = SESSION_LIFECYCLE[state];
	if (!lifecycle) throw new ParentPeerProjectionError(peerId, session.sessionId ?? "", state);
	return lifecycle;
}

type ParentPeerClient = Pick<ParentClient, "watchSession">;

type ParentPeerDelivery = (
	message: IrcMessage,
	options?: { expectsReply?: boolean },
) => Promise<"injected" | "queued" | "woken">;

export interface ParentAgentPeerOptions {
	client: ParentPeerClient;
	peerId: string;
	session?: SessionSummary;
	deliver: ParentPeerDelivery;
	abort: (reason: string) => Promise<void>;
	onSnapshot?: (snapshot: SessionSnapshot, lifecycle: ParentSessionLifecycle) => void;
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
				customType: `parent-turn:${role}`,
				content,
				display: true,
			};
	}
}

/**
 * AgentPeer backed by a durable Parent Agent and, when present, one exact
 * LlmSession monitor resource. Disposing the proxy closes only that monitor.
 */
export class ParentAgentPeer implements AgentPeer {
	readonly peerId: string;
	readonly sessionId: string | undefined;
	readonly #deliver: ParentPeerDelivery;
	readonly #abort: (reason: string) => Promise<void>;
	readonly #onSnapshot: ParentAgentPeerOptions["onSnapshot"];
	readonly #controller = new AbortController();
	readonly #fallbackTimestamp = Date.now();
	#summary: SessionSummary | undefined;
	#snapshot: SessionSnapshot | undefined;
	#iterator: AsyncIterator<SessionSnapshot> | undefined;
	#pump: Promise<void> | undefined;
	#watchFailure: Error | undefined;
	#disposed = false;

	private constructor(options: ParentAgentPeerOptions) {
		this.peerId = options.peerId;
		this.sessionId = options.session?.sessionId;
		this.#deliver = options.deliver;
		this.#abort = options.abort;
		this.#onSnapshot = options.onSnapshot;
		this.#summary = options.session;
	}

	/** Open the session monitor and consume its complete initial snapshot. */
	static async open(options: ParentAgentPeerOptions, signal?: AbortSignal): Promise<ParentAgentPeer> {
		const peer = new ParentAgentPeer(options);
		if (!peer.sessionId) return peer;
		const iterator = options.client.watchSession(peer.sessionId, peer.#controller.signal)[Symbol.asyncIterator]();
		peer.#iterator = iterator;
		const cancelInitial = () => peer.#controller.abort(signal?.reason);
		if (signal?.aborted) cancelInitial();
		else signal?.addEventListener("abort", cancelInitial, { once: true });
		try {
			const first = await iterator.next();
			if (first.done) throw new Error(`Parent peer ${peer.peerId} session watch ended before its initial snapshot`);
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
		return parentSessionLifecycle(this.peerId, this.#summary).status;
	}

	get lastActivity(): number {
		const timestamp = Date.parse(this.#summary?.updatedAt ?? "");
		return Number.isNaN(timestamp) ? this.#fallbackTimestamp : timestamp;
	}

	get activity(): string | undefined {
		return this.#snapshot?.progress?.lastIntent || this.#snapshot?.progress?.activeToolName || undefined;
	}

	get mailboxLive(): boolean {
		return this.#summary ? parentSessionLifecycle(this.peerId, this.#summary).mailboxLive : false;
	}

	async readHistorySnapshot(): Promise<AgentHistorySnapshot> {
		if (this.#watchFailure) throw this.#watchFailure;
		return {
			messages: (this.#snapshot?.turns ?? []).map(historyMessageFromTurn),
			sourceLabel: this.sessionId ? `Parent session ${this.sessionId}` : `Parent Agent ${this.peerId}`,
		};
	}

	async deliverIrcMessage(
		message: IrcMessage,
		options?: { expectsReply?: boolean },
	): Promise<"injected" | "queued" | "woken"> {
		if (this.#disposed) throw new Error(`Parent peer ${this.peerId} proxy is disposed`);
		return await this.#deliver(message, options);
	}

	async abort(options?: { reason?: string }): Promise<void> {
		if (this.#disposed) throw new Error(`Parent peer ${this.peerId} proxy is disposed`);
		await this.#abort(options?.reason?.trim() || "Interrupted by a peer");
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#controller.abort(new Error(`Parent peer ${this.peerId} proxy disposed`));
		try {
			await this.#iterator?.return?.();
		} catch {}
		await this.#pump;
	}

	#applySnapshot(snapshot: SessionSnapshot): void {
		this.#snapshot = snapshot;
		if (snapshot.session) this.#summary = snapshot.session;
		if (!this.#summary) return;
		const lifecycle = parentSessionLifecycle(this.peerId, this.#summary);
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

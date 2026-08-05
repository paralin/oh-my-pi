import type { IrcMessage } from "../irc/bus";
import type { OverallPlanReference } from "../plan-mode/plan-handoff";
import type { AgentPeer, AgentRef } from "../registry/agent-registry";
import type {
	EffectiveSubagentPolicy,
	StructuredSubagentRequest,
	StructuredSubagentResult,
} from "../task/structured-subagent";
import type { AgentProgress } from "../task/types";

/** Stable inputs for one backend-custodied Task spawn. */
export interface CoordinationSpawnRequest {
	peerId: string;
	label: string;
	generated: boolean;
	request: StructuredSubagentRequest;
	policy: EffectiveSubagentPolicy;
	planReference?: OverallPlanReference;
	artifactsDir: string;
	temporaryArtifacts: boolean;
}

/** One admitted World Task whose durable session can be watched locally. */
export interface CoordinationTaskHandle {
	readonly peerId: string;
	wait(signal?: AbortSignal, onProgress?: (progress: AgentProgress) => void): Promise<StructuredSubagentResult>;
}

export interface CoordinationPeerError {
	code: "identity_conflict" | "projection_error";
	peerId: string;
	detail: string;
}

/** Durable World rows plus per-row failures that must not hide valid peers. */
export interface CoordinationPeerRoster {
	peers: AgentRef[];
	errors: CoordinationPeerError[];
}

/** One message accepted by a coordination backend. */
export interface CoordinationMessageRequest {
	targetPeerId: string;
	message: IrcMessage;
	expectsReply?: boolean;
}

export type CoordinationQueueOutcome = "queued_live" | "queued_inactive";

/** Durable storage receipt for one World peer message. */
export interface CoordinationMessageReceipt {
	to: string;
	outcome: "queued";
	queueOutcome: CoordinationQueueOutcome;
	messageObjectKey: string;
	inboxSequence: bigint;
	replayed: boolean;
}

export interface CoordinationMessageFilter {
	from?: string;
	replyTo?: string;
}

/** Root-scoped coordination used by Task and Hub without changing their tool APIs. */
export interface CoordinationBackend {
	readonly kind: "world";
	spawn(request: CoordinationSpawnRequest, signal?: AbortSignal): Promise<CoordinationTaskHandle>;
	listPeers(signal?: AbortSignal): Promise<CoordinationPeerRoster>;
	attachMailbox(receiverPeerId: string, receiver: Pick<AgentPeer, "deliverIrcMessage">): void;
	send(request: CoordinationMessageRequest, signal?: AbortSignal): Promise<CoordinationMessageReceipt>;
	inbox(options?: { peek?: boolean; from?: string; replyTo?: string; limit?: number }): IrcMessage[];
	waitMessage(filter: CoordinationMessageFilter, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null>;
	interrupt(peerId: string, reason: string, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

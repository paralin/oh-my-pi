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

/** One admitted Parent Task whose durable session can be watched locally. */
export interface CoordinationTaskHandle {
	readonly peerId: string;
	wait(signal?: AbortSignal, onProgress?: (progress: AgentProgress) => void): Promise<StructuredSubagentResult>;
}

export interface CoordinationPeerError {
	code: "identity_conflict" | "projection_error";
	peerId: string;
	detail: string;
}

/** Durable parent rows plus per-row failures that must not hide valid peers. */
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

/** Durable storage receipt for one parent peer message. */
export interface CoordinationMessageReceipt {
	to: string;
	outcome: "queued";
	queueOutcome: CoordinationQueueOutcome;
	messageId: string;
	inboxSequence: bigint;
	replayed: boolean;
}

export interface CoordinationMessageFilter {
	from?: string;
	replyTo?: string;
}

/** Reasons that can change the root's durable parent identity. */
export type CoordinationSessionTransitionReason =
	| "startup"
	| "new"
	| "drop"
	| "fork"
	| "branch"
	| "resume"
	| "switch"
	| "reload";

/** Semantic identity committed by SessionManager before parent rotation. */
export interface CoordinationSessionTransition {
	sessionId: string;
	previousSessionId?: string;
	reason: CoordinationSessionTransitionReason;
	/** Exact provider selected for the committed session. */
	provider: string;
	/** Exact model selected for the committed session. */
	model: string;
}

/** Exact provider/model selection committed by ModelControls. */
export interface CoordinationModelTransition {
	provider: string;
	model: string;
}

/** Opaque quiesced-root lease. It is valid for exactly one terminal callback. */
export interface CoordinationTransitionToken {
	readonly generation: number;
}

/**
 * Awaited root lifecycle owned by AgentSession and ModelControls.
 *
 * Local and static parent backends implement these as no-ops. An attached
 * backend must quiesce mutable work before a SessionManager commit, then
 * rotate/reconfigure only after that commit and before the caller resumes.
 */
export interface CoordinationLifecycle {
	beforeRootTransition(): Promise<CoordinationTransitionToken>;
	afterSessionTransition(token: CoordinationTransitionToken, transition: CoordinationSessionTransition): Promise<void>;
	afterModelTransition(token: CoordinationTransitionToken, transition: CoordinationModelTransition): Promise<void>;
	abortRootTransition(token: CoordinationTransitionToken, error: unknown): Promise<void>;
}

/** Root-scoped coordination used by Task and Hub without changing their tool APIs. */
export interface CoordinationBackend {
	readonly kind: "parent";
	spawn(request: CoordinationSpawnRequest, signal?: AbortSignal): Promise<CoordinationTaskHandle>;
	listPeers(signal?: AbortSignal): Promise<CoordinationPeerRoster>;
	attachMailbox(receiverPeerId: string, receiver: Pick<AgentPeer, "deliverIrcMessage">): void;
	send(request: CoordinationMessageRequest, signal?: AbortSignal): Promise<CoordinationMessageReceipt>;
	inbox(options?: { peek?: boolean; from?: string; replyTo?: string; limit?: number }): IrcMessage[];
	waitMessage(filter: CoordinationMessageFilter, timeoutMs: number, signal?: AbortSignal): Promise<IrcMessage | null>;
	interrupt(peerId: string, reason: string, signal?: AbortSignal): Promise<void>;
	close(): Promise<void>;
}

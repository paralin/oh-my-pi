import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { ASYNC_JOB_OWNER_LIFECYCLE_ABORT } from "../async";
import type { IrcMessage } from "../irc/bus";
import { resolveParentSocketPath } from "../parent/config";
import type {
	AgentMessageSummary,
	AgentSummary,
	AgentTreeSnapshot,
	SessionSummary,
	TaskProgressSummary,
	TaskResultSummary,
} from "../parent/generated/parent-environment.pb";
import { ParentSessionState, PeerMessageOutcome, TaskAgentSource } from "../parent/generated/parent-environment.pb";
import {
	MAX_SESSION_PAGE,
	PARENT_CHILD_CAPABILITIES,
	ParentClient,
	type ParentClientOptions,
	ParentOperationError,
} from "../parent/index";
import {
	DEFAULT_DISPATCH_REPOSITORY,
	defaultCheckoutIdentity,
	defaultIntentOwnerArtifact,
	semanticWorkingDirectory,
} from "../parent/intent-key";
import { type AgentPeer, type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { renderStructuredSubagentPrompt, type StructuredSubagentResult } from "../task/structured-subagent";
import type { AgentProgress, AgentSource, SingleResult, StructuredSubagentOutput } from "../task/types";
import * as git from "../utils/git";
import type {
	CoordinationBackend,
	CoordinationMessageFilter,
	CoordinationMessageReceipt,
	CoordinationMessageRequest,
	CoordinationModelTransition,
	CoordinationPeerError,
	CoordinationPeerRoster,
	CoordinationSessionTransition,
	CoordinationSpawnRequest,
	CoordinationTaskHandle,
	CoordinationTransitionToken,
} from "./backend";
import { buildExternalSubagentProfile, encodeExternalSubagentProfile } from "./external-subagent-profile";
import { ParentAgentPeer, parentSessionLifecycle } from "./parent-agent-peer";
import { ParentMailboxRouter } from "./parent-mailbox";

/** Public Parent client surface required by Task and Hub coordination. */
export type ParentCoordinationClient = Pick<
	ParentClient,
	| "ackPeerMessage"
	| "canMutate"
	| "connected"
	| "close"
	| "deriveIntentKey"
	| "interruptSession"
	| "lookupDispatchIntent"
	| "listSessions"
	| "resolveAgentPeer"
	| "sendPeerMessage"
	| "sessionKey"
	| "submitDispatch"
	| "watchSession"
	| "watchAgentTree"
	| "watchPeerMailbox"
>;
type ParentLifecycleClient = ParentCoordinationClient & {
	readonly interactiveRoot?: boolean;
	readonly interactiveBinding?: object;
	rotateInteractiveRootTransition?: (transition: CoordinationSessionTransition) => Promise<void>;
	reconfigureInteractiveRootTransition?: (transition: CoordinationModelTransition) => Promise<void>;
	retireInteractiveRoot?: (reason: unknown) => Promise<void>;
};
const RESERVED_PEER_IDS: Readonly<Record<string, true>> = {
	main: true,
	all: true,
	__advisor: true,
};
const PARENT_PEER_ID = "main";
const TERMINAL_SESSION_STATES = new Set([
	ParentSessionState.COMPLETE,
	ParentSessionState.ARCHIVED,
	ParentSessionState.FAILED,
	ParentSessionState.CANCELED,
]);

function unavailable(operation: string): Error {
	return new Error(`Parent coordination ${operation} is unavailable until its durable adapter is installed`);
}

function requirePeerId(value: string): string {
	const peerId = value.trim();
	if (!peerId) throw new Error("Parent Task peer ID is required");
	if (!/^[A-Za-z0-9_.-]{1,256}$/.test(peerId)) {
		throw new Error("Parent Task peer ID must contain 1-256 ASCII letters, digits, dots, underscores, or hyphens");
	}
	if (RESERVED_PEER_IDS[peerId.toLowerCase()]) {
		throw new Error(`Parent Task peer ID ${JSON.stringify(peerId)} is reserved`);
	}
	return peerId;
}

function nextPeerId(value: string): string {
	const match = /^(.*)-([2-9]\d*)$/.exec(value);
	if (!match) return `${value}-2`;
	return `${match[1]}-${Number(match[2]) + 1}`;
}

function sourceOnWire(source: AgentSource): TaskAgentSource {
	switch (source) {
		case "bundled":
			return TaskAgentSource.BUNDLED;
		case "user":
			return TaskAgentSource.USER;
		case "project":
			return TaskAgentSource.PROJECT;
	}
}

function repositoryIdentity(remote: string | undefined): string {
	const value = remote?.trim();
	if (!value) return DEFAULT_DISPATCH_REPOSITORY;
	const github = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(value);
	if (github) return `github.com/${github[1]}`;
	try {
		const parsed = new URL(value);
		const pathname = parsed.pathname.replace(/^\/+|\/+$|\.git$/g, "");
		if (parsed.hostname && pathname) return `${parsed.hostname}/${pathname}`;
	} catch {}
	return value.replace(/\.git$/, "");
}

async function resolvedPath(value: string): Promise<string> {
	const absolute = path.resolve(value);
	try {
		return await fs.realpath(absolute);
	} catch {
		return absolute;
	}
}

function relativeIdentity(root: string, worktree: string): string | undefined {
	const relative = path.relative(root, worktree);
	if (relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
	if (!relative) return path.basename(root);
	return relative.split(path.sep).join("/");
}

async function portableWorktreeIdentity(worktreePath: string): Promise<string> {
	const worktree = await resolvedPath(worktreePath);
	const orientRoot = process.env.GLADOS_ORIENT_ROOT?.trim();
	if (orientRoot && path.isAbsolute(orientRoot)) {
		const fromOrient = relativeIdentity(await resolvedPath(orientRoot), worktree);
		if (fromOrient) return fromOrient;
	}
	const fromHome = relativeIdentity(await resolvedPath(os.homedir()), worktree);
	if (fromHome) return fromHome;
	throw new Error(`Parent Task worktree ${JSON.stringify(worktree)} is outside the configured workspace and home`);
}

function numberFromWire(value: bigint | undefined, field: string): number {
	const result = Number(value ?? 0n);
	if (!Number.isSafeInteger(result)) throw new Error(`Parent Task ${field} exceeds JavaScript's safe integer range`);
	return result;
}

function parseStructuredOutput(value: string | undefined): StructuredSubagentOutput | undefined {
	if (!value) return undefined;
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Parent Task structured output is not an object");
	}
	const record = parsed as Record<string, unknown>;
	const source = record.source;
	const mode = record.mode;
	const status = record.status;
	if (
		(source !== "caller" && source !== "agent" && source !== "session" && source !== "none") ||
		(mode !== "permissive" && mode !== "strict") ||
		(status !== "valid" && status !== "invalid" && status !== "unavailable")
	) {
		throw new Error("Parent Task structured output metadata is invalid");
	}
	return {
		source,
		mode,
		status,
		...(Object.hasOwn(record, "data") ? { data: record.data } : {}),
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

function parseExtractedToolData(rows: TaskResultSummary["extractedToolData"]): Record<string, unknown[]> | undefined {
	if (!rows?.length) return undefined;
	const result: Record<string, unknown[]> = {};
	for (const row of rows) {
		const toolName = row.toolName?.trim();
		if (!toolName) throw new Error("Parent Task extracted tool data has no tool name");
		const values = row.values?.map(value => JSON.parse(value)) ?? [];
		const toolValues = result[toolName] ?? [];
		toolValues.push(...values);
		result[toolName] = toolValues;
	}
	return result;
}

function progressFromSnapshot(request: CoordinationSpawnRequest, progress: TaskProgressSummary): AgentProgress {
	return {
		index: request.request.index ?? 0,
		id: request.peerId,
		agent: request.policy.agent.name,
		agentSource: request.policy.agent.source,
		status: "running",
		task: renderStructuredSubagentPrompt(request.request.assignment),
		assignment: request.request.assignment.trim(),
		lastIntent: progress.lastIntent || undefined,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: numberFromWire(progress.tokens, "progress tokens"),
		requests: numberFromWire(progress.requests, "progress requests"),
		contextTokens: numberFromWire(progress.contextTokens, "progress context tokens"),
		contextWindow: numberFromWire(progress.contextWindow, "progress context window"),
		resolvedModel: progress.resolvedModel || undefined,
		durationMs: numberFromWire(progress.durationMs, "progress duration"),
		currentTool: progress.activeToolName || undefined,
		cost: progress.cost ?? 0,
	};
}

async function resultFromSnapshot(
	request: CoordinationSpawnRequest,
	result: TaskResultSummary,
): Promise<StructuredSubagentResult> {
	const output = result.output ?? "";
	await fs.mkdir(request.artifactsDir, { recursive: true });
	const outputPath = path.join(request.artifactsDir, `${request.peerId}.md`);
	await Bun.write(outputPath, output);
	const usage = result.usage;
	const cost = usage?.cost;
	const singleResult: SingleResult = {
		index: request.request.index ?? 0,
		id: request.peerId,
		agent: request.policy.agent.name,
		agentSource: request.policy.agent.source,
		task: renderStructuredSubagentPrompt(request.request.assignment),
		assignment: request.request.assignment.trim(),
		description: request.request.identity?.label?.trim() || undefined,
		lastIntent: result.lastIntent || undefined,
		exitCode: result.exitCode ?? 0,
		output,
		stderr: result.stderr ?? "",
		truncated: result.truncated ?? false,
		structuredOutput: parseStructuredOutput(result.structuredOutput),
		durationMs: numberFromWire(result.durationMs, "result duration"),
		tokens: numberFromWire(result.tokens, "result tokens"),
		requests: numberFromWire(result.requests, "result requests"),
		contextTokens: numberFromWire(result.contextTokens, "result context tokens"),
		contextWindow: numberFromWire(result.contextWindow, "result context window"),
		modelOverride: request.policy.modelOverride,
		resolvedModel: result.resolvedModel || undefined,
		resolvedModelIsFallback: result.resolvedModelIsFallback ?? false,
		error: result.error || undefined,
		aborted: result.aborted ?? false,
		abortReason: result.abortReason || undefined,
		usage: usage
			? {
					input: numberFromWire(usage.input, "usage input"),
					output: numberFromWire(usage.output, "usage output"),
					cacheRead: numberFromWire(usage.cacheRead, "usage cache read"),
					cacheWrite: numberFromWire(usage.cacheWrite, "usage cache write"),
					totalTokens: numberFromWire(usage.totalTokens, "usage total tokens"),
					reasoningTokens: numberFromWire(usage.reasoningTokens, "usage reasoning tokens"),
					cost: {
						input: cost?.input ?? 0,
						output: cost?.output ?? 0,
						cacheRead: cost?.cacheRead ?? 0,
						cacheWrite: cost?.cacheWrite ?? 0,
						total: cost?.total ?? 0,
					},
				}
			: undefined,
		outputPath,
		extractedToolData: parseExtractedToolData(result.extractedToolData),
		retryFailure: result.retryFailure
			? {
					attempt: result.retryFailure.attempt ?? 0,
					errorMessage: result.retryFailure.errorMessage ?? "",
				}
			: undefined,
		outputMeta: {
			lineCount: output.split("\n").length,
			charCount: output.length,
		},
	};
	return {
		result: singleResult,
		policy: request.policy,
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: request.artifactsDir,
		temporaryArtifacts: request.temporaryArtifacts,
	};
}

function sessionTimestamp(session: SessionSummary): number {
	for (const value of [session.updatedAt, session.completedAt, session.canceledAt]) {
		const timestamp = Date.parse(value ?? "");
		if (!Number.isNaN(timestamp)) return timestamp;
	}
	return 0;
}

function latestSessionForAgent(sessions: SessionSummary[], agentId: string): SessionSummary | undefined {
	return sessions
		.filter(session => session.agentId === agentId)
		.sort(
			(left, right) =>
				sessionTimestamp(right) - sessionTimestamp(left) ||
				(right.sessionId ?? "").localeCompare(left.sessionId ?? ""),
		)[0];
}

interface CachedParentPeer {
	sessionId: string | undefined;
	peer: ParentAgentPeer;
	ref: AgentRef;
}

/** Coordination backend selected once for a configured Parent root. */
export class ParentCoordinationBackend implements CoordinationBackend {
	readonly kind = "parent" as const;
	readonly client: ParentLifecycleClient;
	readonly #sessions = new Map<string, string>();
	readonly #peerCache = new Map<string, CachedParentPeer>();
	#closed = false;
	#mailboxRouter: ParentMailboxRouter | undefined;
	#mailboxReceiver:
		| {
				receiverPeerId: string;
				receiver: Pick<AgentPeer, "deliverIrcMessage">;
		  }
		| undefined;
	#generation = 0;
	#quiesced = false;
	#bound = true;
	readonly #activeMutations = new Set<Promise<void>>();
	constructor(client: ParentCoordinationClient) {
		const lifecycleClient = client as ParentLifecycleClient;
		if (!client.canMutate && !lifecycleClient.interactiveRoot && !lifecycleClient.rotateInteractiveRootTransition) {
			throw new Error("Parent coordination requires a caller LlmSession");
		}
		this.client = lifecycleClient;
		this.#bound = lifecycleClient.interactiveRoot !== true || lifecycleClient.interactiveBinding !== undefined;
		this.#quiesced = lifecycleClient.interactiveRoot === true && lifecycleClient.interactiveBinding === undefined;
	}
	#isRotatable(): boolean {
		return this.client.interactiveRoot === true || this.client.rotateInteractiveRootTransition !== undefined;
	}

	/** Mark the startup attachment callable after its held Resource is committed. */
	activateInteractiveRoot(): void {
		if (!this.#isRotatable()) return;
		if (!this.client.interactiveBinding) {
			throw new Error("Parent interactive root has no accepted binding");
		}
		this.#bound = true;
		this.#quiesced = false;
		this.#startMailboxRouter();
	}

	#requireBound(operation: string): void {
		if (this.#closed) throw new Error("Parent coordination backend is closed");
		if (this.#isRotatable() && (!this.#bound || this.#quiesced)) {
			throw unavailable(operation);
		}
	}

	async #runMutableOperation<T>(operation: string, run: () => Promise<T>): Promise<T> {
		this.#requireBound(operation);
		const settled = Promise.withResolvers<void>();
		this.#activeMutations.add(settled.promise);
		try {
			return await run();
		} finally {
			this.#activeMutations.delete(settled.promise);
			settled.resolve();
		}
	}

	async beforeRootTransition(): Promise<CoordinationTransitionToken> {
		if (this.#closed) throw new Error("Parent coordination backend is closed");
		const token = { generation: ++this.#generation };
		if (!this.#isRotatable()) return token;
		this.#quiesced = true;
		this.#bound = false;
		await Promise.all([this.#mailboxRouter?.close(), ...this.#activeMutations]);
		this.#mailboxRouter = undefined;
		return token;
	}

	async afterSessionTransition(
		token: CoordinationTransitionToken,
		transition: CoordinationSessionTransition,
	): Promise<void> {
		if (!this.#isRotatable()) return;
		this.#assertTransitionToken(token);
		try {
			const rotate = this.client.rotateInteractiveRootTransition;
			if (!rotate) throw new Error("Parent interactive root does not support session rotation");
			await rotate.call(this.client, transition);
			this.#bound = true;
			this.#quiesced = false;
			this.#startMailboxRouter();
		} catch (error) {
			await this.#retire(error);
			throw error;
		}
	}

	async afterModelTransition(
		token: CoordinationTransitionToken,
		transition: CoordinationModelTransition,
	): Promise<void> {
		if (!this.#isRotatable()) return;
		this.#assertTransitionToken(token);
		try {
			const reconfigure = this.client.reconfigureInteractiveRootTransition;
			if (!reconfigure) throw new Error("Parent interactive root does not support model reconfiguration");
			await reconfigure.call(this.client, transition);
			this.#bound = true;
			this.#quiesced = false;
			this.#startMailboxRouter();
		} catch (error) {
			await this.#retire(error);
			throw error;
		}
	}

	async abortRootTransition(token: CoordinationTransitionToken, error: unknown): Promise<void> {
		if (!this.#isRotatable()) return;
		this.#assertTransitionToken(token);
		await this.#retire(error);
	}

	#assertTransitionToken(token: CoordinationTransitionToken): void {
		if (token.generation !== this.#generation) {
			throw new Error("Parent coordination transition token is stale");
		}
	}

	async #retire(reason: unknown): Promise<void> {
		this.#bound = false;
		this.#quiesced = true;
		await this.#mailboxRouter?.close();
		this.#mailboxRouter = undefined;
		try {
			if (this.client.retireInteractiveRoot) await this.client.retireInteractiveRoot(reason);
			else await this.client.close();
		} catch {
			// Retirement is fail-closed: preserve the transition error and remain unbound.
		}
	}

	#startMailboxRouter(): void {
		if (this.#closed || !this.#bound || !this.#mailboxReceiver || this.#mailboxRouter) return;
		const { receiverPeerId, receiver } = this.#mailboxReceiver;
		const router = new ParentMailboxRouter({
			client: this.client,
			receiverPeerId,
			receiver,
			generation: this.#generation,
			resolveSender: async (message, signal) => await this.#resolveMailboxSender(message, signal),
		});
		this.#mailboxRouter = router;
		router.start();
	}

	async spawn(request: CoordinationSpawnRequest, signal?: AbortSignal): Promise<CoordinationTaskHandle> {
		return await this.#runMutableOperation("Parent Task spawn", async () => await this.#spawn(request, signal));
	}

	async #spawn(request: CoordinationSpawnRequest, signal?: AbortSignal): Promise<CoordinationTaskHandle> {
		let peerId = requirePeerId(request.peerId);
		for (;;) {
			signal?.throwIfAborted();
			if ((request.request.session.agentRegistry ?? AgentRegistry.global()).get(peerId)) {
				if (!request.generated) throw new Error(`Parent Task peer identity conflict: ${peerId}`);
				peerId = nextPeerId(peerId);
				continue;
			}
			const candidate = { ...request, peerId, label: request.generated ? peerId : request.label };
			const profile = buildExternalSubagentProfile({
				peerId,
				label: candidate.label,
				request: candidate.request,
				policy: candidate.policy,
			});
			const encoded = encodeExternalSubagentProfile(profile);
			const worktreePath =
				(await git.repo.root(candidate.request.session.cwd, signal)) ?? candidate.request.session.cwd;
			const repository = repositoryIdentity(await git.remote.url(worktreePath, "origin", signal));
			const ownerArtifact = defaultIntentOwnerArtifact(repository);
			const identity = {
				ownerArtifact,
				objective: candidate.request.assignment,
				repository,
				checkoutIdentity: defaultCheckoutIdentity(repository),
				worktreeIdentity: await portableWorktreeIdentity(worktreePath),
				workingDirectory: semanticWorkingDirectory(worktreePath, candidate.request.session.cwd),
				deliverablePaths: [ownerArtifact],
				writeSurfaces: [ownerArtifact],
				peerId,
				workerProfileDigest: encoded.digest,
			};
			const { intentKey } = this.client.deriveIntentKey(identity);
			const existing = await this.client.lookupDispatchIntent(intentKey, signal);
			if (existing.found) {
				if (existing.session?.sessionId?.trim()) {
					return await this.#attach(candidate, intentKey, existing.session, signal);
				}
				throw new Error(`Parent Task ${intentKey} has no attached LlmSession`);
			}

			const peer = await this.client.resolveAgentPeer(peerId, signal);
			if (peer.found) {
				if (!request.generated) throw new Error(`Parent Task peer identity conflict: ${peerId}`);
				peerId = nextPeerId(peerId);
				continue;
			}
			try {
				const submitted = await this.client.submitDispatch(
					{
						identity,
						doneCriteria: "Return one terminal Task result.",
						adapterArgv: [],
						worktreePath,
						workingDirectory: candidate.request.session.cwd,
						maxRuntimeSeconds: Math.ceil(profile.maxRuntimeMs / 1000),
						model: profile.modelSelector[0],
						childCapabilities: [...PARENT_CHILD_CAPABILITIES],
						taskAgent: {
							peerId,
							displayName: candidate.label,
							agentType: candidate.policy.agent.name,
							agentSource: sourceOnWire(candidate.policy.agent.source),
							purpose: candidate.request.assignment.trim(),
							workerProfile: encoded.bytes,
							workerProfileDigest: encoded.digest,
						},
					},
					signal,
				);
				return await this.#attach(candidate, submitted.intentKey, submitted.session, signal);
			} catch (error) {
				const recovered = await this.client.lookupDispatchIntent(intentKey, signal);
				if (recovered.found && recovered.session?.sessionId?.trim()) {
					return await this.#attach(candidate, intentKey, recovered.session, signal);
				}
				if (
					error instanceof ParentOperationError &&
					error.codeName === "PEER_IDENTITY_CONFLICT" &&
					request.generated
				) {
					peerId = nextPeerId(peerId);
					continue;
				}
				throw error;
			}
		}
	}

	async #attach(
		request: CoordinationSpawnRequest,
		intentKey: string,
		session: { sessionId?: string; parentSessionId?: string } | undefined,
		signal?: AbortSignal,
	): Promise<CoordinationTaskHandle> {
		const sessionId = session?.sessionId?.trim();
		if (!sessionId) throw new Error(`Parent Task ${intentKey} has no attached LlmSession`);
		if (session?.parentSessionId !== this.client.sessionKey) {
			throw new Error(`Parent Task ${intentKey} belongs to another parent LlmSession`);
		}
		const peer = await this.client.resolveAgentPeer(request.peerId, signal);
		if (!peer.found || peer.agent?.peerId !== request.peerId) {
			throw new Error(`Parent Task ${intentKey} does not resolve peer ${request.peerId}`);
		}
		if (peer.session?.sessionId && peer.session.sessionId !== sessionId) {
			throw new Error(`Parent Task peer ${request.peerId} resolves another active LlmSession`);
		}
		this.#sessions.set(request.peerId, sessionId);
		return {
			peerId: request.peerId,
			wait: async (signal, onProgress) => await this.#watchTask(request, intentKey, sessionId, signal, onProgress),
		};
	}

	async #watchTask(
		request: CoordinationSpawnRequest,
		intentKey: string,
		sessionId: string,
		signal?: AbortSignal,
		onProgress?: (progress: AgentProgress) => void,
	): Promise<StructuredSubagentResult> {
		let interrupt: Promise<void> | undefined;
		const interruptFailure = Promise.withResolvers<never>();
		const detach = new AbortController();
		const requestInterrupt = () => {
			if (interrupt) return;
			if (signal?.reason === ASYNC_JOB_OWNER_LIFECYCLE_ABORT) {
				detach.abort(ASYNC_JOB_OWNER_LIFECYCLE_ABORT);
				return;
			}
			interrupt = this.interrupt(request.peerId, "Task cancelled by its parent");
			interrupt.catch(error => interruptFailure.reject(error));
		};
		signal?.addEventListener("abort", requestInterrupt, { once: true });
		if (signal?.aborted) requestInterrupt();
		const snapshots = this.client.watchSession(sessionId, detach.signal)[Symbol.asyncIterator]();
		try {
			for (;;) {
				const next = await Promise.race([snapshots.next(), interruptFailure.promise]);
				if (next.done) throw new Error(`Parent Task ${intentKey} session watch ended before a terminal result`);
				const snapshot = next.value;
				if (snapshot.progress) onProgress?.(progressFromSnapshot(request, snapshot.progress));
				if (snapshot.taskResult) {
					if (interrupt) await interrupt;
					return await resultFromSnapshot(request, snapshot.taskResult);
				}
				if (TERMINAL_SESSION_STATES.has(snapshot.session?.state ?? ParentSessionState.UNKNOWN)) {
					throw new Error(`Parent Task ${intentKey} reached terminal state without TaskResultSummary`);
				}
			}
		} finally {
			signal?.removeEventListener("abort", requestInterrupt);
			await snapshots.return?.(undefined);
			interruptFailure.promise.catch(() => {});
		}
	}

	async listPeers(signal?: AbortSignal): Promise<CoordinationPeerRoster> {
		this.#requireBound("Parent peer listing");
		signal?.throwIfAborted();
		const [tree, sessions] = await Promise.all([
			this.#readAgentTree(signal),
			this.client.listSessions(MAX_SESSION_PAGE, signal),
		]);
		const errors: CoordinationPeerError[] = [];
		const peers: AgentRef[] = [];
		const callerSession =
			sessions.find(session => session.sessionId === this.client.sessionKey) ??
			(await this.#readSessionSummary(this.client.sessionKey, signal));
		if (!callerSession) throw new Error(`Bound Parent LlmSession ${this.client.sessionKey} is missing`);
		const callerAgentObjectKey = callerSession.agentId?.trim();
		if (!callerAgentObjectKey) {
			throw new Error(`Bound Parent LlmSession ${this.client.sessionKey} has no Agent object key`);
		}
		const agentsByKey = new Map(
			(tree.agents ?? [])
				.filter((agent): agent is AgentSummary & { agentId: string } => !!agent.agentId)
				.map(agent => [agent.agentId, agent]),
		);
		const callerAgent = agentsByKey.get(callerAgentObjectKey);
		if (!callerAgent) throw new Error(`Bound Parent Agent ${callerAgentObjectKey} is absent from the Agent tree`);
		const boundLocalId = callerAgent.peerId?.trim() || MAIN_AGENT_ID;
		const peerCounts = new Map<string, number>();
		for (const agent of tree.agents ?? []) {
			const peerId = agent.peerId?.trim();
			if (peerId) peerCounts.set(peerId, (peerCounts.get(peerId) ?? 0) + 1);
		}
		const duplicated = new Set<string>();
		const seen = new Set<string>();

		for (const agent of tree.agents ?? []) {
			const peerId = agent.peerId?.trim();
			if (!peerId || agent.agentId === callerAgentObjectKey) continue;
			if ((peerCounts.get(peerId) ?? 0) > 1) {
				if (!duplicated.has(peerId)) {
					duplicated.add(peerId);
					errors.push({
						code: "identity_conflict",
						peerId,
						detail: `Parent Agent tree contains more than one Agent with peer ID ${peerId}`,
					});
				}
				continue;
			}
			try {
				const resolved = await this.client.resolveAgentPeer(peerId, signal);
				if (!resolved.found || resolved.agent?.peerId !== peerId) {
					throw new Error(`Parent Agent tree peer ${peerId} does not resolve exactly`);
				}
				if (resolved.agent.agentId !== agent.agentId) {
					throw new Error(`Parent peer ${peerId} resolves a different Agent object`);
				}
				const activeSessionObjectKeys = (agent.activeSessionIds ?? []).filter(Boolean);
				if (activeSessionObjectKeys.length > 1) {
					throw new Error(`Parent peer ${peerId} has more than one active LlmSession`);
				}
				if (resolved.inactive) {
					if (resolved.session || activeSessionObjectKeys.length !== 0) {
						throw new Error(`Parent peer ${peerId} has inconsistent inactive-session resolution`);
					}
				} else {
					const resolvedSessionObjectKey = resolved.session?.sessionId;
					if (
						!resolvedSessionObjectKey ||
						activeSessionObjectKeys.length !== 1 ||
						activeSessionObjectKeys[0] !== resolvedSessionObjectKey
					) {
						throw new Error(`Parent peer ${peerId} has inconsistent active-session resolution`);
					}
				}
				const session =
					resolved.session ?? (agent.agentId ? latestSessionForAgent(sessions, agent.agentId) : undefined);
				if (session?.agentId !== agent.agentId) {
					throw new Error(`Parent peer ${peerId} resolves a session for a different Agent`);
				}
				if (session && parentSessionLifecycle(peerId, session).inactive !== resolved.inactive) {
					throw new Error(`Parent peer ${peerId} lifecycle disagrees with its inactive resolution`);
				}
				const parentId =
					agent.parentAgentId === callerAgentObjectKey
						? boundLocalId
						: agentsByKey.get(agent.parentAgentId ?? "")?.peerId;
				const ref = await this.#parentRef(peerId, agent, session, parentId, signal);
				seen.add(peerId);
				peers.push(ref);
			} catch (error) {
				errors.push({
					code: "projection_error",
					peerId,
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}

		const parentSessionId = callerSession?.parentSessionId?.trim();
		if (parentSessionId) {
			try {
				const parentSession =
					sessions.find(session => session.sessionId === parentSessionId) ??
					(await this.#readSessionSummary(parentSessionId, signal));
				if (!parentSession) throw new Error(`Manifest parent LlmSession ${parentSessionId} is missing`);
				const parentAgent = agentsByKey.get(parentSession.agentId ?? "");
				const mainAgent: AgentSummary = {
					agentId: parentSession.agentId,
					name: parentAgent?.name || "Parent",
					peerId: PARENT_PEER_ID,
				};
				peers.push(await this.#parentRef(PARENT_PEER_ID, mainAgent, parentSession, undefined, signal));
				seen.add(PARENT_PEER_ID);
			} catch (error) {
				errors.push({
					code: "projection_error",
					peerId: PARENT_PEER_ID,
					detail: error instanceof Error ? error.message : String(error),
				});
			}
		}

		for (const [peerId, cached] of this.#peerCache) {
			if (seen.has(peerId)) continue;
			this.#peerCache.delete(peerId);
			await cached.peer.dispose();
		}
		return { peers, errors };
	}

	async #readAgentTree(signal?: AbortSignal): Promise<AgentTreeSnapshot> {
		const iterator = this.client.watchAgentTree(signal)[Symbol.asyncIterator]();
		try {
			const first = await iterator.next();
			if (first.done) throw new Error("Parent Agent-tree watch ended before its initial snapshot");
			return first.value;
		} finally {
			await iterator.return?.(undefined);
		}
	}

	async #readSessionSummary(sessionId: string | undefined, signal?: AbortSignal): Promise<SessionSummary | undefined> {
		if (!sessionId) return undefined;
		const iterator = this.client.watchSession(sessionId, signal)[Symbol.asyncIterator]();
		try {
			const first = await iterator.next();
			if (first.done) return undefined;
			return first.value.session;
		} finally {
			await iterator.return?.(undefined);
		}
	}

	async #parentRef(
		peerId: string,
		agent: AgentSummary,
		session: SessionSummary | undefined,
		parentId: string | undefined,
		signal?: AbortSignal,
	): Promise<AgentRef> {
		const sessionId = session?.sessionId;
		const cached = this.#peerCache.get(peerId);
		if (cached && cached.sessionId === sessionId) {
			cached.ref.displayName = agent.name?.trim() || peerId;
			cached.ref.parentId = parentId;
			cached.ref.status = cached.peer.status;
			cached.ref.lastActivity = cached.peer.lastActivity;
			cached.ref.activity = cached.peer.activity;
			return cached.ref;
		}
		if (cached) {
			this.#peerCache.delete(peerId);
			await cached.peer.dispose();
		}
		let ref: AgentRef | undefined;
		const peer = await ParentAgentPeer.open(
			{
				client: this.client,
				peerId,
				session,
				deliver: async (message, options) => {
					await this.send({ targetPeerId: peerId, message, expectsReply: options?.expectsReply });
					return "queued";
				},
				abort: async reason => await this.interrupt(peerId, reason),
				onSnapshot: (_snapshot, lifecycle) => {
					if (!ref) return;
					ref.status = lifecycle.status;
					ref.lastActivity = peer.lastActivity;
					ref.activity = peer.activity;
				},
			},
			signal,
		);
		const lastActivity = peer.lastActivity;
		ref = {
			id: peerId,
			displayName: agent.name?.trim() || peerId,
			kind: "sub",
			parentId,
			status: peer.status,
			session: peer,
			sessionFile: null,
			createdAt: lastActivity,
			lastActivity,
			activity: peer.activity,
		};
		this.#peerCache.set(peerId, { sessionId, peer, ref });
		return ref;
	}

	attachMailbox(receiverPeerId: string, receiver: Pick<AgentPeer, "deliverIrcMessage">): void {
		if (this.#closed) throw new Error("Parent coordination backend is closed");
		if (this.#mailboxReceiver) throw new Error("Parent coordination mailbox is already attached");
		this.#mailboxReceiver = { receiverPeerId, receiver };
		this.#startMailboxRouter();
	}

	async send(request: CoordinationMessageRequest, signal?: AbortSignal): Promise<CoordinationMessageReceipt> {
		return await this.#runMutableOperation("Parent coordination send", async () => await this.#send(request, signal));
	}

	async #send(request: CoordinationMessageRequest, signal?: AbortSignal): Promise<CoordinationMessageReceipt> {
		const targetPeerId = request.targetPeerId.trim();
		if (!targetPeerId) throw new Error("Parent peer message target is required");
		const target =
			targetPeerId === PARENT_PEER_ID
				? ({ kind: "parent" } as const)
				: ({ kind: "peer", peerId: requirePeerId(targetPeerId) } as const);
		const digest = Bun.SHA256.hash(`${this.client.sessionKey}\0${request.message.id}`, "hex").slice(0, 32);
		const result = await this.client.sendPeerMessage(
			{
				requestId: `parent-peer-send:${digest}`,
				clientMessageId: request.message.id,
				body: request.message.body,
				replyToClientMessageId: request.message.replyTo,
				expectsReply: request.expectsReply ?? request.message.expectsReply,
				target,
			},
			signal,
		);
		let queueOutcome: CoordinationMessageReceipt["queueOutcome"];
		switch (result.outcome) {
			case PeerMessageOutcome.QUEUED_LIVE:
				queueOutcome = "queued_live";
				break;
			case PeerMessageOutcome.QUEUED_INACTIVE:
				queueOutcome = "queued_inactive";
				break;
			default:
				throw new Error(`Parent peer message ${request.message.id} returned an unknown queue outcome`);
		}
		return {
			to: targetPeerId,
			outcome: "queued",
			queueOutcome,
			messageId: result.messageId,
			inboxSequence: result.inboxSequence,
			replayed: result.replayed,
		};
	}
	inbox(options?: {
		peek?: boolean;
		from?: string;
		fromAny?: ReadonlySet<string>;
		replyTo?: string;
		limit?: number;
	}): IrcMessage[] {
		if (this.#isRotatable() && (!this.#bound || this.#quiesced)) throw unavailable("Parent mailbox inbox");
		if (!this.#mailboxRouter) throw unavailable("mailbox inbox");
		return this.#mailboxRouter.inbox(options);
	}

	async waitMessage(
		filter: CoordinationMessageFilter,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<IrcMessage | null> {
		if (this.#isRotatable() && (!this.#bound || this.#quiesced)) throw unavailable("Parent mailbox wait");
		const router = this.#mailboxRouter;
		if (!router) throw unavailable("mailbox wait");
		const controller = new AbortController();
		const cancel = new Error("Parent mailbox wait settled");
		const forwardAbort = (): void => {
			controller.abort(signal?.reason instanceof Error ? signal.reason : new Error("Parent mailbox wait aborted"));
		};
		if (signal?.aborted) forwardAbort();
		else signal?.addEventListener("abort", forwardAbort, { once: true });
		const waiting = router.wait(filter, timeoutMs, controller.signal);
		const liveness = this.#watchWaitLiveness(filter.from, controller.signal);
		try {
			return await Promise.race([waiting, liveness]);
		} finally {
			signal?.removeEventListener("abort", forwardAbort);
			controller.abort(cancel);
			await Promise.allSettled([waiting, liveness]);
		}
	}

	async #watchWaitLiveness(from: string | undefined, signal: AbortSignal): Promise<never> {
		const check = async (): Promise<void> => {
			const roster = await this.listPeers(signal);
			const relevantError = from ? roster.errors.find(error => error.peerId === from) : roster.errors[0];
			if (relevantError) throw new Error(relevantError.detail);
			if (from) {
				const ref = roster.peers.find(peer => peer.id === from);
				if (!ref) throw new Error(`IRC wait aborted: agent "${from}" is not running`);
				if (from === PARENT_PEER_ID && (!(ref.session instanceof ParentAgentPeer) || !ref.session.mailboxLive)) {
					throw new Error(`IRC wait aborted: agent "${from}" is not running`);
				}
				return;
			}
			const hasLivePeer = roster.peers.some(
				ref => ref.session instanceof ParentAgentPeer && ref.session.mailboxLive,
			);
			if (!hasLivePeer) throw new Error("IRC wait aborted: no running peers remain");
		};
		await check();
		for await (const _snapshot of this.client.watchAgentTree(signal)) await check();
		throw new Error("Parent Agent-tree watch ended during mailbox wait");
	}

	async #resolveMailboxSender(message: AgentMessageSummary, signal?: AbortSignal): Promise<string> {
		const sourceSessionObjectKey = message.sourceSessionId?.trim();
		const callerSession = await this.#readSessionSummary(this.client.sessionKey, signal);
		if (sourceSessionObjectKey && sourceSessionObjectKey === callerSession?.parentSessionId?.trim()) {
			return PARENT_PEER_ID;
		}
		const fromAgentId = message.fromAgentId?.trim();
		if (!fromAgentId) throw new Error("Parent mailbox record has no source Agent object key");
		const tree = await this.#readAgentTree(signal);
		const matches = (tree.agents ?? []).filter(agent => agent.agentId === fromAgentId);
		if (matches.length !== 1) {
			throw new Error(`Parent mailbox source Agent ${fromAgentId} does not resolve exactly`);
		}
		const peerId = matches[0]?.peerId?.trim();
		if (!peerId) throw new Error(`Parent mailbox source Agent ${fromAgentId} has no peer ID`);
		return peerId;
	}

	async interrupt(peerId: string, reason: string, signal?: AbortSignal): Promise<void> {
		await this.#runMutableOperation(
			"Parent Task interrupt",
			async () => await this.#interrupt(peerId, reason, signal),
		);
	}

	async #interrupt(peerId: string, reason: string, signal?: AbortSignal): Promise<void> {
		const id = requirePeerId(peerId);
		let sessionId = this.#sessions.get(id);
		if (!sessionId) {
			const peer = await this.client.resolveAgentPeer(id, signal);
			sessionId = peer.session?.sessionId;
		}
		if (!sessionId) throw new Error(`Parent Task peer ${id} has no active LlmSession`);
		const digest = Bun.SHA256.hash(`${sessionId}\0${reason}`, "hex").slice(0, 32);
		await this.client.interruptSession(
			{
				requestId: `parent-task-interrupt:${digest}`,
				targetSessionId: sessionId,
				reason,
			},
			signal,
		);
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const peers = [...this.#peerCache.values()];
		this.#peerCache.clear();
		await Promise.all([this.#mailboxRouter?.close(), ...this.#activeMutations]);
		this.#mailboxRouter = undefined;
		this.#mailboxReceiver = undefined;
		await Promise.all(peers.map(cached => cached.peer.dispose()));
		await this.client.close();
	}
}
export function createParentCoordinationBackend(
	options: ParentClientOptions & { client?: ParentCoordinationClient } = {},
): ParentCoordinationBackend | undefined {
	if (options.client) return new ParentCoordinationBackend(options.client);
	if (!resolveParentSocketPath(options)) return undefined;
	const client = ParentClient.create(options);
	if (!client) return undefined;
	return new ParentCoordinationBackend(client);
}

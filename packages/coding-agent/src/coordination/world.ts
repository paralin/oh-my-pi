import * as fs from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import type { IrcMessage } from "../irc/bus";
import { type AgentPeer, type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { renderStructuredSubagentPrompt, type StructuredSubagentResult } from "../task/structured-subagent";
import type { AgentProgress, AgentSource, SingleResult, StructuredSubagentOutput } from "../task/types";
import * as git from "../utils/git";
import { resolveWorldSessionKey, resolveWorldSocketPath } from "../world/config";
import type {
	AgentMessageSummary,
	AgentSummary,
	AgentTreeSnapshot,
	SessionSummary,
	TaskProgressSummary,
	TaskResultSummary,
} from "../world/generated/llmsession.pb";
import { PeerMessageOutcome, WorldTaskAgentSource } from "../world/generated/llmsession.pb";
import {
	MAX_SESSION_PAGE,
	WORLD_CHILD_PERMISSIONS,
	WorldClient,
	type WorldClientOptions,
	WorldOperationError,
} from "../world/index";
import {
	DEFAULT_DISPATCH_REPOSITORY,
	defaultCheckoutIdentity,
	defaultIntentOwnerArtifact,
	semanticWorkingDirectory,
} from "../world/intent-key";
import type {
	CoordinationBackend,
	CoordinationMessageFilter,
	CoordinationMessageReceipt,
	CoordinationMessageRequest,
	CoordinationPeerError,
	CoordinationPeerRoster,
	CoordinationSpawnRequest,
	CoordinationTaskHandle,
} from "./backend";
import { buildExternalSubagentProfile, encodeExternalSubagentProfile } from "./external-subagent-profile";
import { WorldAgentPeer, worldSessionLifecycle } from "./world-agent-peer";
import { WorldMailboxRouter } from "./world-mailbox";

/** Public World client surface required by Task and Hub coordination. */
export type WorldCoordinationClient = Pick<
	WorldClient,
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
const RESERVED_PEER_IDS: Readonly<Record<string, true>> = {
	main: true,
	all: true,
	__advisor: true,
};
const WORLD_PARENT_PEER_ID = "main";
const TERMINAL_SESSION_STATE = /(?:^|_)(?:COMPLETE|ARCHIVED|FAILED|CANCELED)$/;

function unavailable(operation: string): Error {
	return new Error(`World coordination ${operation} is unavailable until its durable adapter is installed`);
}

function requirePeerId(value: string): string {
	const peerId = value.trim();
	if (!peerId) throw new Error("World Task peer ID is required");
	if (!/^[A-Za-z0-9_.-]{1,256}$/.test(peerId)) {
		throw new Error("World Task peer ID must contain 1-256 ASCII letters, digits, dots, underscores, or hyphens");
	}
	if (RESERVED_PEER_IDS[peerId.toLowerCase()]) {
		throw new Error(`World Task peer ID ${JSON.stringify(peerId)} is reserved`);
	}
	return peerId;
}

function nextPeerId(value: string): string {
	const match = /^(.*)-([2-9]\d*)$/.exec(value);
	if (!match) return `${value}-2`;
	return `${match[1]}-${Number(match[2]) + 1}`;
}

function sourceOnWire(source: AgentSource): WorldTaskAgentSource {
	switch (source) {
		case "bundled":
			return WorldTaskAgentSource.BUNDLED;
		case "user":
			return WorldTaskAgentSource.USER;
		case "project":
			return WorldTaskAgentSource.PROJECT;
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
	throw new Error(`World Task worktree ${JSON.stringify(worktree)} is outside the configured workspace and home`);
}

function numberFromWire(value: bigint | undefined, field: string): number {
	const result = Number(value ?? 0n);
	if (!Number.isSafeInteger(result)) throw new Error(`World Task ${field} exceeds JavaScript's safe integer range`);
	return result;
}

function parseStructuredOutput(value: string | undefined): StructuredSubagentOutput | undefined {
	if (!value) return undefined;
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("World Task structured output is not an object");
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
		throw new Error("World Task structured output metadata is invalid");
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
		if (!toolName) throw new Error("World Task extracted tool data has no tool name");
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

function latestSessionForAgent(sessions: SessionSummary[], agentObjectKey: string): SessionSummary | undefined {
	return sessions
		.filter(session => session.agentObjectKey === agentObjectKey)
		.sort(
			(left, right) =>
				sessionTimestamp(right) - sessionTimestamp(left) ||
				(right.sessionObjectKey ?? "").localeCompare(left.sessionObjectKey ?? ""),
		)[0];
}

interface CachedWorldPeer {
	sessionObjectKey: string | undefined;
	peer: WorldAgentPeer;
	ref: AgentRef;
}

/** Coordination backend selected once for a configured World root. */
export class WorldCoordinationBackend implements CoordinationBackend {
	readonly kind = "world" as const;
	readonly client: WorldCoordinationClient;
	readonly #sessions = new Map<string, string>();
	readonly #peerCache = new Map<string, CachedWorldPeer>();
	#closed = false;
	#mailboxRouter: WorldMailboxRouter | undefined;

	constructor(client: WorldCoordinationClient) {
		if (!client.canMutate) throw new Error("World coordination requires a caller LlmSession");
		this.client = client;
	}

	async spawn(request: CoordinationSpawnRequest, signal?: AbortSignal): Promise<CoordinationTaskHandle> {
		let peerId = requirePeerId(request.peerId);
		for (;;) {
			signal?.throwIfAborted();
			if ((request.request.session.agentRegistry ?? AgentRegistry.global()).get(peerId)) {
				if (!request.generated) throw new Error(`World Task peer identity conflict: ${peerId}`);
				peerId = nextPeerId(peerId);
				continue;
			}
			const candidate = { ...request, peerId, label: request.generated ? peerId : request.label };
			const profile = buildExternalSubagentProfile({
				peerId,
				label: candidate.label,
				request: candidate.request,
				policy: candidate.policy,
				planReference: candidate.planReference,
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
			if (existing.found) return await this.#attach(candidate, intentKey, existing.session, signal);

			const peer = await this.client.resolveAgentPeer(peerId, signal);
			if (peer.found) {
				if (!request.generated) throw new Error(`World Task peer identity conflict: ${peerId}`);
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
						childWorldOperations: [...WORLD_CHILD_PERMISSIONS],
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
				if (recovered.found) return await this.#attach(candidate, intentKey, recovered.session, signal);
				if (
					error instanceof WorldOperationError &&
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
		session: { sessionObjectKey?: string; parentSessionObjectKey?: string } | undefined,
		signal?: AbortSignal,
	): Promise<CoordinationTaskHandle> {
		const sessionObjectKey = session?.sessionObjectKey?.trim();
		if (!sessionObjectKey) throw new Error(`World Task ${intentKey} has no attached LlmSession`);
		if (session?.parentSessionObjectKey !== this.client.sessionKey) {
			throw new Error(`World Task ${intentKey} belongs to another parent LlmSession`);
		}
		const peer = await this.client.resolveAgentPeer(request.peerId, signal);
		if (!peer.found || peer.agent?.peerId !== request.peerId) {
			throw new Error(`World Task ${intentKey} does not resolve peer ${request.peerId}`);
		}
		if (peer.session?.sessionObjectKey && peer.session.sessionObjectKey !== sessionObjectKey) {
			throw new Error(`World Task peer ${request.peerId} resolves another active LlmSession`);
		}
		this.#sessions.set(request.peerId, sessionObjectKey);
		return {
			peerId: request.peerId,
			wait: async (signal, onProgress) =>
				await this.#watchTask(request, intentKey, sessionObjectKey, signal, onProgress),
		};
	}

	async #watchTask(
		request: CoordinationSpawnRequest,
		intentKey: string,
		sessionObjectKey: string,
		signal?: AbortSignal,
		onProgress?: (progress: AgentProgress) => void,
	): Promise<StructuredSubagentResult> {
		let interrupt: Promise<void> | undefined;
		const interruptFailure = Promise.withResolvers<never>();
		const requestInterrupt = () => {
			if (interrupt) return;
			interrupt = this.interrupt(request.peerId, "Task cancelled by its parent");
			interrupt.catch(error => interruptFailure.reject(error));
		};
		signal?.addEventListener("abort", requestInterrupt, { once: true });
		if (signal?.aborted) requestInterrupt();
		const snapshots = this.client.watchSession(sessionObjectKey)[Symbol.asyncIterator]();
		try {
			for (;;) {
				const next = await Promise.race([snapshots.next(), interruptFailure.promise]);
				if (next.done) throw new Error(`World Task ${intentKey} session watch ended before a terminal result`);
				const snapshot = next.value;
				if (snapshot.progress) onProgress?.(progressFromSnapshot(request, snapshot.progress));
				if (snapshot.taskResult) {
					if (interrupt) await interrupt;
					return await resultFromSnapshot(request, snapshot.taskResult);
				}
				if (TERMINAL_SESSION_STATE.test(snapshot.session?.state ?? "")) {
					throw new Error(`World Task ${intentKey} reached terminal state without TaskResultSummary`);
				}
			}
		} finally {
			signal?.removeEventListener("abort", requestInterrupt);
			await snapshots.return?.();
			interruptFailure.promise.catch(() => {});
		}
	}

	async listPeers(signal?: AbortSignal): Promise<CoordinationPeerRoster> {
		signal?.throwIfAborted();
		const [tree, sessions] = await Promise.all([
			this.#readAgentTree(signal),
			this.client.listSessions(MAX_SESSION_PAGE, signal),
		]);
		const errors: CoordinationPeerError[] = [];
		const peers: AgentRef[] = [];
		const callerSession =
			sessions.find(session => session.sessionObjectKey === this.client.sessionKey) ??
			(await this.#readSessionSummary(this.client.sessionKey, signal));
		if (!callerSession) throw new Error(`Bound World LlmSession ${this.client.sessionKey} is missing`);
		const callerAgentObjectKey = callerSession.agentObjectKey?.trim();
		if (!callerAgentObjectKey) {
			throw new Error(`Bound World LlmSession ${this.client.sessionKey} has no Agent object key`);
		}
		const agentsByKey = new Map(
			(tree.agents ?? [])
				.filter((agent): agent is AgentSummary & { agentObjectKey: string } => !!agent.agentObjectKey)
				.map(agent => [agent.agentObjectKey, agent]),
		);
		const callerAgent = agentsByKey.get(callerAgentObjectKey);
		if (!callerAgent) throw new Error(`Bound World Agent ${callerAgentObjectKey} is absent from the Agent tree`);
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
			if (!peerId || agent.agentObjectKey === callerAgentObjectKey) continue;
			if ((peerCounts.get(peerId) ?? 0) > 1) {
				if (!duplicated.has(peerId)) {
					duplicated.add(peerId);
					errors.push({
						code: "identity_conflict",
						peerId,
						detail: `World Agent tree contains more than one Agent with peer ID ${peerId}`,
					});
				}
				continue;
			}
			try {
				const resolved = await this.client.resolveAgentPeer(peerId, signal);
				if (!resolved.found || resolved.agent?.peerId !== peerId) {
					throw new Error(`World Agent tree peer ${peerId} does not resolve exactly`);
				}
				if (resolved.agent.agentObjectKey !== agent.agentObjectKey) {
					throw new Error(`World peer ${peerId} resolves a different Agent object`);
				}
				const activeSessionObjectKeys = (agent.activeLlmSessionObjectKeys ?? []).filter(Boolean);
				if (activeSessionObjectKeys.length > 1) {
					throw new Error(`World peer ${peerId} has more than one active LlmSession`);
				}
				if (resolved.inactive) {
					if (resolved.session || activeSessionObjectKeys.length !== 0) {
						throw new Error(`World peer ${peerId} has inconsistent inactive-session resolution`);
					}
				} else {
					const resolvedSessionObjectKey = resolved.session?.sessionObjectKey;
					if (
						!resolvedSessionObjectKey ||
						activeSessionObjectKeys.length !== 1 ||
						activeSessionObjectKeys[0] !== resolvedSessionObjectKey
					) {
						throw new Error(`World peer ${peerId} has inconsistent active-session resolution`);
					}
				}
				const session =
					resolved.session ??
					(agent.agentObjectKey ? latestSessionForAgent(sessions, agent.agentObjectKey) : undefined);
				if (session?.agentObjectKey !== agent.agentObjectKey) {
					throw new Error(`World peer ${peerId} resolves a session for a different Agent`);
				}
				if (session && worldSessionLifecycle(peerId, session).inactive !== resolved.inactive) {
					throw new Error(`World peer ${peerId} lifecycle disagrees with its inactive resolution`);
				}
				const parentId =
					agent.parentAgentObjectKey === callerAgentObjectKey
						? boundLocalId
						: agentsByKey.get(agent.parentAgentObjectKey ?? "")?.peerId;
				const ref = await this.#worldRef(peerId, agent, session, parentId, signal);
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

		const parentSessionObjectKey = callerSession?.parentSessionObjectKey?.trim();
		if (parentSessionObjectKey) {
			try {
				const parentSession =
					sessions.find(session => session.sessionObjectKey === parentSessionObjectKey) ??
					(await this.#readSessionSummary(parentSessionObjectKey, signal));
				if (!parentSession) throw new Error(`Manifest parent LlmSession ${parentSessionObjectKey} is missing`);
				const parentAgent = agentsByKey.get(parentSession.agentObjectKey ?? "");
				const mainAgent: AgentSummary = {
					agentObjectKey: parentSession.agentObjectKey,
					name: parentAgent?.name || "Parent",
					peerId: WORLD_PARENT_PEER_ID,
				};
				peers.push(await this.#worldRef(WORLD_PARENT_PEER_ID, mainAgent, parentSession, undefined, signal));
				seen.add(WORLD_PARENT_PEER_ID);
			} catch (error) {
				errors.push({
					code: "projection_error",
					peerId: WORLD_PARENT_PEER_ID,
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
			if (first.done) throw new Error("World Agent-tree watch ended before its initial snapshot");
			return first.value;
		} finally {
			await iterator.return?.();
		}
	}

	async #readSessionSummary(
		sessionObjectKey: string | undefined,
		signal?: AbortSignal,
	): Promise<SessionSummary | undefined> {
		if (!sessionObjectKey) return undefined;
		const iterator = this.client.watchSession(sessionObjectKey, signal)[Symbol.asyncIterator]();
		try {
			const first = await iterator.next();
			if (first.done) return undefined;
			return first.value.session;
		} finally {
			await iterator.return?.();
		}
	}

	async #worldRef(
		peerId: string,
		agent: AgentSummary,
		session: SessionSummary | undefined,
		parentId: string | undefined,
		signal?: AbortSignal,
	): Promise<AgentRef> {
		const sessionObjectKey = session?.sessionObjectKey;
		const cached = this.#peerCache.get(peerId);
		if (cached && cached.sessionObjectKey === sessionObjectKey) {
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
		const peer = await WorldAgentPeer.open(
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
		this.#peerCache.set(peerId, { sessionObjectKey, peer, ref });
		return ref;
	}

	attachMailbox(receiverPeerId: string, receiver: Pick<AgentPeer, "deliverIrcMessage">): void {
		if (this.#closed) throw new Error("World coordination backend is closed");
		if (this.#mailboxRouter) throw new Error("World coordination mailbox is already attached");
		const router = new WorldMailboxRouter({
			client: this.client,
			receiverPeerId,
			receiver,
			resolveSender: async (message, signal) => await this.#resolveMailboxSender(message, signal),
		});
		this.#mailboxRouter = router;
		router.start();
	}

	async send(request: CoordinationMessageRequest, signal?: AbortSignal): Promise<CoordinationMessageReceipt> {
		if (this.#closed) throw new Error("World coordination backend is closed");
		const targetPeerId = request.targetPeerId.trim();
		if (!targetPeerId) throw new Error("World peer message target is required");
		const target =
			targetPeerId === WORLD_PARENT_PEER_ID
				? ({ kind: "parent" } as const)
				: ({ kind: "peer", peerId: requirePeerId(targetPeerId) } as const);
		const digest = Bun.SHA256.hash(`${this.client.sessionKey}\0${request.message.id}`, "hex").slice(0, 32);
		const result = await this.client.sendPeerMessage(
			{
				requestId: `world-peer-send:${digest}`,
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
				throw new Error(`World peer message ${request.message.id} returned an unknown queue outcome`);
		}
		return {
			to: targetPeerId,
			outcome: "queued",
			queueOutcome,
			messageObjectKey: result.messageObjectKey,
			inboxSequence: result.inboxSequence,
			replayed: result.replayed,
		};
	}

	inbox(options?: { peek?: boolean; from?: string; replyTo?: string; limit?: number }): IrcMessage[] {
		if (!this.#mailboxRouter) throw unavailable("mailbox inbox");
		return this.#mailboxRouter.inbox(options);
	}

	async waitMessage(
		filter: CoordinationMessageFilter,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<IrcMessage | null> {
		const router = this.#mailboxRouter;
		if (!router) throw unavailable("mailbox wait");
		const controller = new AbortController();
		const cancel = new Error("World mailbox wait settled");
		const forwardAbort = (): void => {
			controller.abort(signal?.reason instanceof Error ? signal.reason : new Error("World mailbox wait aborted"));
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
				if (
					from === WORLD_PARENT_PEER_ID &&
					(!(ref.session instanceof WorldAgentPeer) || !ref.session.mailboxLive)
				) {
					throw new Error(`IRC wait aborted: agent "${from}" is not running`);
				}
				return;
			}
			const hasLivePeer = roster.peers.some(ref => ref.session instanceof WorldAgentPeer && ref.session.mailboxLive);
			if (!hasLivePeer) throw new Error("IRC wait aborted: no running peers remain");
		};
		await check();
		for await (const _snapshot of this.client.watchAgentTree(signal)) await check();
		throw new Error("World Agent-tree watch ended during mailbox wait");
	}

	async #resolveMailboxSender(message: AgentMessageSummary, signal?: AbortSignal): Promise<string> {
		const sourceSessionObjectKey = message.sourceLlmSessionObjectKey?.trim();
		const callerSession = await this.#readSessionSummary(this.client.sessionKey, signal);
		if (sourceSessionObjectKey && sourceSessionObjectKey === callerSession?.parentSessionObjectKey?.trim()) {
			return WORLD_PARENT_PEER_ID;
		}
		const fromAgentObjectKey = message.fromAgentObjectKey?.trim();
		if (!fromAgentObjectKey) throw new Error("World mailbox record has no source Agent object key");
		const tree = await this.#readAgentTree(signal);
		const matches = (tree.agents ?? []).filter(agent => agent.agentObjectKey === fromAgentObjectKey);
		if (matches.length !== 1) {
			throw new Error(`World mailbox source Agent ${fromAgentObjectKey} does not resolve exactly`);
		}
		const peerId = matches[0]?.peerId?.trim();
		if (!peerId) throw new Error(`World mailbox source Agent ${fromAgentObjectKey} has no peer ID`);
		return peerId;
	}

	async interrupt(peerId: string, reason: string, signal?: AbortSignal): Promise<void> {
		const id = requirePeerId(peerId);
		let sessionObjectKey = this.#sessions.get(id);
		if (!sessionObjectKey) {
			const peer = await this.client.resolveAgentPeer(id, signal);
			sessionObjectKey = peer.session?.sessionObjectKey;
		}
		if (!sessionObjectKey) throw new Error(`World Task peer ${id} has no active LlmSession`);
		const digest = Bun.SHA256.hash(`${sessionObjectKey}\0${reason}`, "hex").slice(0, 32);
		await this.client.interruptSession(
			{
				requestId: `world-task-interrupt:${digest}`,
				targetSessionObjectKey: sessionObjectKey,
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
		await this.#mailboxRouter?.close();
		await Promise.all(peers.map(cached => cached.peer.dispose()));
		await this.client.close();
	}
}

/** Selects a mutable World backend only when socket and caller are both configured. */
export function createWorldCoordinationBackend(options: WorldClientOptions = {}): WorldCoordinationBackend | undefined {
	if (!resolveWorldSocketPath(options) || !resolveWorldSessionKey(options)) return undefined;
	const client = WorldClient.create(options);
	if (!client) return undefined;
	return new WorldCoordinationBackend(client);
}

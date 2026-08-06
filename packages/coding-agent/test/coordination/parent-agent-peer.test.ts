import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	ParentCoordinationBackend,
	type ParentCoordinationClient,
} from "@oh-my-pi/pi-coding-agent/coordination/parent";
import {
	ParentAgentPeer,
	ParentPeerProjectionError,
	parentSessionLifecycle,
} from "@oh-my-pi/pi-coding-agent/coordination/parent-agent-peer";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	type ParentAgentPeerResolution,
	type ParentClient,
	type ParentDispatchSubmit,
	type ParentDispatchSubmitResult,
	ParentOperationError,
} from "@oh-my-pi/pi-coding-agent/parent/client";
import { type IntentKeySource, intentKey } from "@oh-my-pi/pi-coding-agent/parent/intent-key";
import { type AgentPeer, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { formatSessionHistoryMarkdown } from "@oh-my-pi/pi-coding-agent/session/session-history-format";
import type {
	AgentMessageSummary,
	AgentTreeSnapshot,
	SessionSnapshot,
	SessionSummary,
} from "../../src/parent/generated/parent-environment.pb.js";
import {
	ParentFailureCode,
	ParentSessionState,
	PeerMessageAckOutcome,
	PeerMessageOutcome,
} from "../../src/parent/generated/parent-environment.pb.js";

const ROOT_SESSION = "glados/test/llm-session/root";
const ROOT_AGENT = "glados/test/agent/root";

const localPeer: AgentPeer = {
	messages: [],
	deliverIrcMessage: async () => "injected",
	abort: async () => {},
	dispose: async () => {},
};

function message(overrides: Partial<IrcMessage> = {}): IrcMessage {
	return {
		id: "message-1",
		from: MAIN_AGENT_ID,
		to: "worker",
		body: "hello",
		ts: 1,
		...overrides,
	};
}

class RosterClient implements ParentCoordinationClient {
	readonly canMutate = true;
	readonly connected = true;
	readonly calls: string[] = [];
	readonly releases = new Map<string, number>();
	readonly interrupts: string[] = [];
	sessionKey = ROOT_SESSION;
	tree: AgentTreeSnapshot = { agents: [] };
	sessions: SessionSummary[] = [];
	snapshots = new Map<string, SessionSnapshot[]>();
	resolutions = new Map<string, ParentAgentPeerResolution | Error>();
	readonly sentMessages: Parameters<ParentClient["sendPeerMessage"]>[0][] = [];
	readonly acknowledgements: Parameters<ParentClient["ackPeerMessage"]>[0][] = [];
	readonly ackObserved = Promise.withResolvers<void>();
	mailboxMessages: AgentMessageSummary[] = [];
	mailboxGate: Promise<void> | undefined;
	treeHoldOpen = false;
	sendOutcome = PeerMessageOutcome.QUEUED_LIVE;
	closed = false;

	deriveIntentKey(source: IntentKeySource): { intentKey: string; source: IntentKeySource } {
		return intentKey(source);
	}

	async lookupDispatchIntent(): Promise<{ found: false }> {
		return { found: false };
	}

	async submitDispatch(_request: ParentDispatchSubmit): Promise<ParentDispatchSubmitResult> {
		throw new Error("unused");
	}

	async listSessions(limit: number): Promise<SessionSummary[]> {
		this.calls.push("listSessions");
		return this.sessions.slice(0, limit);
	}

	async resolveAgentPeer(peerId: string): Promise<ParentAgentPeerResolution> {
		this.calls.push(`resolve:${peerId}`);
		const value = this.resolutions.get(peerId);
		if (value instanceof Error) throw value;
		return value ?? { found: false, agent: undefined, session: undefined, inactive: false };
	}

	async *watchAgentTree(signal?: AbortSignal): AsyncGenerator<AgentTreeSnapshot, void, void> {
		this.calls.push("watchAgentTree");
		yield this.tree;
		if (this.treeHoldOpen) {
			await new Promise<void>(resolve => {
				if (signal?.aborted) resolve();
				else signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		}
	}

	async sendPeerMessage(
		request: Parameters<ParentClient["sendPeerMessage"]>[0],
	): ReturnType<ParentClient["sendPeerMessage"]> {
		this.sentMessages.push(request);
		return {
			requestId: request.requestId,
			messageId: `glados/test/message/${request.clientMessageId}`,
			clientMessageId: request.clientMessageId,
			toAgentId: "glados/test/agent/target",
			targetSessionId: this.sendOutcome === PeerMessageOutcome.QUEUED_LIVE ? "glados/test/llm-session/target" : "",
			inboxSequence: 1n,
			outcome: this.sendOutcome,
			replayed: false,
		};
	}

	watchPeerMailbox(signal?: AbortSignal): ReturnType<ParentClient["watchPeerMailbox"]> {
		const client = this;
		return (async function* () {
			await client.mailboxGate;
			for (const item of client.mailboxMessages) yield item;
			if (client.treeHoldOpen) {
				await new Promise<void>(resolve => {
					if (signal?.aborted) resolve();
					else signal?.addEventListener("abort", () => resolve(), { once: true });
				});
			}
		})();
	}

	async ackPeerMessage(
		request: Parameters<ParentClient["ackPeerMessage"]>[0],
	): ReturnType<ParentClient["ackPeerMessage"]> {
		this.acknowledgements.push(request);
		this.ackObserved.resolve();
		return {
			requestId: request.requestId,
			messageId: request.messageId,
			consumedBySessionId: this.sessionKey,
			consumedAt: "2026-08-04T12:00:00Z",
			replayed: false,
		};
	}

	async *watchSession(sessionId: string): AsyncGenerator<SessionSnapshot, void, void> {
		this.calls.push(`watchSession:${sessionId}`);
		try {
			for (const snapshot of this.snapshots.get(sessionId) ?? []) yield snapshot;
		} finally {
			this.releases.set(sessionId, (this.releases.get(sessionId) ?? 0) + 1);
		}
	}

	async interruptSession(request: { targetSessionId: string }): Promise<{
		requestId: string;
		operation: "session_interrupt";
		targetSessionId: string;
		dispatchKey: string;
		acceptedSequence: bigint;
		detail: string;
		replayed: boolean;
	}> {
		this.interrupts.push(request.targetSessionId);
		return {
			requestId: "interrupt",
			operation: "session_interrupt",
			targetSessionId: request.targetSessionId,
			dispatchKey: "dispatch/1",
			acceptedSequence: 1n,
			detail: "accepted",
			replayed: false,
		};
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

function activeSession(peerId: string, state = ParentSessionState.ACTIVE): SessionSummary {
	return {
		sessionId: `glados/test/llm-session/${peerId}`,
		agentId: `glados/test/agent/${peerId}`,
		parentSessionId: ROOT_SESSION,
		state,
		updatedAt: "2026-08-04T10:00:00Z",
	};
}

function configureRoot(client: RosterClient): void {
	const root: SessionSummary = {
		sessionId: ROOT_SESSION,
		agentId: ROOT_AGENT,
		state: ParentSessionState.ACTIVE,
	};
	client.sessions.push(root);
	client.snapshots.set(ROOT_SESSION, [{ session: root }]);
	client.tree = {
		agents: [{ agentId: ROOT_AGENT, name: "Operator", activeSessionIds: [ROOT_SESSION] }],
	};
}

function addPeer(client: RosterClient, peerId: string, state = ParentSessionState.ACTIVE): SessionSummary {
	const session = activeSession(peerId, state);
	const inactive = new Set([
		ParentSessionState.COMPLETE,
		ParentSessionState.ARCHIVED,
		ParentSessionState.FAILED,
		ParentSessionState.CANCELED,
	]).has(state);
	const agent = {
		agentId: session.agentId,
		parentAgentId: ROOT_AGENT,
		name: peerId.toUpperCase(),
		peerId,
		activeSessionIds: inactive ? [] : [session.sessionId!],
	};
	client.tree.agents?.push(agent);
	client.sessions.push(session);
	client.snapshots.set(session.sessionId!, [
		{
			session,
			turns: [{ turnId: `${peerId}-turn`, role: "assistant", content: `${peerId} history` }],
			progress: { lastIntent: `${peerId} intent` },
		},
	]);
	client.resolutions.set(peerId, {
		found: true,
		agent,
		session: inactive ? undefined : session,
		inactive,
	});
	return session;
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
});

describe("Parent session lifecycle projection", () => {
	test.each([
		[ParentSessionState.CREATED, "running", false, true],
		[ParentSessionState.ACTIVE, "running", false, true],
		[ParentSessionState.AWAITING_PROCESS, "running", false, true],
		[ParentSessionState.BLOCKED, "idle", false, true],
		[ParentSessionState.AWAITING_USER, "idle", false, true],
		[ParentSessionState.DORMANT, "parked", false, false],
		[ParentSessionState.COMPLETE, "idle", true, false],
		[ParentSessionState.ARCHIVED, "idle", true, false],
		[ParentSessionState.FAILED, "aborted", true, false],
		[ParentSessionState.CANCELED, "aborted", true, false],
	] as const)("maps %s without inference", (state, status, inactive, mailboxLive) => {
		expect(parentSessionLifecycle("worker", { sessionId: "session", state })).toEqual({
			status,
			inactive,
			mailboxLive,
		});
	});

	test.each([ParentSessionState.UNKNOWN, 99 as ParentSessionState])("rejects unknown lifecycle %s", state => {
		expect(() => parentSessionLifecycle("worker", { sessionId: "session", state })).toThrow(
			ParentPeerProjectionError,
		);
	});
});

describe("ParentAgentPeer", () => {
	test("reads history and messages from the latest complete session snapshot", async () => {
		const session = activeSession("worker", ParentSessionState.BLOCKED);
		let releases = 0;
		const deliveries: IrcMessage[] = [];
		const aborts: string[] = [];
		const client = {
			watchSession: () =>
				(async function* () {
					try {
						yield {
							session,
							turns: [
								{ turnId: "turn-1", role: "assistant", content: "durable history" },
								{ turnId: "turn-2", role: "user", content: "next step" },
								{ turnId: "turn-3", role: "system", content: "provider context" },
							],
							inboxMessages: [{ clientMessageId: "message-1", body: "durable inbox" }],
							progress: { lastIntent: "Reviewing" },
						};
					} finally {
						releases += 1;
					}
				})(),
		};
		const peer = await ParentAgentPeer.open({
			client,
			peerId: "worker",
			session,
			deliver: async value => {
				deliveries.push(value);
				return "queued";
			},
			abort: async reason => {
				aborts.push(reason);
			},
		});

		expect(peer.status).toBe("idle");
		expect(peer.activity).toBe("Reviewing");
		expect(peer.messages).toEqual([expect.objectContaining({ clientMessageId: "message-1" })]);
		const history = await peer.readHistorySnapshot();
		expect(history).toEqual({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "durable history" }] },
				{ role: "user", content: "next step" },
				{ role: "custom", customType: "parent-turn:system", content: "provider context", display: true },
			],
			sourceLabel: `Parent session ${session.sessionId}`,
		});
		expect(formatSessionHistoryMarkdown(history.messages)).toContain("durable history");
		expect(formatSessionHistoryMarkdown(history.messages)).toContain("[parent-turn:system] provider context");
		expect(await peer.deliverIrcMessage(message())).toBe("queued");
		await peer.abort({ reason: "stop" });
		expect(deliveries).toHaveLength(1);
		expect(aborts).toEqual(["stop"]);
		await peer.dispose();
		expect(releases).toBe(1);
	});

	test("dispose releases the monitor without sending or interrupting", async () => {
		const session = activeSession("worker");
		let releases = 0;
		let mutations = 0;
		const peer = await ParentAgentPeer.open({
			client: {
				watchSession: (_sessionId, signal) =>
					(async function* () {
						try {
							yield { session };
							await new Promise<void>(resolve => {
								if (signal?.aborted) resolve();
								else signal?.addEventListener("abort", () => resolve(), { once: true });
							});
						} finally {
							releases += 1;
						}
					})(),
			},
			peerId: "worker",
			session,
			deliver: async () => {
				mutations += 1;
				return "queued";
			},
			abort: async () => {
				mutations += 1;
			},
		});

		await peer.dispose();
		expect(releases).toBe(1);
		expect(mutations).toBe(0);
	});
});

describe("Parent roster", () => {
	test("projects active, inactive, failed, history, and parent identity without registering proxies", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			status: "running",
			session: localPeer,
		});
		const client = new RosterClient();
		configureRoot(client);
		addPeer(client, "worker");
		addPeer(client, "dormant", ParentSessionState.DORMANT);
		addPeer(client, "failed", ParentSessionState.FAILED);
		const backend = new ParentCoordinationBackend(client);

		const roster = await backend.listPeers();
		expect(roster.errors).toEqual([]);
		expect(roster.peers.map(ref => [ref.id, ref.status, ref.parentId])).toEqual([
			["worker", "running", MAIN_AGENT_ID],
			["dormant", "parked", MAIN_AGENT_ID],
			["failed", "aborted", MAIN_AGENT_ID],
		]);
		expect(registry.list().map(ref => ref.id)).toEqual([MAIN_AGENT_ID]);
		const worker = roster.peers.find(ref => ref.id === "worker");
		expect(await worker?.session?.readHistorySnapshot?.()).toEqual(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						content: [{ type: "text", text: "worker history" }],
					}),
				],
			}),
		);
		await backend.close();
		expect(client.closed).toBe(true);
		expect(client.interrupts).toEqual([]);
	});

	test("associates an external child with a reserved main backed only by its manifest parent", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "child",
			displayName: "Child",
			kind: "sub",
			status: "running",
			session: localPeer,
		});
		const client = new RosterClient();
		const parent: SessionSummary = {
			sessionId: ROOT_SESSION,
			agentId: ROOT_AGENT,
			state: ParentSessionState.BLOCKED,
		};
		const child: SessionSummary = {
			sessionId: "glados/test/llm-session/child",
			agentId: "glados/test/agent/child",
			parentSessionId: ROOT_SESSION,
			state: ParentSessionState.ACTIVE,
		};
		client.sessionKey = child.sessionId!;
		client.sessions = [parent, child];
		client.tree = {
			agents: [
				{ agentId: ROOT_AGENT, name: "Operator" },
				{
					agentId: child.agentId,
					parentAgentId: ROOT_AGENT,
					peerId: "child",
					name: "Child",
					activeSessionIds: [child.sessionId!],
				},
			],
		};
		client.snapshots.set(ROOT_SESSION, [
			{ session: parent, turns: [{ turnId: "parent-turn", role: "assistant", content: "parent history" }] },
		]);
		client.snapshots.set(child.sessionId!, [{ session: child }]);
		const backend = new ParentCoordinationBackend(client);

		const roster = await backend.listPeers();
		expect(roster.errors).toEqual([]);
		expect(roster.peers.map(ref => ref.id)).toEqual(["main"]);
		const main = roster.peers[0]!;
		expect(main.status).toBe("idle");
		expect(await main.session?.readHistorySnapshot?.()).toEqual(
			expect.objectContaining({
				messages: [
					expect.objectContaining({
						content: [{ type: "text", text: "parent history" }],
					}),
				],
			}),
		);
		await backend.close();
	});

	test("returns a Parent collision row for the merge layer to reject", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: localPeer });
		registry.register({ id: "worker", displayName: "Local worker", kind: "sub", session: localPeer });
		const client = new RosterClient();
		configureRoot(client);
		addPeer(client, "worker");
		const backend = new ParentCoordinationBackend(client);

		const roster = await backend.listPeers();
		expect(roster.peers.map(ref => ref.id)).toEqual(["worker"]);
		expect(roster.errors).toEqual([]);
		await backend.close();
	});

	test("omits ambiguous and unknown-state peers with typed projection errors", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: localPeer });
		const client = new RosterClient();
		configureRoot(client);
		addPeer(client, "ambiguous");
		addPeer(client, "unknown", ParentSessionState.UNKNOWN);
		client.resolutions.set(
			"ambiguous",
			new ParentOperationError(
				"parent.agent.message.receive",
				{
					code: ParentFailureCode.AMBIGUOUS_ACTIVE_PEER,
					detail: "two active Task sessions",
				},
				"",
			),
		);
		const backend = new ParentCoordinationBackend(client);

		const roster = await backend.listPeers();
		expect(roster.peers).toEqual([]);
		expect(roster.errors).toEqual([
			expect.objectContaining({ code: "projection_error", peerId: "ambiguous" }),
			expect.objectContaining({ code: "projection_error", peerId: "unknown" }),
		]);
		await backend.close();
	});

	test("rejects a roster when the bound session identity is missing", async () => {
		const client = new RosterClient();
		const backend = new ParentCoordinationBackend(client);

		await expect(backend.listPeers()).rejects.toThrow(`Bound Parent LlmSession ${ROOT_SESSION} is missing`);
		await backend.close();
	});

	test("omits peers whose resolved activity disagrees with the Agent tree", async () => {
		const client = new RosterClient();
		configureRoot(client);
		addPeer(client, "worker");
		const resolution = client.resolutions.get("worker");
		if (!resolution || resolution instanceof Error) throw new Error("missing worker resolution");
		client.resolutions.set("worker", { ...resolution, session: undefined, inactive: true });
		const backend = new ParentCoordinationBackend(client);

		const roster = await backend.listPeers();
		expect(roster.peers).toEqual([]);
		expect(roster.errors).toEqual([
			expect.objectContaining({
				code: "projection_error",
				peerId: "worker",
				detail: expect.stringContaining("inconsistent inactive-session resolution"),
			}),
		]);
		await backend.close();
	});
});

describe("Parent peer messaging", () => {
	test("stores ordinary and reserved-parent sends with stable typed receipts", async () => {
		const client = new RosterClient();
		const backend = new ParentCoordinationBackend(client);

		const live = await backend.send({
			targetPeerId: "worker",
			message: message({ id: "send-1", expectsReply: true }),
			expectsReply: true,
		});
		client.sendOutcome = PeerMessageOutcome.QUEUED_INACTIVE;
		const inactive = await backend.send({
			targetPeerId: "main",
			message: message({ id: "send-2", to: "main", replyTo: "question-1" }),
		});

		expect(live).toEqual(
			expect.objectContaining({
				to: "worker",
				outcome: "queued",
				queueOutcome: "queued_live",
				inboxSequence: 1n,
			}),
		);
		expect(inactive.queueOutcome).toBe("queued_inactive");
		expect(client.sentMessages.map(request => request.target)).toEqual([
			{ kind: "peer", peerId: "worker" },
			{ kind: "parent" },
		]);
		expect(client.sentMessages.map(request => request.clientMessageId)).toEqual(["send-1", "send-2"]);
		expect(client.sentMessages[1]?.replyToClientMessageId).toBe("question-1");
		await expect(
			backend.send({
				targetPeerId: "glados/test/llm-session/worker",
				message: message({ id: "send-raw-session" }),
			}),
		).rejects.toThrow("Parent Task peer ID must contain");
		expect(client.sentMessages).toHaveLength(2);
		await backend.close();
	});

	test("maps the manifest parent to reserved main and gives a filtered waiter first claim", async () => {
		const client = new RosterClient();
		const parent: SessionSummary = {
			sessionId: ROOT_SESSION,
			agentId: ROOT_AGENT,
			state: ParentSessionState.BLOCKED,
		};
		const child: SessionSummary = {
			sessionId: "glados/test/llm-session/child",
			agentId: "glados/test/agent/child",
			parentSessionId: ROOT_SESSION,
			state: ParentSessionState.ACTIVE,
		};
		client.sessionKey = child.sessionId!;
		client.sessions = [parent, child];
		client.tree = {
			agents: [
				{ agentId: ROOT_AGENT, name: "Operator", activeSessionIds: [ROOT_SESSION] },
				{
					agentId: child.agentId,
					parentAgentId: ROOT_AGENT,
					peerId: "child",
					name: "Child",
					activeSessionIds: [child.sessionId!],
				},
			],
		};
		client.snapshots.set(ROOT_SESSION, [{ session: parent }]);
		client.snapshots.set(child.sessionId!, [{ session: child }]);
		client.mailboxMessages = [
			{
				messageId: "glados/test/message/parent",
				fromAgentId: ROOT_AGENT,
				sourceSessionId: ROOT_SESSION,
				clientMessageId: "parent-message",
				replyToClientMessageId: "question-1",
				body: "parent reply",
				createdAt: "2026-08-04T12:00:00Z",
				inboxSequence: 3n,
			},
		];
		const mailboxGate = Promise.withResolvers<void>();
		client.mailboxGate = mailboxGate.promise;
		client.treeHoldOpen = true;
		const deliveries: IrcMessage[] = [];
		const backend = new ParentCoordinationBackend(client);
		backend.attachMailbox("child", {
			deliverIrcMessage: async incoming => {
				deliveries.push(incoming);
				return "injected";
			},
		});

		const waiting = backend.waitMessage({ from: "main", replyTo: "question-1" }, 1_000);
		mailboxGate.resolve();
		const received = await waiting;

		expect(received).toEqual(
			expect.objectContaining({
				id: "parent-message",
				from: "main",
				to: "child",
				replyTo: "question-1",
				inboxSequence: 3n,
				source: "parent",
			}),
		);
		expect(deliveries).toEqual([]);
		expect(client.acknowledgements).toEqual([
			expect.objectContaining({
				messageId: "glados/test/message/parent",
				outcome: PeerMessageAckOutcome.WAITER,
			}),
		]);
		await backend.close();
	});

	test("lets a filtered wait follow an inactive durable peer into its next session", async () => {
		const client = new RosterClient();
		configureRoot(client);
		addPeer(client, "worker", ParentSessionState.FAILED);
		client.treeHoldOpen = true;
		const backend = new ParentCoordinationBackend(client);
		backend.attachMailbox(MAIN_AGENT_ID, localPeer);

		expect(await backend.waitMessage({ from: "worker" }, 5)).toBeNull();
		await backend.close();
	});

	test("terminates a filtered wait when the durable peer is missing", async () => {
		const client = new RosterClient();
		configureRoot(client);
		client.treeHoldOpen = true;
		const backend = new ParentCoordinationBackend(client);
		backend.attachMailbox(MAIN_AGENT_ID, localPeer);

		await expect(backend.waitMessage({ from: "missing" }, 1_000)).rejects.toThrow(
			'IRC wait aborted: agent "missing" is not running',
		);
		await backend.close();
	});
});

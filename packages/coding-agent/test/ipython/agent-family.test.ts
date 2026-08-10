import { beforeEach, describe, expect, test } from "bun:test";
import type { CoordinationBackend } from "../../src/coordination/backend.js";
import { createAgentFamilyIpythonHostHandlers, OmpAgentFamilyService } from "../../src/ipython/agent-family.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { IrcBus, type IrcMessage } from "../../src/irc/bus.js";
import { type AgentPeer, AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry.js";

function hostRequest(
	data: Readonly<Record<string, unknown>>,
	signal = new AbortController().signal,
): IpythonHostRequest {
	return {
		requestId: "request-1",
		executionId: "execution-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal,
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 7,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("not used");
		},
	};
}

function peer(
	messages: unknown[] = [],
	deliver: (message: IrcMessage) => Promise<"injected" | "queued" | "woken"> = async () => "injected",
): AgentPeer {
	return {
		messages,
		readHistorySnapshot: async () => ({ messages }),
		deliverIrcMessage: deliver,
		abort: async () => {},
		dispose: async () => {},
	};
}

function register(
	registry: AgentRegistry,
	id: string,
	name: string,
	parentId: string | undefined,
	session: AgentPeer | null,
): void {
	registry.register({ id, displayName: name, kind: id === MAIN_AGENT_ID ? "main" : "sub", parentId, session });
}

function service(registry: AgentRegistry, bus: IrcBus, currentId: string, backend?: CoordinationBackend) {
	return new OmpAgentFamilyService({
		registry,
		bus,
		currentAgentId: () => currentId,
		currentSessionId: () => `${currentId}-session`,
		currentCwd: () => `/workspace/${currentId}`,
		currentSessionFile: () => null,
		coordinationBackend: backend,
	});
}

describe("IPython agent family services", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;
	let delivered: IrcMessage[];

	beforeEach(() => {
		registry = new AgentRegistry();
		bus = new IrcBus(registry);
		delivered = [];
		const receive = async (message: IrcMessage): Promise<"injected"> => {
			delivered.push(message);
			return "injected";
		};
		register(registry, MAIN_AGENT_ID, "root", undefined, peer([], receive));
		register(registry, "alpha-id", "alpha", MAIN_AGENT_ID, peer([], receive));
		register(registry, "beta-id", "beta", MAIN_AGENT_ID, peer([], receive));
		register(registry, "grandchild-id", "grandchild", "alpha-id", peer([], receive));
		register(registry, "unrelated-id", "unrelated", undefined, peer([], receive));
	});

	test("derives sender identity and enforces parent, sibling, and direct-child reach", async () => {
		const rootHandlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, MAIN_AGENT_ID));
		const roster = await rootHandlers["agent_message.list_agents"]?.(
			hostRequest({ type: "agent_message.list_agents" }),
		);
		expect(roster?.entries).toEqual([
			expect.objectContaining({ relationship: "child", id: "alpha-id", name: "alpha" }),
			expect.objectContaining({ relationship: "child", id: "beta-id", name: "beta" }),
		]);

		const receipt = await rootHandlers["agent_message.send"]?.(
			hostRequest({
				type: "agent_message.send",
				message: "hello",
				receiver_role: "child",
				receiver_name: "alpha",
				id: "agentmsg_stable",
			}),
		);
		expect(receipt).toMatchObject({ id: "agentmsg_stable", deliveryStatus: "delivered" });
		expect(delivered.at(-1)).toMatchObject({ id: "agentmsg_stable", from: MAIN_AGENT_ID, to: "alpha-id" });
		await expect(
			rootHandlers["agent_message.send"]?.(
				hostRequest({
					type: "agent_message.send",
					message: "spoof",
					receiver_role: "child",
					receiver_name: "alpha",
					from: "spoofed",
				}),
			),
		).rejects.toThrow("unknown field");

		const childHandlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, "alpha-id"));
		const childRoster = await childHandlers["agent_message.list_agents"]?.(
			hostRequest({ type: "agent_message.list_agents" }),
		);
		expect(childRoster?.entries).toEqual([
			expect.objectContaining({ relationship: "parent", id: MAIN_AGENT_ID }),
			expect.objectContaining({ relationship: "sibling", id: "beta-id" }),
			expect.objectContaining({ relationship: "child", id: "grandchild-id" }),
		]);
		await expect(
			childHandlers["agent_message.send"]?.(
				hostRequest({
					type: "agent_message.send",
					message: "blocked",
					receiver_role: "child",
					receiver_name: "unrelated",
				}),
			),
		).rejects.toThrow("No child matches");
	});

	test("waits event-first for a correlated reply without delivering it twice", async () => {
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, "alpha-id"));
		const waiting = handlers["agent_message.wait"]?.(
			hostRequest({
				type: "agent_message.wait",
				timeout_ms: 1_000,
				sender: MAIN_AGENT_ID,
				reply_to: "agentmsg_original",
			}),
		);
		setImmediate(() => {
			void bus.send({
				id: "agentmsg_reply",
				from: MAIN_AGENT_ID,
				to: "alpha-id",
				body: "done",
				replyTo: "agentmsg_original",
			});
		});
		expect(await waiting).toMatchObject({
			message: { id: "agentmsg_reply", message: "done", replyTo: "agentmsg_original" },
		});
		expect(delivered.some(message => message.id === "agentmsg_reply")).toBe(false);
	});

	test("peeks and consumes only matching retained inbox messages", async () => {
		const rejecting = peer([], async () => {
			throw new Error("temporarily busy");
		});
		const alpha = registry.get("alpha-id")!;
		alpha.session = rejecting;
		await bus.send({ id: "one", from: MAIN_AGENT_ID, to: "alpha-id", body: "first", replyTo: "r1" });
		await bus.send({ id: "two", from: "beta-id", to: "alpha-id", body: "second", replyTo: "r2" });
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, "alpha-id"));
		const peeked = await handlers["agent_message.inbox"]?.(
			hostRequest({
				type: "agent_message.inbox",
				limit: 20,
				consume: false,
				sender: MAIN_AGENT_ID,
				reply_to: "r1",
			}),
		);
		expect(peeked?.messages).toEqual([expect.objectContaining({ id: "one", message: "first" })]);
		await handlers["agent_message.inbox"]?.(
			hostRequest({
				type: "agent_message.inbox",
				limit: 20,
				consume: true,
				sender: MAIN_AGENT_ID,
				reply_to: "r1",
			}),
		);
		expect(bus.inbox("alpha-id", { peek: true }).map(message => message.id)).toEqual(["two"]);
	});

	test("returns bounded transcript previews only for nuclear-family sessions", async () => {
		const secretArgs = { token: "do-not-expose-tool-arguments" };
		const messages = [
			{ role: "user", content: "request" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "x".repeat(120) },
					{ type: "toolCall", name: "bash", arguments: secretArgs },
				],
			},
		];
		registry.get("beta-id")!.session = peer(messages);
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, "alpha-id"));
		const recent = await handlers["agent_observe.recent"]?.(
			hostRequest({
				type: "agent_observe.recent",
				target: "beta",
				limit: 1,
				max_chars: 80,
			}),
		);
		expect(recent).toMatchObject({
			limit: 1,
			maxChars: 80,
			truncated: true,
			messages: [expect.objectContaining({ role: "assistant", truncated: true, toolCalls: ["bash"] })],
		});
		expect(JSON.stringify(recent)).not.toContain(secretArgs.token);
		await expect(
			handlers["agent_observe.get"]?.(hostRequest({ type: "agent_observe.get", target: "unrelated-id" })),
		).rejects.toThrow("No observable family agent");
	});

	test("retains messages from outside the nuclear family without exposing them", async () => {
		registry.get("alpha-id")!.session = peer([], async () => {
			throw new Error("temporarily busy");
		});
		await bus.send({ id: "family", from: MAIN_AGENT_ID, to: "alpha-id", body: "visible" });
		await bus.send({ id: "outside", from: "unrelated-id", to: "alpha-id", body: "hidden" });
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, "alpha-id"));
		const inbox = await handlers["agent_message.inbox"]?.(
			hostRequest({ type: "agent_message.inbox", limit: 100, consume: true }),
		);
		expect(inbox?.messages).toEqual([expect.objectContaining({ id: "family" })]);
		expect(bus.inbox("alpha-id", { peek: true }).map(message => message.id)).toEqual(["outside"]);
		await expect(
			handlers["agent_message.inbox"]?.(
				hostRequest({ type: "agent_message.inbox", limit: 1, consume: false, sender: "unrelated" }),
			),
		).rejects.toThrow("No family agent matches sender");
	});

	test("rejects oversized messages and unbounded mailbox or observation requests", async () => {
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, MAIN_AGENT_ID));
		await expect(
			handlers["agent_message.send"]?.(
				hostRequest({
					type: "agent_message.send",
					message: "x".repeat(16_385),
					receiver_role: "child",
					receiver_name: "alpha",
				}),
			),
		).rejects.toThrow("exceeds 16384 characters");
		await expect(
			handlers["agent_message.inbox"]?.(hostRequest({ type: "agent_message.inbox", limit: 101, consume: false })),
		).rejects.toThrow("integer from 1 to 100");
		await expect(
			handlers["agent_observe.recent"]?.(
				hostRequest({ type: "agent_observe.recent", target: "alpha", max_chars: 79 }),
			),
		).rejects.toThrow("integer from 80 to 2000");
	});

	test("preserves stable IDs and family names through the Parent backend", async () => {
		const parentMessages: IrcMessage[] = [];
		const parentRef = {
			id: "parent-child",
			displayName: "parent worker",
			kind: "sub" as const,
			parentId: MAIN_AGENT_ID,
			status: "idle" as const,
			session: peer(),
			sessionFile: null,
			createdAt: Date.now(),
			lastActivity: Date.now(),
		};
		const backend = {
			kind: "parent",
			listPeers: async () => ({ peers: [parentRef], errors: [] }),
			send: async ({ targetPeerId, message }: { targetPeerId: string; message: IrcMessage }) => {
				parentMessages.push(message);
				return {
					to: targetPeerId,
					outcome: "queued",
					queueOutcome: "queued_inactive",
					messageId: "message-key",
					inboxSequence: 1n,
					replayed: false,
				};
			},
			inbox: () => [],
			waitMessage: async () => null,
		} as unknown as CoordinationBackend;
		const handlers = createAgentFamilyIpythonHostHandlers(service(registry, bus, MAIN_AGENT_ID, backend));
		const receipt = await handlers["agent_message.send"]?.(
			hostRequest({
				type: "agent_message.send",
				message: "durable",
				receiver_role: "child",
				receiver_name: "parent worker",
				id: "agentmsg_parent",
			}),
		);
		expect(receipt).toMatchObject({
			id: "agentmsg_parent",
			deliveryStatus: "queued",
			queueOutcome: "queued_inactive",
		});
		expect(parentMessages).toEqual([
			expect.objectContaining({ id: "agentmsg_parent", from: MAIN_AGENT_ID, to: "parent-child" }),
		]);
	});
});

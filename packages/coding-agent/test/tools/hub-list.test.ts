import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CoordinationBackend } from "@oh-my-pi/pi-coding-agent/coordination/backend";
import { type AgentPeer, AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import { executeList } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";
import { WorldAuthorityError, WorldOperationError } from "@oh-my-pi/pi-coding-agent/world/client";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	WorldAuthorityDenialCode,
	WorldOperationFailureCode,
	WorldRuntimeOperation,
} from "../../src/world/generated/llmsession.pb.js";

describe("hub list", () => {
	it("restores persisted peers after the process registry is lost", async () => {
		using tempDir = TempDir.createSync("@omp-hub-list-persisted-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");

		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: null,
			sessionFile,
			status: "running",
		});

		const result = await executeList(registry, MAIN_AGENT_ID);
		if (!result.details) throw new Error("Expected coordination details");

		expect(result.details.peers).toEqual([
			expect.objectContaining({
				id: "Worker",
				kind: "sub",
				status: "parked",
				parentId: MAIN_AGENT_ID,
			}),
		]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text result");
		expect(content.text).toContain("Worker");
		expect(content.text).toContain("parked");
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
	});

	it("merges World rows, retains collisions, and exposes projection errors", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "injected",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: peer,
			status: "running",
		});
		registry.register({
			id: "worker",
			displayName: "Local worker",
			kind: "sub",
			session: peer,
			status: "idle",
		});
		const now = Date.now();
		const result = await executeList(registry, MAIN_AGENT_ID, {
			peers: [
				{
					id: "worker",
					displayName: "World worker",
					kind: "sub",
					status: "running",
					session: peer,
					sessionFile: null,
					createdAt: now,
					lastActivity: now,
				},
				{
					id: "failed",
					displayName: "Failed worker",
					kind: "sub",
					status: "aborted",
					session: peer,
					sessionFile: null,
					createdAt: now,
					lastActivity: now,
				},
			],
			errors: [],
		});

		expect(result.details?.peers).toHaveLength(3);
		expect(result.details?.peers?.[0]).toEqual(
			expect.objectContaining({ id: "worker", displayName: "Local worker" }),
		);
		expect(result.details?.peers?.[0]?.source).toBeUndefined();
		expect(result.details?.peers?.[1]).toEqual(
			expect.objectContaining({ id: "worker", displayName: "World worker", source: "world" }),
		);
		expect(result.details?.peers?.[2]).toEqual(
			expect.objectContaining({ id: "failed", status: "aborted", source: "world" }),
		);
		expect(result.details?.rosterErrors).toEqual([
			expect.objectContaining({ code: "identity_conflict", peerId: "worker" }),
		]);
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text result");
		expect(content.text).toContain("3 peer(s)");
		expect(content.text).toContain("identity_conflict");
	});

	it("loads the World roster through the root-scoped Hub backend", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "queued",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: peer,
			status: "running",
		});
		const now = Date.now();
		let listed = 0;
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => {
				listed += 1;
				return {
					peers: [
						{
							id: "foreign",
							displayName: "Foreign",
							kind: "sub",
							status: "idle",
							session: peer,
							sessionFile: null,
							createdAt: now,
							lastActivity: now,
						},
					],
					errors: [],
				};
			},
			send: () => Promise.reject(new Error("unused")),
			attachMailbox: () => {},
			inbox: () => [],
			waitMessage: () => Promise.reject(new Error("unused")),
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};

		const result = await new HubTool(session).execute("list", { op: "list" });
		expect(listed).toBe(1);
		if (!result.details || !("peers" in result.details)) throw new Error("Expected coordination details");
		expect(result.details.peers).toEqual([expect.objectContaining({ id: "foreign", source: "world" })]);
	});

	it("routes World sends and await-reply correlation through the backend", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "queued",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: peer,
			status: "running",
		});
		const sent: Parameters<CoordinationBackend["send"]>[0][] = [];
		const filters: Parameters<CoordinationBackend["waitMessage"]>[0][] = [];
		const now = Date.now();
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => ({
				peers: [
					{
						id: "foreign",
						displayName: "Foreign",
						kind: "sub",
						status: "running",
						session: peer,
						sessionFile: null,
						createdAt: now,
						lastActivity: now,
					},
				],
				errors: [],
			}),
			attachMailbox: () => {},
			send: async request => {
				sent.push(request);
				return {
					to: request.targetPeerId,
					outcome: "queued",
					queueOutcome: "queued_live",
					messageObjectKey: "glados/messages/1",
					inboxSequence: 7n,
					replayed: false,
				};
			},
			inbox: () => [],
			waitMessage: async filter => {
				filters.push(filter);
				return {
					id: "reply-1",
					from: "foreign",
					to: MAIN_AGENT_ID,
					body: "done",
					ts: now + 1,
					replyTo: filter.replyTo,
					source: "world",
				};
			},
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};

		const result = await new HubTool(session).execute("send", {
			op: "send",
			to: "foreign",
			message: "status?",
			await: true,
		});

		expect(result.isError).not.toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toEqual(
			expect.objectContaining({
				targetPeerId: "foreign",
				expectsReply: true,
				message: expect.objectContaining({
					from: MAIN_AGENT_ID,
					to: "foreign",
					body: "status?",
					expectsReply: true,
					source: "world",
				}),
			}),
		);
		expect(filters).toEqual([{ from: "foreign", replyTo: sent[0]?.message.id }]);
		if (!result.details || !("receipts" in result.details)) throw new Error("Expected coordination details");
		expect(result.details.receipts).toEqual([
			expect.objectContaining({ to: "foreign", outcome: "queued", queueOutcome: "queued_live" }),
		]);
		expect(result.details.waited).toEqual(expect.objectContaining({ id: "reply-1", replyTo: sent[0]?.message.id }));
	});

	it("drains and waits on the World mailbox through Hub", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "queued",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: peer,
			status: "running",
		});
		const now = Date.now();
		const foreignRef = {
			id: "foreign",
			displayName: "Foreign",
			kind: "sub" as const,
			status: "running" as const,
			session: peer,
			sessionFile: null,
			createdAt: now,
			lastActivity: now,
		};
		const inbox = [
			{
				id: "inbox-1",
				from: "foreign",
				to: MAIN_AGENT_ID,
				body: "unsolicited",
				ts: now,
				source: "world" as const,
			},
		];
		let drain = true;
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => ({ peers: [foreignRef], errors: [] }),
			attachMailbox: () => {},
			send: () => Promise.reject(new Error("unused")),
			inbox: options => {
				if (!drain) return [];
				if (options?.from && options.from !== "foreign") return [];
				if (!options?.peek) drain = false;
				return inbox;
			},
			waitMessage: async () => ({
				id: "wait-1",
				from: "foreign",
				to: MAIN_AGENT_ID,
				body: "later",
				ts: now + 1,
				source: "world",
			}),
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};
		const tool = new HubTool(session);

		const inboxResult = await tool.execute("inbox", { op: "inbox" });
		expect(inboxResult.details).toEqual(expect.objectContaining({ inbox }));
		const waitResult = await tool.execute("wait", { op: "wait", from: "foreign", timeoutMs: 1_000 });
		expect(waitResult.details).toEqual(
			expect.objectContaining({ waited: expect.objectContaining({ id: "wait-1", body: "later" }) }),
		);
	});

	it("reports a local and World identity collision without sending either path", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "queued",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: peer });
		registry.register({ id: "worker", displayName: "Local", kind: "sub", session: peer });
		let sends = 0;
		const now = Date.now();
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => ({
				peers: [
					{
						id: "worker",
						displayName: "World",
						kind: "sub",
						status: "running",
						session: peer,
						sessionFile: null,
						createdAt: now,
						lastActivity: now,
					},
				],
				errors: [],
			}),
			attachMailbox: () => {},
			send: () => {
				sends += 1;
				return Promise.reject(new Error("must not send"));
			},
			inbox: () => [],
			waitMessage: () => Promise.reject(new Error("unused")),
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};

		const result = await new HubTool(session).execute("send", { op: "send", to: "worker", message: "hello" });
		expect(result.isError).toBe(true);
		expect(sends).toBe(0);
		if (!result.details || !("rosterErrors" in result.details)) throw new Error("Expected coordination details");
		expect(result.details.rosterErrors).toEqual([
			expect.objectContaining({ code: "identity_conflict", peerId: "worker" }),
		]);
	});

	it("keeps a terminal World target refusal typed and never falls back locally", async () => {
		const peer: AgentPeer = {
			messages: [],
			deliverIrcMessage: async () => "queued",
			abort: async () => {},
			dispose: async () => {},
		};
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: peer });
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => ({ peers: [], errors: [] }),
			attachMailbox: () => {},
			send: () =>
				Promise.reject(
					new WorldOperationError(
						"world.agent.message.send",
						{
							operation: WorldRuntimeOperation.AGENT_MESSAGE_SEND,
							code: WorldOperationFailureCode.TARGET_SESSION_TERMINAL,
							detail: "the exact reply target has settled",
						},
						"send-1",
					),
				),
			inbox: () => [],
			waitMessage: () => Promise.reject(new Error("unused")),
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};

		const result = await new HubTool(session).execute("send", {
			op: "send",
			to: "main",
			message: "reply",
			replyTo: "question-1",
		});

		expect(result.isError).toBe(true);
		if (!result.details || !("worldError" in result.details)) throw new Error("Expected coordination details");
		expect(result.details.worldError).toEqual({
			kind: "operation",
			operation: "world.agent.message.send",
			code: WorldOperationFailureCode.TARGET_SESSION_TERMINAL,
			codeName: "TARGET_SESSION_TERMINAL",
			detail: "the exact reply target has settled",
		});
	});

	it("keeps a World message permission denial typed", async () => {
		const registry = new AgentRegistry();
		registry.register({ id: MAIN_AGENT_ID, displayName: "Main", kind: "main", session: null });
		const backend: CoordinationBackend = {
			kind: "world",
			spawn: () => Promise.reject(new Error("unused")),
			listPeers: async () => ({ peers: [], errors: [] }),
			attachMailbox: () => {},
			send: () =>
				Promise.reject(
					new WorldAuthorityError("world.agent.message.send", {
						operation: WorldRuntimeOperation.AGENT_MESSAGE_SEND,
						callerSessionObjectKey: "glados/test/llm-session/caller",
						capabilityDigest: "sha256:cap",
						code: WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED,
						requiredPermission: "world.agent.message.send",
						detail: "the caller manifest does not allow messaging",
					}),
				),
			inbox: () => [],
			waitMessage: () => Promise.reject(new Error("unused")),
			interrupt: () => Promise.reject(new Error("unused")),
			close: () => Promise.resolve(),
		};
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			settings: Settings.isolated({}),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => MAIN_AGENT_ID,
			agentRegistry: registry,
			coordinationBackend: backend,
		};

		const result = await new HubTool(session).execute("send", { op: "send", to: "main", message: "hello" });

		expect(result.isError).toBe(true);
		if (!result.details || !("worldError" in result.details)) throw new Error("Expected coordination details");
		expect(result.details.worldError).toEqual({
			kind: "authority",
			operation: "world.agent.message.send",
			code: WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED,
			codeName: "OPERATION_NOT_ALLOWED",
			requiredPermission: "world.agent.message.send",
			detail: "the caller manifest does not allow messaging",
		});
	});
});

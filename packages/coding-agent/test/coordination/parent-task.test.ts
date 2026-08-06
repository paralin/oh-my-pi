import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import path from "node:path";
import { ASYNC_JOB_OWNER_LIFECYCLE_ABORT } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CoordinationSpawnRequest } from "@oh-my-pi/pi-coding-agent/coordination/backend";
import { decodeExternalSubagentProfile } from "@oh-my-pi/pi-coding-agent/coordination/external-subagent-profile";
import {
	ParentCoordinationBackend,
	type ParentCoordinationClient,
} from "@oh-my-pi/pi-coding-agent/coordination/parent";
import type {
	DispatchIntentLookup,
	ParentAgentPeerResolution,
	ParentDispatchSubmit,
	ParentDispatchSubmitResult,
} from "@oh-my-pi/pi-coding-agent/parent/client";
import { type ParentClient, ParentOperationError } from "@oh-my-pi/pi-coding-agent/parent/client";
import { type IntentKeySource, intentKey } from "@oh-my-pi/pi-coding-agent/parent/intent-key";
import type {
	EffectiveSubagentPolicy,
	StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { AgentDefinition, AgentProgress } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import type {
	AgentSummary,
	AgentTreeSnapshot,
	SessionSnapshot,
	SessionSummary,
} from "../../src/parent/generated/parent-environment.pb.js";
import {
	ParentFailureCode,
	ParentSessionState,
	TaskAgentSource,
} from "../../src/parent/generated/parent-environment.pb.js";

const PARENT_SESSION = "glados/operators/test/llm-session/root";
const WORKTREE = path.join(os.homedir(), "wt", "parent-task-test");
const AGENT: AgentDefinition = {
	name: "task",
	description: "Task worker",
	systemPrompt: "Run the assignment.",
	source: "bundled",
	tools: ["read", "write"],
	spawns: ["reviewer"],
	autoloadSkills: ["improve-writing"],
};

function absent(): DispatchIntentLookup {
	return { found: false };
}

function sessionSummary(peerId: string): SessionSummary {
	return {
		sessionId: `glados/test/llm-session/${peerId}`,
		parentSessionId: PARENT_SESSION,
		agentId: `glados/test/agent/${peerId}`,
		state: ParentSessionState.ACTIVE,
	};
}

function peerResolution(peerId: string, session?: SessionSummary): ParentAgentPeerResolution {
	const agent: AgentSummary = {
		agentId: `glados/test/agent/${peerId}`,
		parentAgentId: "glados/test/agent/root",
		name: peerId,
		peerId,
		activeSessionIds: session?.sessionId ? [session.sessionId] : [],
	};
	return { found: true, agent, session, inactive: session === undefined };
}

class FakeParentClient implements ParentCoordinationClient {
	readonly canMutate = true;
	readonly connected = false;
	readonly sessionKey = PARENT_SESSION;
	readonly calls: string[] = [];
	readonly submissions: ParentDispatchSubmit[] = [];
	readonly interrupts: Array<{ requestId: string; targetSessionId: string; reason?: string }> = [];
	lookup: (key: string, signal?: AbortSignal) => Promise<DispatchIntentLookup> = async () => absent();
	resolve: (peerId: string) => Promise<ParentAgentPeerResolution> = async () => ({
		found: false,
		agent: undefined,
		session: undefined,
		inactive: false,
	});
	submit: (request: ParentDispatchSubmit) => Promise<ParentDispatchSubmitResult> = async request => {
		const peerId = request.taskAgent?.peerId ?? "missing";
		const session = sessionSummary(peerId);
		this.resolve = async candidate =>
			candidate === peerId
				? peerResolution(peerId, session)
				: { found: false, agent: undefined, session: undefined, inactive: false };
		return { requestId: "submit", intentKey: intentKey(request.identity).intentKey, session, custody: undefined };
	};
	watch: (sessionId: string, signal?: AbortSignal) => AsyncIterable<SessionSnapshot> = () =>
		(async function* () {
			yield { taskResult: { output: "done", exitCode: 0 } };
		})();
	interrupt: (request: { requestId: string; targetSessionId: string; reason?: string }) => Promise<void> =
		async () => {};

	deriveIntentKey(source: IntentKeySource): { intentKey: string; source: IntentKeySource } {
		return intentKey(source);
	}

	async lookupDispatchIntent(key: string, signal?: AbortSignal): Promise<DispatchIntentLookup> {
		this.calls.push(`lookup:${key}`);
		return await this.lookup(key, signal);
	}

	async resolveAgentPeer(peerId: string): Promise<ParentAgentPeerResolution> {
		this.calls.push(`resolve:${peerId}`);
		return await this.resolve(peerId);
	}

	async submitDispatch(request: ParentDispatchSubmit): Promise<ParentDispatchSubmitResult> {
		this.calls.push(`submit:${request.taskAgent?.peerId ?? ""}`);
		this.submissions.push(request);
		return await this.submit(request);
	}

	async *watchSession(sessionId: string, signal?: AbortSignal): AsyncGenerator<SessionSnapshot, void, void> {
		this.calls.push(`watch:${sessionId}`);
		for await (const snapshot of this.watch(sessionId, signal)) yield snapshot;
	}

	async listSessions(): Promise<SessionSummary[]> {
		return [];
	}

	async *watchAgentTree(): AsyncGenerator<AgentTreeSnapshot, void, void> {
		yield { agents: [] };
	}

	sendPeerMessage(): ReturnType<ParentClient["sendPeerMessage"]> {
		return Promise.reject(new Error("unused"));
	}

	watchPeerMailbox(): ReturnType<ParentClient["watchPeerMailbox"]> {
		return (async function* () {})();
	}

	ackPeerMessage(): ReturnType<ParentClient["ackPeerMessage"]> {
		return Promise.reject(new Error("unused"));
	}

	async interruptSession(request: { requestId: string; targetSessionId: string; reason?: string }): Promise<{
		requestId: string;
		operation: "session_interrupt";
		targetSessionId: string;
		dispatchKey: string;
		acceptedSequence: bigint;
		detail: string;
		replayed: boolean;
	}> {
		this.calls.push(`interrupt:${request.targetSessionId}`);
		this.interrupts.push(request);
		await this.interrupt(request);
		return {
			requestId: request.requestId,
			operation: "session_interrupt",
			targetSessionId: request.targetSessionId,
			dispatchKey: "interrupt/1",
			acceptedSequence: 1n,
			detail: "accepted",
			replayed: false,
		};
	}

	async close(): Promise<void> {}
}

function spawnRequest(peerId = "worker", generated = false): CoordinationSpawnRequest {
	const session: ToolSession = {
		cwd: WORKTREE,
		hasUI: false,
		settings: Settings.isolated({ "task.maxRuntimeMs": 12_000 }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		taskDepth: 1,
	};
	const request: StructuredSubagentRequest = {
		session,
		invocationKind: "task",
		assignment: "Implement durable work",
		context: "Keep the wire contract exact.",
		agent: AGENT.name,
		identity: { id: peerId, label: generated ? undefined : peerId },
		index: 3,
		parentToolCallId: "tool-call-1",
		enableIrc: true,
		maxRuntimeMs: 12_000,
	};
	const policy: EffectiveSubagentPolicy = {
		discovery: { agents: [AGENT], projectAgentsDir: null },
		agentName: AGENT.name,
		agent: AGENT,
		effectiveAgent: AGENT,
		modelOverride: "anthropic/claude-sonnet-4",
		parentActiveModelPattern: "anthropic/claude-sonnet-4",
		schema: {
			schema: undefined,
			source: "none",
			mode: "permissive",
			outputSchemaOverridesAgent: false,
		},
		planMode: false,
		isIsolated: false,
		mergeMode: "patch",
		applyChanges: true,
		enableLsp: true,
		enableIrc: true,
	};
	return {
		peerId,
		label: peerId,
		generated,
		request,
		policy,
		artifactsDir: path.join(WORKTREE, ".tmp", "artifacts"),
		temporaryArtifacts: false,
	};
}

beforeEach(() => {
	vi.spyOn(git.repo, "root").mockResolvedValue(WORKTREE);
	vi.spyOn(git.remote, "url").mockResolvedValue("git@github.com:cjs/oh-my-pi.git");
});

afterEach(() => vi.restoreAllMocks());

describe("Parent durable Task spawn", () => {
	test.each(["main", "all", "__advisor", "MAIN"])("rejects reserved peer ID %s before daemon access", async peerId => {
		const client = new FakeParentClient();
		const backend = new ParentCoordinationBackend(client);
		await expect(backend.spawn(spawnRequest(peerId))).rejects.toThrow(/reserved/);
		expect(client.calls).toEqual([]);
	});

	test.each(["worker/name", "../escape", "worker name", "naïve", "x".repeat(257)])(
		"rejects invalid peer ID %s before daemon access",
		async peerId => {
			const client = new FakeParentClient();
			const backend = new ParentCoordinationBackend(client);
			await expect(backend.spawn(spawnRequest(peerId))).rejects.toThrow(/peer ID must contain/);
			expect(client.calls).toEqual([]);
		},
	);

	test("looks up the full intent first and attaches without submitting", async () => {
		const client = new FakeParentClient();
		const session = sessionSummary("worker");
		client.lookup = async () => ({
			found: true,
			intentState: "ACTIVE",
			activeAttemptId: "attempt/1",
			attemptState: "ACTIVE",
			session,
			awaitingParent: false,
		});
		client.resolve = async peerId => peerResolution(peerId, session);
		const backend = new ParentCoordinationBackend(client);

		const handle = await backend.spawn(spawnRequest());
		expect(handle.peerId).toBe("worker");
		expect(client.calls[0]?.startsWith("lookup:di:")).toBe(true);
		expect(client.submissions).toHaveLength(0);
		expect((await handle.wait()).result.output).toBe("done");
	});

	test("submits the same identity with the frozen Task profile", async () => {
		const client = new FakeParentClient();
		const backend = new ParentCoordinationBackend(client);
		await backend.spawn(spawnRequest());

		expect(client.calls[0]?.startsWith("lookup:di:")).toBe(true);
		const submit = client.submissions[0];
		expect(submit).toBeDefined();
		const derived = intentKey(submit!.identity);
		expect(client.calls[0]).toBe(`lookup:${derived.intentKey}`);
		expect(submit!.identity.peerId).toBe("worker");
		expect(submit!.identity.workerProfileDigest).toBe(submit!.taskAgent?.workerProfileDigest);
		expect(submit!.taskAgent?.agentSource).toBe(TaskAgentSource.BUNDLED);
		expect(submit!.taskAgent?.peerId).toBe("worker");
		const profile = decodeExternalSubagentProfile(
			submit!.taskAgent?.workerProfile ?? new Uint8Array(),
			submit!.taskAgent?.workerProfileDigest ?? "",
		);
		expect(profile.peerId).toBe("worker");
		expect(profile.assignment).toBe("Implement durable work");
	});

	test("recovers a lost submit response through the precomputed intent", async () => {
		const client = new FakeParentClient();
		let accepted: DispatchIntentLookup = absent();
		client.lookup = async () => accepted;
		client.submit = async request => {
			const peerId = request.taskAgent?.peerId ?? "missing";
			const session = sessionSummary(peerId);
			accepted = {
				found: true,
				intentState: "ACTIVE",
				activeAttemptId: "attempt/1",
				attemptState: "ACTIVE",
				session,
				awaitingParent: false,
			};
			client.resolve = async candidate => peerResolution(candidate, session);
			throw new Error("connection lost after admission");
		};
		const backend = new ParentCoordinationBackend(client);

		const handle = await backend.spawn(spawnRequest());
		expect(handle.peerId).toBe("worker");
		expect(client.submissions).toHaveLength(1);
		expect(client.calls.filter(call => call.startsWith("lookup:"))).toHaveLength(2);
	});

	test("preserves the submission failure when recovery finds no attached session", async () => {
		const client = new FakeParentClient();
		let lookups = 0;
		client.lookup = async () => {
			lookups += 1;
			return lookups === 1
				? absent()
				: {
						found: true,
						intentState: "ACTIVE",
						activeAttemptId: "attempt/1",
						attemptState: "FAILED",
						session: undefined,
						awaitingParent: false,
					};
		};
		client.submit = async () => {
			throw new Error("adapter launch failed");
		};
		const backend = new ParentCoordinationBackend(client);

		await expect(backend.spawn(spawnRequest())).rejects.toThrow("adapter launch failed");
		expect(lookups).toBe(2);
	});

	test("stops lost-response recovery when the caller aborts", async () => {
		const client = new FakeParentClient();
		const abort = new AbortController();
		let lookups = 0;
		client.lookup = async (_key, signal) => {
			lookups += 1;
			if (lookups === 1) return absent();
			expect(signal).toBe(abort.signal);
			expect(signal?.aborted).toBe(true);
			throw signal?.reason;
		};
		client.submit = async () => {
			abort.abort(new Error("caller stopped"));
			throw new Error("connection lost");
		};
		const backend = new ParentCoordinationBackend(client);

		await expect(backend.spawn(spawnRequest(), abort.signal)).rejects.toThrow(/caller stopped/);
		expect(lookups).toBe(2);
	});

	test("fails an exact supplied peer conflict without submission", async () => {
		const client = new FakeParentClient();
		client.resolve = async peerId => peerResolution(peerId, sessionSummary(peerId));
		const backend = new ParentCoordinationBackend(client);

		await expect(backend.spawn(spawnRequest("claimed", false))).rejects.toThrow(/peer identity conflict: claimed/);
		expect(client.submissions).toHaveLength(0);
	});

	test("advances a generated suffix after a racing daemon conflict", async () => {
		const client = new FakeParentClient();
		let attempts = 0;
		client.submit = async request => {
			attempts += 1;
			if (attempts === 1) {
				throw new ParentOperationError(
					"dispatch_submit",
					{
						code: ParentFailureCode.PEER_IDENTITY_CONFLICT,
						detail: "racing peer reservation",
					},
					"submit-race",
				);
			}
			const peerId = request.taskAgent?.peerId ?? "missing";
			const session = sessionSummary(peerId);
			client.resolve = async candidate => peerResolution(candidate, session);
			return {
				requestId: "submit-2",
				intentKey: intentKey(request.identity).intentKey,
				session,
			};
		};
		const backend = new ParentCoordinationBackend(client);

		const handle = await backend.spawn(spawnRequest("worker", true));
		expect(handle.peerId).toBe("worker-2");
		expect(client.submissions.map(request => request.taskAgent?.peerId)).toEqual(["worker", "worker-2"]);
	});
});

describe("Parent Task session watch", () => {
	test("maps live progress and every terminal SingleResult field", async () => {
		const client = new FakeParentClient();
		client.watch = () =>
			(async function* () {
				yield {
					progress: {
						lastIntent: "Inspecting",
						tokens: 11n,
						requests: 2n,
						contextTokens: 7n,
						contextWindow: 200n,
						resolvedModel: "anthropic/model",
						durationMs: 19n,
						activeToolName: "read",
						cost: 0.25,
					},
				};
				yield {
					taskResult: {
						lastIntent: "Finished",
						exitCode: 7,
						output: "line one\nline two",
						stderr: "warning",
						truncated: true,
						structuredOutput: JSON.stringify({
							source: "caller",
							mode: "strict",
							status: "invalid",
							data: { ok: false },
							error: "schema mismatch",
						}),
						durationMs: 31n,
						tokens: 17n,
						requests: 3n,
						contextTokens: 9n,
						contextWindow: 200n,
						resolvedModel: "anthropic/fallback",
						resolvedModelIsFallback: true,
						error: "failed",
						aborted: true,
						abortReason: "cancelled",
						usage: {
							input: 1n,
							output: 2n,
							cacheRead: 3n,
							cacheWrite: 4n,
							totalTokens: 10n,
							reasoningTokens: 5n,
							cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
						},
						extractedToolData: [{ toolName: "read", values: [JSON.stringify({ path: "a" })] }],
						retryFailure: { attempt: 4, errorMessage: "rate limited" },
					},
				};
			})();
		const backend = new ParentCoordinationBackend(client);
		const handle = await backend.spawn(spawnRequest());
		const progress: AgentProgress[] = [];
		const execution = await handle.wait(undefined, update => progress.push(update));

		expect(progress).toEqual([
			expect.objectContaining({
				id: "worker",
				status: "running",
				lastIntent: "Inspecting",
				tokens: 11,
				requests: 2,
				contextTokens: 7,
				contextWindow: 200,
				resolvedModel: "anthropic/model",
				durationMs: 19,
				currentTool: "read",
				cost: 0.25,
			}),
		]);
		expect(execution.result).toEqual(
			expect.objectContaining({
				index: 3,
				id: "worker",
				agent: "task",
				agentSource: "bundled",
				assignment: "Implement durable work",
				description: "worker",
				lastIntent: "Finished",
				exitCode: 7,
				output: "line one\nline two",
				stderr: "warning",
				truncated: true,
				structuredOutput: {
					source: "caller",
					mode: "strict",
					status: "invalid",
					data: { ok: false },
					error: "schema mismatch",
				},
				durationMs: 31,
				tokens: 17,
				requests: 3,
				contextTokens: 9,
				contextWindow: 200,
				modelOverride: "anthropic/claude-sonnet-4",
				resolvedModel: "anthropic/fallback",
				resolvedModelIsFallback: true,
				error: "failed",
				aborted: true,
				abortReason: "cancelled",
				usage: {
					input: 1,
					output: 2,
					cacheRead: 3,
					cacheWrite: 4,
					totalTokens: 10,
					reasoningTokens: 5,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				},
				extractedToolData: { read: [{ path: "a" }] },
				retryFailure: { attempt: 4, errorMessage: "rate limited" },
				outputMeta: { lineCount: 2, charCount: 17 },
			}),
		);
		expect(execution.result.patchPath).toBeUndefined();
		expect(execution.result.branchName).toBeUndefined();
		expect(execution.result.branchBaseSha).toBeUndefined();
		expect(execution.result.nestedPatches).toBeUndefined();
		expect(await Bun.file(execution.result.outputPath!).text()).toBe("line one\nline two");
	});

	test("sends one stable interrupt on abort and waits for terminal settlement", async () => {
		const client = new FakeParentClient();
		const releaseTerminal = Promise.withResolvers<void>();
		const interrupted = Promise.withResolvers<void>();
		client.interrupt = async () => interrupted.resolve();
		client.watch = () =>
			(async function* () {
				await releaseTerminal.promise;
				yield {
					taskResult: {
						exitCode: 1,
						output: "",
						aborted: true,
						abortReason: "Task cancelled by its parent",
					},
				};
			})();
		const backend = new ParentCoordinationBackend(client);
		const handle = await backend.spawn(spawnRequest());
		const abort = new AbortController();
		const settled = handle.wait(abort.signal);

		abort.abort();
		await interrupted.promise;
		expect(client.interrupts).toHaveLength(1);
		let finished = false;
		settled.finally(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		releaseTerminal.resolve();
		expect((await settled).result.aborted).toBe(true);
		expect(client.interrupts).toHaveLength(1);
		expect(client.interrupts[0]?.requestId).toMatch(/^parent-task-interrupt:[0-9a-f]{32}$/);
	});

	test("detaches an owner-lifecycle watch without interrupting its durable child", async () => {
		const client = new FakeParentClient();
		client.watch = (_sessionId, signal) =>
			(async function* () {
				await new Promise<never>((_resolve, reject) => {
					const detach = () => reject(signal?.reason);
					signal?.addEventListener("abort", detach, { once: true });
					if (signal?.aborted) detach();
				});
				yield {};
			})();
		const backend = new ParentCoordinationBackend(client);
		const handle = await backend.spawn(spawnRequest());
		const abort = new AbortController();
		const settled = handle.wait(abort.signal);

		abort.abort(ASYNC_JOB_OWNER_LIFECYCLE_ABORT);

		await expect(settled).rejects.toBe(ASYNC_JOB_OWNER_LIFECYCLE_ABORT);
		expect(client.interrupts).toHaveLength(0);
	});
});

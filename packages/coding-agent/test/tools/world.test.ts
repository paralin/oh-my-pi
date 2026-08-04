import { afterEach, describe, expect, test } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { executeWorldOperation, WORLD_TOOL_NAME, WorldTool } from "@oh-my-pi/pi-coding-agent/tools/world/index";
import {
	WORLD_SESSION_ENV,
	WORLD_SOCKET_ENV,
	WorldAuthorityError,
	type WorldClient,
	type WorldDispatchSnapshot,
	WorldOperationError,
} from "@oh-my-pi/pi-coding-agent/world/index";
import {
	WorldAuthorityDenialCode,
	WorldOperationFailureCode,
	WorldRuntimeOperation,
} from "../../src/world/generated/llmsession.pb.js";

const SOCKET = "/run/glados/console.sock";
const CALLER = "glados/llm-session/caller";

interface FakeCalls {
	submits: unknown[];
	answers: unknown[];
	inputs: unknown[];
	interrupts: unknown[];
	watches: unknown[];
}

interface FakeClientOptions {
	submit?: () => unknown;
	answer?: () => unknown;
	input?: () => unknown;
	interrupt?: () => unknown;
	watch?: () => WorldDispatchSnapshot[];
	/** Thrown by whichever method is called, before it records anything. */
	throws?: Error;
}

/**
 * A client stand-in that records what the tool asked for.
 *
 * The tool's job is argument shaping, drain behavior, and rendering; the
 * client's own decoding is covered in `test/world/client.test.ts`, so this seam
 * keeps the two concerns from being tested through each other.
 */
function fakeClient(options: FakeClientOptions = {}): { client: WorldClient; calls: FakeCalls } {
	const calls: FakeCalls = { submits: [], answers: [], inputs: [], interrupts: [], watches: [] };
	const raise = () => {
		if (options.throws) throw options.throws;
	};
	const client = {
		canMutate: true,
		sessionKey: CALLER,
		deriveIntentKey: (source: unknown) => ({ intentKey: "di:derived", source }),
		submitDispatch: async (request: unknown) => {
			raise();
			calls.submits.push(request);
			return (
				options.submit?.() ?? {
					requestId: "di:derived",
					intentKey: "di:derived",
					session: undefined,
					custody: undefined,
				}
			);
		},
		answerQuestion: async (request: unknown) => {
			raise();
			calls.answers.push(request);
			return options.answer?.() ?? {};
		},
		sendSessionInput: async (request: unknown) => {
			raise();
			calls.inputs.push(request);
			return options.input?.() ?? {};
		},
		interruptSession: async (request: unknown) => {
			raise();
			calls.interrupts.push(request);
			return options.interrupt?.() ?? {};
		},
		watchDispatch: async function* (request: unknown) {
			raise();
			calls.watches.push(request);
			for (const snapshot of options.watch?.() ?? []) yield snapshot;
		},
	} as unknown as WorldClient;
	return { client, calls };
}

function session(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function setWorldEnv(socket: string | undefined, caller: string | undefined): void {
	if (socket === undefined) delete process.env[WORLD_SOCKET_ENV];
	else process.env[WORLD_SOCKET_ENV] = socket;
	if (caller === undefined) delete process.env[WORLD_SESSION_ENV];
	else process.env[WORLD_SESSION_ENV] = caller;
}

afterEach(() => {
	setWorldEnv(undefined, undefined);
});

describe("world tool admission", () => {
	test("an unconfigured root gets no tool", () => {
		setWorldEnv(undefined, undefined);
		expect(WorldTool.createIf(session())).toBeNull();
	});

	// A socket alone is a complete configuration for reads. A tool whose every
	// call would be denied for want of a caller is worse than no tool.
	test("a socket-only root gets no tool", () => {
		setWorldEnv(SOCKET, undefined);
		expect(WorldTool.createIf(session())).toBeNull();
	});

	test("a socket-plus-session root gets the tool", () => {
		setWorldEnv(SOCKET, CALLER);
		const { client } = fakeClient();
		const tool = WorldTool.createIf(session({ worldClient: () => client }));
		expect(tool).not.toBeNull();
		expect(tool?.name).toBe(WORLD_TOOL_NAME);
	});

	test("an owner-supplied client is used instead of the process-shared one", async () => {
		setWorldEnv(SOCKET, CALLER);
		const { client, calls } = fakeClient();
		const tool = WorldTool.createIf(session({ worldClient: () => client }));
		await tool?.execute("call-1", {
			op: "session_input",
			request_id: "r1",
			session: "glados/llm-session/b",
			text: "go",
		});
		expect(calls.inputs).toHaveLength(1);
	});
});

describe("world tool schema", () => {
	test("advertises one object schema with every operation", () => {
		const { client } = fakeClient();
		const schema = toolWireSchema(new WorldTool(client)) as {
			type: string;
			properties: Record<string, { enum?: string[] }>;
			required?: string[];
		};
		expect(schema.type).toBe("object");
		expect(schema.properties.op?.enum).toEqual([
			"dispatch_submit",
			"dispatch_watch",
			"question_answer",
			"session_input",
			"session_interrupt",
		]);
		expect(schema.required).toContain("op");
		expect(schema.properties).not.toHaveProperty("resume_session");
	});

	test("names each operation's permission in its description", () => {
		const { client } = fakeClient();
		const description = new WorldTool(client).description;
		for (const permission of [
			"world.dispatch.submit",
			"world.dispatch.watch",
			"world.question.answer",
			"world.session.input",
			"world.session.interrupt",
		]) {
			expect(description).toContain(permission);
		}
	});
});

describe("world tool operations", () => {
	test("dispatch_submit builds the identity tuple from flat arguments", async () => {
		const { client, calls } = fakeClient({
			submit: () => ({
				requestId: "di:derived",
				intentKey: "di:derived",
				session: { sessionObjectKey: "glados/llm-session/child", state: "running" },
				custody: { claimState: "claimed", dispatchKey: "glados/dispatch/1" },
			}),
		});
		const result = await executeWorldOperation(client, {
			op: "dispatch_submit",
			objective: "Fix the flaky auth test",
			worktree_path: "/wt/fix-auth",
			working_directory: "/wt/fix-auth/src",
			worktree_identity: "fix-auth",
			deliverable_paths: ["notes/2026/20260803.org"],
			write_surfaces: ["src/auth"],
			child_operations: ["world.question.answer"],
		});

		const submitted = calls.submits[0] as {
			identity: Record<string, unknown>;
			worktreePath: string;
			childWorldOperations: string[];
		};
		// Defaults are the daemon's own, because it re-derives the key from
		// exactly the tuple it receives.
		expect(submitted.identity.repository).toBe("github.com/aperturerobotics/glados");
		expect(submitted.identity.ownerArtifact).toBe("repos/glados");
		expect(submitted.identity.checkoutIdentity).toBe("glados");
		// The tuple carries the semantic path; the run carries the real one.
		expect(submitted.identity.workingDirectory).toBe("src");
		expect(submitted.worktreePath).toBe("/wt/fix-auth");
		expect(submitted.childWorldOperations).toEqual(["world.question.answer"]);

		expect(result.isError).toBe(false);
		expect(result.text).toContain("di:derived");
		expect(result.text).toContain("glados/llm-session/child");
	});

	test("dispatch_submit refuses an incomplete identity before calling the client", async () => {
		const { client, calls } = fakeClient();
		await expect(
			executeWorldOperation(client, {
				op: "dispatch_submit",
				objective: "Fix it",
				worktree_path: "/wt/fix",
				working_directory: "/wt/fix",
				deliverable_paths: ["notes/n.org"],
				write_surfaces: ["src"],
			}),
		).rejects.toThrow(/worktree_identity/);
		expect(calls.submits).toEqual([]);
	});

	test("dispatch_watch drains to the snapshot that met the condition", async () => {
		const { client, calls } = fakeClient({
			watch: () => [
				{
					intent: {
						found: true,
						intentState: "ADMITTED",
						activeAttemptKey: "a",
						attemptState: "RUNNING",
						session: undefined,
						custody: undefined,
						awaitingCustody: true,
					},
					completionMet: false,
				},
				{
					intent: {
						found: true,
						intentState: "ACCEPTED",
						activeAttemptKey: "a",
						attemptState: "ACCEPTED",
						session: { sessionObjectKey: "glados/llm-session/child", state: "completed" },
						custody: { claimState: "claimed", terminalAccepted: true },
						awaitingCustody: false,
					},
					completionMet: true,
				},
			],
		});
		const result = await executeWorldOperation(client, {
			op: "dispatch_watch",
			intent_key: "di:abc",
			stop: "terminal",
		});
		expect(calls.watches[0]).toEqual({ intentKey: "di:abc", stop: "terminal" });
		expect(result.text).toContain("Condition met: yes");
		expect(result.text).toContain("ACCEPTED");
		expect(result.isError).toBe(false);
	});

	test("dispatch_watch defaults to terminal and reports an unmet stream that closed", async () => {
		const { client, calls } = fakeClient({
			watch: () => [{ intent: { found: false }, completionMet: false }],
		});
		const result = await executeWorldOperation(client, { op: "dispatch_watch", intent_key: "di:abc" });
		expect(calls.watches[0]).toEqual({ intentKey: "di:abc", stop: "terminal" });
		expect(result.text).toContain("Condition met: no");
		expect(result.text).toContain("No dispatch intent is stored");
		// Reported rather than hung on: the stream ended without the condition.
		expect(result.text).toContain("closed before");
	});

	test("question_answer renders the Decision it recorded", async () => {
		const { client, calls } = fakeClient({
			answer: () => ({
				requestId: "answer-1",
				questionObjectKey: "glados/questions/q",
				decisionObjectKey: "glados/questions/q/decision/abc",
				evidenceObjectKey: "glados/evidence/e",
				goalObjectKey: "glados/goals/g",
				questionState: "answered",
				goalState: "active",
				resumeTriggerObjectKey: "",
				replayed: false,
			}),
		});
		const result = await executeWorldOperation(client, {
			op: "question_answer",
			request_id: "answer-1",
			question: "glados/questions/q",
			summary: "Session cookies.",
		});
		expect(calls.answers[0]).toEqual({
			requestId: "answer-1",
			questionObjectKey: "glados/questions/q",
			summary: "Session cookies.",
		});
		expect(result.text).toContain("glados/questions/q/decision/abc");
		expect(result.text).not.toContain("Replayed");
	});

	test("a replayed effect says so", async () => {
		const { client } = fakeClient({
			input: () => ({
				requestId: "steer-1",
				operation: "session_input",
				targetSessionObjectKey: "glados/llm-session/b",
				dispatchKey: "",
				acceptedSequence: 9n,
				detail: "",
				replayed: true,
			}),
		});
		const result = await executeWorldOperation(client, {
			op: "session_input",
			request_id: "steer-1",
			session: "glados/llm-session/b",
			text: "go",
		});
		expect(result.text).toContain("Accepted sequence: 9");
		expect(result.text).toContain("no second effect was created");
	});

	test("session_interrupt states that acceptance is a stored request", async () => {
		const { client, calls } = fakeClient({
			interrupt: () => ({
				requestId: "stop-1",
				operation: "session_interrupt",
				targetSessionObjectKey: "glados/llm-session/b",
				dispatchKey: "glados/dispatch/1",
				acceptedSequence: 3n,
				detail: "",
				replayed: false,
			}),
		});
		const result = await executeWorldOperation(client, {
			op: "session_interrupt",
			request_id: "stop-1",
			session: "glados/llm-session/b",
			reason: "superseded",
		});
		expect(calls.interrupts[0]).toEqual({
			requestId: "stop-1",
			targetSessionObjectKey: "glados/llm-session/b",
			reason: "superseded",
		});
		expect(result.text).toContain("cancellation request is stored");
	});

	test("each operation names the field it cannot proceed without", async () => {
		const { client } = fakeClient();
		await expect(executeWorldOperation(client, { op: "dispatch_watch" })).rejects.toThrow(/intent_key/);
		await expect(
			executeWorldOperation(client, { op: "question_answer", question: "q", summary: "s" }),
		).rejects.toThrow(/request_id/);
		await expect(executeWorldOperation(client, { op: "session_input", request_id: "r", text: "t" })).rejects.toThrow(
			/`session`/,
		);
		await expect(
			executeWorldOperation(client, { op: "session_input", request_id: "r", session: "glados/llm-session/b" }),
		).rejects.toThrow(/`text`/);
	});
});

describe("world tool refusals", () => {
	test("a permission denial renders the daemon's code, caller, and permission", async () => {
		const { client } = fakeClient({
			throws: new WorldAuthorityError("question_answer", {
				operation: WorldRuntimeOperation.QUESTION_ANSWER,
				callerSessionObjectKey: CALLER,
				capabilityDigest: "sha256:cap",
				code: WorldAuthorityDenialCode.OPERATION_NOT_ALLOWED,
				requiredPermission: "world.question.answer",
				detail: "the caller manifest does not allow it",
			}),
		});
		const result = await executeWorldOperation(client, {
			op: "question_answer",
			request_id: "r1",
			question: "glados/questions/q",
			summary: "yes",
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Code: OPERATION_NOT_ALLOWED");
		expect(result.text).toContain(CALLER);
		expect(result.text).toContain("world.question.answer");
		expect(result.text).toContain("sha256:cap");
		// The point of checking before reading the target, said plainly.
		expect(result.text).toContain("refused before reading the target");
		expect(result.details).toMatchObject({ op: "question_answer" });
	});

	test("a retry conflict explains that a new request id is required", async () => {
		const { client } = fakeClient({
			throws: new WorldOperationError(
				"session_interrupt",
				{
					operation: WorldRuntimeOperation.SESSION_INTERRUPT,
					code: WorldOperationFailureCode.RETRY_CONFLICT,
					targetObjectKey: "glados/llm-session/b",
					detail: "stored content differs",
				},
				"stop-1",
			),
		});
		const result = await executeWorldOperation(client, {
			op: "session_interrupt",
			request_id: "stop-1",
			session: "glados/llm-session/b",
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("Code: RETRY_CONFLICT");
		expect(result.text).toContain("needs a new request id");
	});

	// A transport failure says nothing about what the daemon decided, so it must
	// not be dressed up as a structured refusal.
	test("an ordinary failure is not turned into a structured refusal", async () => {
		const { client } = fakeClient({ throws: new Error("socket closed") });
		await expect(
			executeWorldOperation(client, { op: "session_input", request_id: "r", session: "s", text: "t" }),
		).rejects.toThrow(/socket closed/);
	});

	test("the native tool returns the rendered refusal as a tool error", async () => {
		const { client } = fakeClient({
			throws: new WorldAuthorityError("session_input", {
				operation: WorldRuntimeOperation.SESSION_INPUT,
				callerSessionObjectKey: CALLER,
				code: WorldAuthorityDenialCode.CALLER_MANIFEST_UNAVAILABLE,
				requiredPermission: "world.session.input",
				detail: "the caller has settled",
			}),
		});
		const result = await new WorldTool(client).execute("call-1", {
			op: "session_input",
			request_id: "r1",
			session: "glados/llm-session/b",
			text: "go",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect((result.content[0] as { text: string }).text).toContain("CALLER_MANIFEST_UNAVAILABLE");
	});
});

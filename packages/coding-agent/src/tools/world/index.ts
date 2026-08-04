/**
 * World tool — the five authority-checked GLaDOS World operations.
 *
 * One tool, one schema, one renderer. Native OMP constructs {@link WorldTool}
 * from the tool registry; the Claude MCP bridge constructs the same class and
 * advertises the same wire schema, so the two runtimes cannot answer the same
 * call differently — there is one operation and one rendering, reached two ways.
 *
 * Nothing here decides whether an operation is allowed. GLaDOS reads the bound
 * caller's frozen capability manifest, checks the operation's permission ID
 * before it touches the target, and answers with a structured denial. This tool
 * sends typed requests and renders what comes back, including the refusals.
 *
 * The tool exists only where both halves of the configuration are present: a
 * daemon socket and a caller session key. A socket-only root keeps its read-only
 * `spacewave://` access and is not given this tool, because a caller with no
 * identity could only ever collect denials.
 */

import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import {
	WorldAuthorityError,
	WorldClient,
	type WorldDispatchSnapshot,
	type WorldDispatchSubmitResult,
	WorldOperationError,
	type WorldQuestionAnswerResult,
	type WorldSessionControlResult,
	type WorldWatchStop,
} from "../../world/client.js";
import { isWorldRuntimeConfigured } from "../../world/config.js";
import {
	DEFAULT_DISPATCH_REPOSITORY,
	defaultCheckoutIdentity,
	defaultIntentOwnerArtifact,
	semanticWorkingDirectory,
} from "../../world/intent-key.js";
import { WORLD_CHILD_PERMISSIONS, WORLD_OPERATION_PERMISSIONS, type WorldOperation } from "../../world/operations.js";
import type { ToolSession } from "..";

/** Registry name of the World operations tool. */
export const WORLD_TOOL_NAME = "world";

const worldSchema = type({
	op: type(
		"'dispatch_submit' | 'dispatch_watch' | 'question_answer' | 'session_input' | 'session_interrupt'",
	).describe("world operation"),
	"request_id?": type("string > 0").describe(
		"retry identity, printable ASCII, <= 256 bytes; required except for dispatch_submit, which defaults to its intent key. Reusing one with the same content replays the stored effect; reusing it with different content is a conflict",
	),
	"objective?": type("string > 0").describe("dispatch_submit: Goal objective and provider prompt"),
	"done_criteria?": type("string").describe("dispatch_submit: accepted completion condition"),
	"adapter_argv?": type("string[]").describe("dispatch_submit: exact provider adapter argument vector"),
	"worktree_path?": type("string > 0").describe("dispatch_submit: absolute authorized checkout root"),
	"working_directory?": type("string > 0").describe(
		"dispatch_submit: adapter working directory; absolute paths are projected into the worktree for the identity tuple",
	),
	"max_runtime_seconds?": type("number >= 0").describe("dispatch_submit: bound on adapter process lifetime"),
	"model?": type("string").describe("dispatch_submit: model the adapter must select"),
	"owner_artifact?": type("string > 0").describe(
		"dispatch_submit: owning artifact path; defaults to the repository's conventional path",
	),
	"repository?": type("string > 0").describe(
		`dispatch_submit: repository; defaults to ${DEFAULT_DISPATCH_REPOSITORY}`,
	),
	"checkout_identity?": type("string > 0").describe(
		"dispatch_submit: checkout identity; defaults to the repository's base name",
	),
	"worktree_identity?": type("string > 0").describe(
		"dispatch_submit: portable worktree identity; the daemon derives its own and rejects a mismatch",
	),
	"deliverable_paths?": type("string[]").describe("dispatch_submit: workspace-relative deliverables; at least one"),
	"write_surfaces?": type("string[]").describe("dispatch_submit: workspace-relative write surfaces; at least one"),
	"child_operations?": type("string[]").describe(
		`dispatch_submit: world.* permissions granted to the child, a subset of the caller's own; omit to grant none. One of ${WORLD_CHILD_PERMISSIONS.join(", ")}`,
	),
	"intent_key?": type("string > 0").describe("dispatch_watch: the dispatch intent key to watch"),
	"stop?": type("'current' | 'custody' | 'terminal'").describe(
		"dispatch_watch: when the watch stops; current sends one snapshot, custody waits for executor custody, terminal waits for a settled dispatch. Default terminal",
	),
	"question?": type("string > 0").describe("question_answer: exact Question World object key"),
	"summary?": type("string > 0").describe("question_answer: the answer recorded on the Decision"),
	"session?": type("string > 0").describe("session_input / session_interrupt: target LlmSession World object key"),
	"text?": type("string > 0").describe("session_input: steering text delivered to the target's inbox"),
	"reason?": type("string").describe("session_interrupt: reason recorded on the cancellation request"),
});

type WorldParams = typeof worldSchema.infer;

/** One rendered World operation, kept structured for the UI and for tests. */
export type WorldToolDetails =
	| { op: "dispatch_submit"; result: WorldDispatchSubmitResult }
	| { op: "dispatch_watch"; intentKey: string; stop: WorldWatchStop; snapshot: WorldDispatchSnapshot | null }
	| { op: "question_answer"; result: WorldQuestionAnswerResult }
	| { op: "session_input" | "session_interrupt"; result: WorldSessionControlResult }
	| { op: WorldOperation; denial: WorldAuthorityError }
	| { op: WorldOperation; failure: WorldOperationError };

/**
 * Run one World operation and render it.
 *
 * This is the whole tool. Both runtimes call it with their own client and
 * signal, which is what makes their answers byte-identical rather than merely
 * similar.
 */
export async function executeWorldOperation(
	client: WorldClient,
	params: WorldParams,
	signal?: AbortSignal,
): Promise<{ text: string; details: WorldToolDetails; isError: boolean }> {
	const op = params.op;
	try {
		switch (op) {
			case "dispatch_submit": {
				const result = await client.submitDispatch(buildDispatchSubmit(params), signal);
				return ok(renderDispatchSubmit(result), { op, result });
			}
			case "dispatch_watch": {
				const intentKey = required(params.intent_key, "intent_key", op);
				const stop: WorldWatchStop = params.stop ?? "terminal";
				let snapshot: WorldDispatchSnapshot | null = null;
				for await (const next of client.watchDispatch({ intentKey, stop }, signal)) {
					snapshot = next;
					if (next.completionMet) break;
				}
				return ok(renderDispatchWatch(intentKey, stop, snapshot), { op, intentKey, stop, snapshot });
			}
			case "question_answer": {
				const result = await client.answerQuestion(
					{
						requestId: required(params.request_id, "request_id", op),
						questionObjectKey: required(params.question, "question", op),
						summary: required(params.summary, "summary", op),
					},
					signal,
				);
				return ok(renderQuestionAnswer(result), { op, result });
			}
			case "session_input": {
				const result = await client.sendSessionInput(
					{
						requestId: required(params.request_id, "request_id", op),
						targetSessionObjectKey: required(params.session, "session", op),
						text: required(params.text, "text", op),
					},
					signal,
				);
				return ok(renderSessionControl(result), { op, result });
			}
			case "session_interrupt": {
				const result = await client.interruptSession(
					{
						requestId: required(params.request_id, "request_id", op),
						targetSessionObjectKey: required(params.session, "session", op),
						reason: params.reason ?? "",
					},
					signal,
				);
				return ok(renderSessionControl(result), { op, result });
			}
		}
	} catch (error) {
		if (error instanceof WorldAuthorityError) {
			return { text: renderAuthorityDenial(error), details: { op: error.operation, denial: error }, isError: true };
		}
		if (error instanceof WorldOperationError) {
			return {
				text: renderOperationFailure(error),
				details: { op: error.operation, failure: error },
				isError: true,
			};
		}
		throw error;
	}
}

function ok(text: string, details: WorldToolDetails): { text: string; details: WorldToolDetails; isError: boolean } {
	return { text, details, isError: false };
}

/**
 * Read one field an operation cannot proceed without.
 *
 * The schema cannot express "required for this op" across a flat union of
 * operations, so the check lives here — once, for both runtimes.
 */
function required(value: string | undefined, field: string, op: WorldOperation): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`world ${op} requires \`${field}\`.`);
	return trimmed;
}

/**
 * Build the submission and its identity tuple from flat tool arguments.
 *
 * The daemon re-derives the intent key from exactly the tuple it receives, so
 * every default applied here is the value the daemon would have chosen. An
 * absolute working directory is projected into the worktree because the tuple
 * carries the semantic path while the run carries the real one.
 */
function buildDispatchSubmit(params: WorldParams) {
	const op: WorldOperation = "dispatch_submit";
	const objective = required(params.objective, "objective", op);
	const worktreePath = required(params.worktree_path, "worktree_path", op);
	const workingDirectory = required(params.working_directory, "working_directory", op);
	const repository = params.repository?.trim() || DEFAULT_DISPATCH_REPOSITORY;
	const deliverablePaths = params.deliverable_paths ?? [];
	const writeSurfaces = params.write_surfaces ?? [];
	if (deliverablePaths.length === 0)
		throw new Error("world dispatch_submit requires at least one `deliverable_paths`.");
	if (writeSurfaces.length === 0) throw new Error("world dispatch_submit requires at least one `write_surfaces`.");
	return {
		identity: {
			ownerArtifact: params.owner_artifact?.trim() || defaultIntentOwnerArtifact(repository),
			objective,
			repository,
			checkoutIdentity: params.checkout_identity?.trim() || defaultCheckoutIdentity(repository),
			worktreeIdentity: required(params.worktree_identity, "worktree_identity", op),
			workingDirectory: semanticWorkingDirectory(worktreePath, workingDirectory),
			deliverablePaths,
			writeSurfaces,
		},
		doneCriteria: params.done_criteria ?? "",
		adapterArgv: params.adapter_argv ?? [],
		worktreePath,
		workingDirectory,
		maxRuntimeSeconds: params.max_runtime_seconds ?? 0,
		model: params.model ?? "",
		childWorldOperations: params.child_operations ?? [],
		requestId: params.request_id?.trim() || "",
	};
}

function renderDispatchSubmit(result: WorldDispatchSubmitResult): string {
	const lines = [
		"# world dispatch_submit",
		"",
		`Intent key: \`${result.intentKey}\``,
		`Request id: \`${result.requestId}\``,
	];
	const session = result.session;
	if (session) {
		lines.push(`Session: \`${session.sessionObjectKey ?? ""}\``, `State: ${session.state ?? "unknown"}`);
		if (session.goalObjectKey) lines.push(`Goal: \`${session.goalObjectKey}\``);
	} else {
		lines.push("No session summary was returned.");
	}
	const custody = result.custody;
	if (custody) {
		lines.push(
			"",
			`Custody: ${custody.claimState ?? "unknown"}${custody.terminalAccepted ? " (terminal accepted)" : ""}`,
		);
		if (custody.dispatchKey) lines.push(`Dispatch: \`${custody.dispatchKey}\``);
	}
	lines.push(
		"",
		"The intent key is the retry identity: submitting it again resolves to this attempt rather than starting a second one.",
	);
	return `${lines.join("\n")}\n`;
}

function renderDispatchWatch(intentKey: string, stop: WorldWatchStop, snapshot: WorldDispatchSnapshot | null): string {
	const lines = [`# world dispatch_watch`, "", `Intent key: \`${intentKey}\``, `Stop condition: ${stop}`];
	if (!snapshot) {
		lines.push("", "The watch closed without a snapshot.");
		return `${lines.join("\n")}\n`;
	}
	lines.push(`Condition met: ${snapshot.completionMet ? "yes" : "no"}`, "");
	const intent = snapshot.intent;
	if (!intent.found) {
		lines.push("No dispatch intent is stored for this key.");
		if (!snapshot.completionMet) {
			lines.push("", `The stream closed before \`${stop}\` could hold, because there is nothing to wait for.`);
		}
		return `${lines.join("\n")}\n`;
	}
	lines.push(
		`Intent state: ${intent.intentState || "unknown"}`,
		`Attempt: \`${intent.activeAttemptKey}\` (${intent.attemptState || "unknown"})`,
		`Awaiting custody: ${intent.awaitingCustody ? "yes" : "no"}`,
	);
	const session = intent.session;
	if (session) {
		lines.push(`Session: \`${session.sessionObjectKey ?? ""}\` (${session.state ?? "unknown"})`);
		if (session.failure) lines.push(`Failure: ${session.failure}`);
		if (session.blocker) lines.push(`Blocker: ${session.blocker}`);
	}
	const custody = intent.custody;
	if (custody) {
		lines.push(
			`Custody: ${custody.claimState ?? "unknown"}${custody.terminalAccepted ? " (terminal accepted)" : ""}`,
		);
		if (custody.terminalOutcome) lines.push(`Outcome: ${custody.terminalOutcome}`);
	}
	return `${lines.join("\n")}\n`;
}

function renderQuestionAnswer(result: WorldQuestionAnswerResult): string {
	const lines = [
		"# world question_answer",
		"",
		`Question: \`${result.questionObjectKey}\` (${result.questionState || "unknown"})`,
		`Decision: \`${result.decisionObjectKey}\``,
		`Evidence: \`${result.evidenceObjectKey}\``,
		`Goal: \`${result.goalObjectKey}\` (${result.goalState || "unknown"})`,
		`Request id: \`${result.requestId}\``,
	];
	if (result.resumeTriggerObjectKey) lines.push(`Resume trigger: \`${result.resumeTriggerObjectKey}\``);
	if (result.replayed) {
		lines.push("", "Replayed: this request id was already answered, so the stored Decision was returned unchanged.");
	}
	return `${lines.join("\n")}\n`;
}

function renderSessionControl(result: WorldSessionControlResult): string {
	const lines = [
		`# world ${result.operation}`,
		"",
		`Target session: \`${result.targetSessionObjectKey}\``,
		`Accepted sequence: ${result.acceptedSequence}`,
		`Request id: \`${result.requestId}\``,
	];
	if (result.dispatchKey) lines.push(`Dispatch: \`${result.dispatchKey}\``);
	if (result.detail) lines.push(`Detail: ${result.detail}`);
	if (result.replayed) {
		lines.push("", "Replayed: this request id was already accepted, so no second effect was created.");
	}
	if (result.operation === "session_interrupt") {
		lines.push(
			"",
			"Acceptance means the cancellation request is stored. Terminal acceptance and process release follow on the daemon's schedule; watch the dispatch to observe them.",
		);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * Render one permission refusal.
 *
 * The daemon's own code, the caller it charged, the digest of the manifest it
 * read, and the permission the operation needed are all reported: a denial that
 * only said "not allowed" would leave the agent guessing which of the five
 * permissions its manifest is missing.
 */
export function renderAuthorityDenial(error: WorldAuthorityError): string {
	const lines = [
		`# world ${error.operation} denied`,
		"",
		`Code: ${error.codeName}`,
		`Caller: \`${error.callerSessionObjectKey}\``,
	];
	if (error.requiredPermission) lines.push(`Required permission: \`${error.requiredPermission}\``);
	else lines.push(`Required permission: \`${WORLD_OPERATION_PERMISSIONS[error.operation]}\``);
	if (error.capabilityDigest) lines.push(`Capability digest: \`${error.capabilityDigest}\``);
	if (error.detail) lines.push("", error.detail);
	lines.push(
		"",
		"GLaDOS refused before reading the target, so no World object, custody sequence, inbox entry, or executor was touched.",
	);
	return `${lines.join("\n")}\n`;
}

/** Render one permitted operation that GLaDOS refused or could not complete. */
export function renderOperationFailure(error: WorldOperationError): string {
	const lines = [`# world ${error.operation} failed`, "", `Code: ${error.codeName}`];
	if (error.requestId) lines.push(`Request id: \`${error.requestId}\``);
	if (error.targetObjectKey) lines.push(`Target: \`${error.targetObjectKey}\``);
	if (error.detail) lines.push("", error.detail);
	if (error.codeName === "RETRY_CONFLICT") {
		lines.push(
			"",
			"This request id already stored a different effect. Reusing it cannot replace that effect; a genuinely new operation needs a new request id.",
		);
	}
	// The two absence-shaped codes mean opposite things for what to do next, so
	// they are never rendered as one "it did not work".
	if (error.codeName === "MISSING_TARGET") {
		lines.push("", "The named object does not exist. A retry cannot make it appear.");
	}
	if (error.codeName === "UNAVAILABLE") {
		lines.push("", "The target exists but has no live lane right now. It may be between attempts.");
	}
	if (error.codeName === "REJECTED") {
		lines.push(
			"",
			"This request id is spent: retrying it resolves to this same stored failure, so a genuine retry needs a new one.",
		);
	}
	return `${lines.join("\n")}\n`;
}

/**
 * The World client native tool calls share for one process.
 *
 * One client per process means one caller identity and one connection for every
 * native World operation, which is the same discipline the `spacewave://` router
 * applies to reads. The process deliberately keeps this client open until exit.
 * An owner that already holds a client supplies it through
 * `ToolSession.worldClient` instead, so its operations ride the client its own
 * lifetime closes; the Claude task bridge does that by constructing this tool
 * with its peer's client directly.
 */
let sharedClient: WorldClient | undefined | null = null;

function sharedWorldClient(): WorldClient | undefined {
	if (sharedClient === null) sharedClient = WorldClient.create();
	return sharedClient;
}

export class WorldTool implements AgentTool<typeof worldSchema, WorldToolDetails> {
	readonly name = WORLD_TOOL_NAME;
	readonly approval = "exec" as const;
	readonly label = "World";
	readonly summary = "Submit and watch GLaDOS dispatches, answer Questions, and steer or interrupt sessions";
	readonly description = [
		"Perform one authority-checked GLaDOS World operation.",
		"",
		"Every call is charged to this root's caller LlmSession. GLaDOS reads that session's frozen",
		"capability manifest and checks the operation's permission before it reads the target, so a",
		"refusal leaves the World, custody, inbox, and executor untouched.",
		"",
		"Operations and the permission each requires:",
		...Object.entries(WORLD_OPERATION_PERMISSIONS).map(([operation, permission]) => `- ${operation} — ${permission}`),
		"",
		"Retries are explicit. `request_id` names the retry; repeating it with the same content returns",
		"the stored effect instead of making a second one, and repeating it with different content is a",
		"conflict rather than a silent overwrite. `dispatch_submit` retries on its intent key.",
	].join("\n");
	readonly parameters = worldSchema;
	readonly strict = true;
	readonly loadMode = "essential";
	readonly interruptible = (params: Partial<WorldParams>): boolean => params.op === "dispatch_watch";

	readonly examples: readonly ToolExample<typeof worldSchema.infer>[] = [
		{
			caption: "Submit a child dispatch that may itself answer Questions",
			call: {
				op: "dispatch_submit",
				objective: "Fix the flaky auth test",
				worktree_path: "/Users/me/wt/fix-auth",
				working_directory: "/Users/me/wt/fix-auth",
				worktree_identity: "fix-auth",
				deliverable_paths: ["notes/2026/20260803.org"],
				write_surfaces: ["src/auth"],
				child_operations: ["world.question.answer"],
			},
		},
		{
			caption: "Wait for a dispatch to settle",
			call: { op: "dispatch_watch", intent_key: "di:abc123", stop: "terminal" },
		},
		{
			caption: "Read current dispatch state without waiting",
			call: { op: "dispatch_watch", intent_key: "di:abc123", stop: "current" },
		},
		{
			caption: "Answer one Question",
			call: {
				op: "question_answer",
				request_id: "answer-auth-scope-1",
				question: "glados/questions/auth-scope",
				summary: "Session cookies; JWT stays for service-to-service only.",
			},
		},
		{
			caption: "Steer a running session",
			call: {
				op: "session_input",
				request_id: "steer-1",
				session: "glados/llm-session/abc",
				text: "Skip the migration; land the read path first.",
			},
		},
		{
			caption: "Interrupt a session",
			call: {
				op: "session_interrupt",
				request_id: "stop-1",
				session: "glados/llm-session/abc",
				reason: "Superseded by a newer dispatch",
			},
		},
	];

	readonly #client: WorldClient;

	constructor(client: WorldClient) {
		this.#client = client;
	}

	/**
	 * Build the tool where this root can actually perform operations.
	 *
	 * Both halves of the configuration are required. A socket-only root gets no
	 * tool rather than a tool whose every call would be refused for want of a
	 * caller, which is the difference between an unconfigured root and a broken
	 * one.
	 */
	static createIf(session: ToolSession): WorldTool | null {
		if (!isWorldRuntimeConfigured()) return null;
		const client = session.worldClient?.() ?? sharedWorldClient();
		if (!client?.canMutate) return null;
		return new WorldTool(client);
	}

	async execute(
		_toolCallId: string,
		params: WorldParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<WorldToolDetails>> {
		const rendered = await executeWorldOperation(this.#client, params, signal);
		return {
			content: [{ type: "text", text: rendered.text }],
			details: rendered.details,
			isError: rendered.isError,
		};
	}
}

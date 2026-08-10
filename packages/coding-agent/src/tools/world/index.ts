/**
 * World operation schema, description, rendering, and execution.
 *
 * The operation executor is neutral and shared with the typed `omp.world`
 * service. This module keeps only the schema and rendering needed by the
 * Claude Code MCP adapter; no provider-facing AgentTool is constructed here.
 */

import { type } from "@oh-my-pi/omptype";
import {
	WorldAuthorityError,
	type WorldDispatchSnapshot,
	type WorldDispatchSubmitResult,
	WorldOperationError,
	type WorldQuestionAnswerResult,
	type WorldSessionControlResult,
	type WorldWatchStop,
} from "../../world/client.js";
import { DEFAULT_DISPATCH_REPOSITORY } from "../../world/intent-key.js";
import {
	executeWorldOperation as executeNeutralWorldOperation,
	type WorldOperationOwner,
	type WorldOperationParams,
} from "../../world/operation-executor.js";
import { WORLD_CHILD_PERMISSIONS, WORLD_OPERATION_PERMISSIONS, type WorldOperation } from "../../world/operations.js";

/** Registry name of the World operations tool. */
export const WORLD_TOOL_NAME = "world";

export const WORLD_TOOL_SCHEMA = type({
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

/** Description advertised by the deliberate Claude Code MCP bridge. */
export const WORLD_TOOL_DESCRIPTION = [
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

type WorldParams = typeof WORLD_TOOL_SCHEMA.infer;

/** One rendered World operation, kept structured for the UI and for tests. */
export type WorldOperationDetails =
	| { op: "dispatch_submit"; result: WorldDispatchSubmitResult }
	| { op: "dispatch_watch"; intentKey: string; stop: WorldWatchStop; snapshot: WorldDispatchSnapshot | null }
	| { op: "question_answer"; result: WorldQuestionAnswerResult }
	| { op: "session_input" | "session_interrupt"; result: WorldSessionControlResult }
	| { op: WorldOperation; denial: WorldAuthorityError }
	| { op: WorldOperation; failure: WorldOperationError };

/** Run the neutral owner executor and preserve the established rendered result. */
export async function executeWorldOperation(
	client: WorldOperationOwner,
	params: WorldParams,
	signal?: AbortSignal,
): Promise<{ text: string; details: WorldOperationDetails; isError: boolean }> {
	try {
		const result = await executeNeutralWorldOperation(client, params as WorldOperationParams, signal);
		switch (result.op) {
			case "dispatch_submit":
				return ok(renderDispatchSubmit(result.result), result);
			case "dispatch_watch":
				return ok(renderDispatchWatch(result.intentKey, result.stop, result.snapshot), result);
			case "question_answer":
				return ok(renderQuestionAnswer(result.result), result);
			case "session_input":
			case "session_interrupt":
				return ok(renderSessionControl(result.result), result);
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

function ok(
	text: string,
	details: WorldOperationDetails,
): { text: string; details: WorldOperationDetails; isError: boolean } {
	return { text, details, isError: false };
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
function renderAuthorityDenial(error: WorldAuthorityError): string {
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
function renderOperationFailure(error: WorldOperationError): string {
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

import type {
	WorldClient,
	WorldDispatchSnapshot,
	WorldDispatchSubmitResult,
	WorldQuestionAnswerResult,
	WorldSessionControlResult,
	WorldWatchStop,
} from "./client.js";
import {
	DEFAULT_DISPATCH_REPOSITORY,
	defaultCheckoutIdentity,
	defaultIntentOwnerArtifact,
	semanticWorkingDirectory,
} from "./intent-key.js";

export type WorldNativeOperation =
	| "dispatch_submit"
	| "dispatch_watch"
	| "question_answer"
	| "session_input"
	| "session_interrupt";
export type WorldOperationOwner = Pick<
	WorldClient,
	"submitDispatch" | "watchDispatch" | "answerQuestion" | "sendSessionInput" | "interruptSession"
>;

/** Flat arguments accepted by the native and legacy World surfaces. */
export interface WorldOperationParams {
	op: WorldNativeOperation;
	request_id?: string;
	objective?: string;
	done_criteria?: string;
	adapter_argv?: string[];
	worktree_path?: string;
	working_directory?: string;
	max_runtime_seconds?: number;
	model?: string;
	owner_artifact?: string;
	repository?: string;
	checkout_identity?: string;
	worktree_identity?: string;
	deliverable_paths?: string[];
	write_surfaces?: string[];
	child_operations?: string[];
	intent_key?: string;
	stop?: WorldWatchStop;
	question?: string;
	summary?: string;
	session?: string;
	text?: string;
	reason?: string;
}

export type WorldOperationSuccess =
	| { op: "dispatch_submit"; result: WorldDispatchSubmitResult }
	| { op: "dispatch_watch"; intentKey: string; stop: WorldWatchStop; snapshot: WorldDispatchSnapshot | null }
	| { op: "question_answer"; result: WorldQuestionAnswerResult }
	| { op: "session_input" | "session_interrupt"; result: WorldSessionControlResult };

/** Read one operation-specific required string. */
function required(value: string | undefined, field: string, op: WorldNativeOperation): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new Error(`world ${op} requires \`${field}\`.`);
	return trimmed;
}

/** Build the canonical dispatch identity and run fields from flat arguments. */
function buildDispatchSubmit(params: WorldOperationParams) {
	const op: WorldNativeOperation = "dispatch_submit";
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

/** Execute one authority-checked operation through the existing WorldClient. */
export async function executeWorldOperation(
	client: WorldOperationOwner,
	params: WorldOperationParams,
	signal?: AbortSignal,
): Promise<WorldOperationSuccess> {
	switch (params.op) {
		case "dispatch_submit":
			return { op: params.op, result: await client.submitDispatch(buildDispatchSubmit(params), signal) };
		case "dispatch_watch": {
			const intentKey = required(params.intent_key, "intent_key", params.op);
			const stop = params.stop ?? "terminal";
			let snapshot: WorldDispatchSnapshot | null = null;
			for await (const next of client.watchDispatch({ intentKey, stop }, signal)) {
				snapshot = next;
				if (next.completionMet) break;
			}
			return { op: params.op, intentKey, stop, snapshot };
		}
		case "question_answer":
			return {
				op: params.op,
				result: await client.answerQuestion(
					{
						requestId: required(params.request_id, "request_id", params.op),
						questionObjectKey: required(params.question, "question", params.op),
						summary: required(params.summary, "summary", params.op),
					},
					signal,
				),
			};
		case "session_input":
			return {
				op: params.op,
				result: await client.sendSessionInput(
					{
						requestId: required(params.request_id, "request_id", params.op),
						targetSessionObjectKey: required(params.session, "session", params.op),
						text: required(params.text, "text", params.op),
					},
					signal,
				),
			};
		case "session_interrupt":
			return {
				op: params.op,
				result: await client.interruptSession(
					{
						requestId: required(params.request_id, "request_id", params.op),
						targetSessionObjectKey: required(params.session, "session", params.op),
						reason: params.reason ?? "",
					},
					signal,
				),
			};
		default: {
			const unreachable: never = params.op;
			throw new Error(`unsupported world operation: ${unreachable}`);
		}
	}
}

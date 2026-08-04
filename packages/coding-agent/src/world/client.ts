import { isAbortError as isStarpcAbortError } from "starpc";
import {
	resolveWorldSessionKey,
	resolveWorldSocketPath,
	WORLD_OBJECT_KEY_SEGMENT,
	WORLD_SESSION_ENV,
	type WorldSources,
} from "./config.js";
import type {
	AccessWorldRuntimeResponse,
	AgentTreeSnapshot,
	CustodySummary,
	LookupDispatchIntentResponse,
	ReadWorldURIResponse,
	SessionSummary,
	WorldRuntimeAuthorityDenial,
	WorldRuntimeMutationRequest,
	WorldRuntimeMutationResponse,
	WorldRuntimeOperationFailure,
	WorldRuntimeWatchRequest,
	WorldRuntimeWatchResponse,
} from "./generated/llmsession.pb.js";
import {
	WorldAuthorityDenialCode,
	WorldOperationFailureCode,
	WorldRuntimeOperation,
	WorldWatchCompletion,
} from "./generated/llmsession.pb.js";
import { GladosResourceServiceClient, WorldRuntimeResourceServiceClient } from "./generated/llmsession_srpc.pb.js";
import type { ProjectionSnapshot } from "./generated/projection.pb.js";
import { type IntentKeySource, intentKey } from "./intent-key.js";
import { WORLD_CHILD_PERMISSIONS, type WorldOperation } from "./operations.js";
import { abortError, callWithAbort, type DialFn, WorldTransport } from "./transport.js";

export {
	WORLD_CHILD_PERMISSIONS,
	WORLD_OPERATION_PERMISSIONS,
	WORLD_OPERATIONS,
	type WorldOperation,
} from "./operations.js";

/** Largest session page one `listSessions` call will ask the daemon for. */
export const MAX_SESSION_PAGE = 500;

/**
 * Default bound on one dispatch-intent lookup.
 *
 * The daemon deliberately holds `LookupDispatchIntent` open while an admitted
 * attempt is still binding, which is what removes client-side polling. The
 * flip side is that an attempt which never binds would block an unbounded
 * caller forever, so the client brings its own deadline. `listSessions` needs
 * none: the daemon answers it from a fixed read and never waits.
 */
export const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

/** The generated GLaDOS surface this client depends on. */
export interface WorldService {
	ListSessions(req: { limit: number }, signal?: AbortSignal): Promise<{ sessions?: SessionSummary[] }>;
	LookupDispatchIntent(
		req: { intentKey: string; waitForCustody: boolean },
		signal?: AbortSignal,
	): Promise<LookupDispatchIntentResponse>;
	ReadWorldURI(req: { uri: string; limit: number }, signal?: AbortSignal): Promise<ReadWorldURIResponse>;
	AccessWorldRuntime(
		req: { callerSessionObjectKey: string },
		signal?: AbortSignal,
	): Promise<AccessWorldRuntimeResponse>;
}

/**
 * The generated authority-checked surface, served by a child resource.
 *
 * Every method on it is charged to the one caller session named when the child
 * was opened, so it is deliberately reachable only through {@link
 * WorldEndpoint.accessRuntime} and never constructed from the root resource.
 */
export interface WorldRuntimeService {
	Mutate(req: WorldRuntimeMutationRequest, signal?: AbortSignal): Promise<WorldRuntimeMutationResponse>;
	WatchDispatch(req: WorldRuntimeWatchRequest, signal?: AbortSignal): AsyncIterable<WorldRuntimeWatchResponse>;
}

/** One child runtime resource, held for as long as its endpoint lives. */
export interface WorldRuntimeBinding {
	readonly service: WorldRuntimeService;
	/** Tell the daemon it may drop the child handle. Idempotent. */
	release(): Promise<void>;
}

/** Largest page one bounded World read will ask the daemon for. */
export const MAX_WORLD_READ_PAGE = 500;

/** One resolved World read, carrying exactly the arm the daemon returned. */
export type WorldRead =
	| { found: false; objectKey: string }
	| { found: true; objectKey: string; kind: "snapshot"; snapshot: ProjectionSnapshot }
	| { found: true; objectKey: string; kind: "agentTree"; agentTree: AgentTreeSnapshot }
	| { found: true; objectKey: string; kind: "listing"; keys: string[]; truncated: boolean };

/**
 * One live session with a World daemon.
 *
 * Endpoints are single-use: `usable` goes false once the session fails or
 * closes and never returns true, which is what makes the client build a fresh
 * one after a daemon restart instead of replaying a dead client handle. A
 * cancelled call does not retire the endpoint — starpc scopes that
 * cancellation to the one call.
 */
export interface WorldEndpoint {
	readonly service: WorldService;
	readonly usable: boolean;
	/** Run one call, cancelled by `signal` without disturbing the session. */
	call<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T>;
	/**
	 * Bind the authority-checked runtime service to a child resource id.
	 *
	 * The id comes from `AccessWorldRuntime` on this same endpoint. Binding is
	 * local: it opens no stream until a call is made, and the child is released
	 * when the endpoint closes.
	 */
	accessRuntime(resourceId: number): WorldRuntimeBinding;
	close(): Promise<void>;
}

export interface WorldClientOptions extends WorldSources {
	/** Socket dial seam. Substituted in tests; never reached when unconfigured. */
	dial?: DialFn;
	/**
	 * Endpoint seam. Replaces the whole connect-and-bind path, so a test can
	 * drive the generated service surface without a live daemon. The signal it
	 * receives is the client's own lifetime signal, which aborts on `close`.
	 */
	openEndpoint?: (socketPath: string, signal: AbortSignal) => Promise<WorldEndpoint>;
}

/** One resolved dispatch intent, or a typed absence. */
export type DispatchIntentLookup =
	| { found: false }
	| {
			found: true;
			intentState: string;
			activeAttemptKey: string;
			attemptState: string;
			session: SessionSummary | undefined;
			custody: LookupDispatchIntentResponse["custody"];
			awaitingCustody: boolean;
	  };

const OPERATION_BY_WIRE: Readonly<Record<WorldRuntimeOperation, WorldOperation | undefined>> = {
	[WorldRuntimeOperation.UNKNOWN]: undefined,
	[WorldRuntimeOperation.DISPATCH_SUBMIT]: "dispatch_submit",
	[WorldRuntimeOperation.DISPATCH_WATCH]: "dispatch_watch",
	[WorldRuntimeOperation.QUESTION_ANSWER]: "question_answer",
	[WorldRuntimeOperation.SESSION_INPUT]: "session_input",
	[WorldRuntimeOperation.SESSION_INTERRUPT]: "session_interrupt",
};

/** The tool-facing name for an operation the daemon reported, if it named one. */
function operationFromWire(wire: WorldRuntimeOperation | undefined, fallback: WorldOperation): WorldOperation {
	return (wire === undefined ? undefined : OPERATION_BY_WIRE[wire]) ?? fallback;
}

/**
 * A permission check GLaDOS refused before it read the target.
 *
 * This is not a transport failure and not an operation that went wrong: the
 * daemon decided the bound caller may not perform this operation and stopped,
 * leaving the target World objects, custody sequences, inbox, and executor
 * untouched. The protobuf fields are kept whole rather than flattened into a
 * message so native OMP and the Claude bridge render the same values.
 */
export class WorldAuthorityError extends Error {
	readonly operation: WorldOperation;
	readonly code: WorldAuthorityDenialCode;
	/** Stable enum name, e.g. `OPERATION_NOT_ALLOWED`. */
	readonly codeName: string;
	readonly callerSessionObjectKey: string;
	/** Manifest capability digest, empty when the manifest was unreadable. */
	readonly capabilityDigest: string;
	/** The permission ID this operation required, as GLaDOS named it. */
	readonly requiredPermission: string;
	readonly detail: string;

	constructor(operation: WorldOperation, denial: WorldRuntimeAuthorityDenial) {
		const codeName = WorldAuthorityDenialCode[denial.code ?? WorldAuthorityDenialCode.UNKNOWN] ?? "UNKNOWN";
		const resolved = operationFromWire(denial.operation, operation);
		super(`world ${resolved} denied: ${codeName}${denial.detail ? ` — ${denial.detail}` : ""}`);
		this.name = "WorldAuthorityError";
		this.operation = resolved;
		this.code = denial.code ?? WorldAuthorityDenialCode.UNKNOWN;
		this.codeName = codeName;
		this.callerSessionObjectKey = denial.callerSessionObjectKey ?? "";
		this.capabilityDigest = denial.capabilityDigest ?? "";
		this.requiredPermission = denial.requiredPermission ?? "";
		this.detail = denial.detail ?? "";
	}
}

/**
 * A permitted operation that GLaDOS refused or could not complete.
 *
 * Validation, a missing target, a retry whose stored result disagrees with the
 * new request, an unavailable executor, and a rejection by the existing
 * component all arrive here with their own code. Transport and RPC failures stay
 * ordinary errors: they say nothing about what the daemon decided.
 */
export class WorldOperationError extends Error {
	readonly operation: WorldOperation;
	readonly code: WorldOperationFailureCode;
	/** Stable enum name, e.g. `RETRY_CONFLICT`. */
	readonly codeName: string;
	readonly targetObjectKey: string;
	readonly detail: string;
	readonly requestId: string;

	constructor(operation: WorldOperation, failure: WorldRuntimeOperationFailure, requestId: string) {
		const codeName = WorldOperationFailureCode[failure.code ?? WorldOperationFailureCode.UNKNOWN] ?? "UNKNOWN";
		const resolved = operationFromWire(failure.operation, operation);
		super(`world ${resolved} failed: ${codeName}${failure.detail ? ` — ${failure.detail}` : ""}`);
		this.name = "WorldOperationError";
		this.operation = resolved;
		this.code = failure.code ?? WorldOperationFailureCode.UNKNOWN;
		this.codeName = codeName;
		this.targetObjectKey = failure.targetObjectKey ?? "";
		this.detail = failure.detail ?? "";
		this.requestId = requestId;
	}
}

/** One dispatch submission: the identity tuple plus the run it describes. */
export interface WorldDispatchSubmit {
	/**
	 * The semantic identity tuple. Its derived key is the retry key, so a repeat
	 * submission of the same identity resolves to the accepted attempt instead of
	 * starting a second one.
	 */
	identity: IntentKeySource;
	/** Accepted completion condition. */
	doneCriteria?: string;
	/** Exact argument vector for the provider adapter. */
	adapterArgv?: string[];
	/** Authorized checkout root, as an absolute path on the daemon's host. */
	worktreePath?: string;
	/** Adapter process working directory, absolute. */
	workingDirectory?: string;
	maxRuntimeSeconds?: number;
	model?: string;
	/**
	 * `world.*` permission IDs the child receives. GLaDOS keeps `read`, `test`,
	 * and `write` regardless, accepts only the five IDs in
	 * {@link WORLD_CHILD_PERMISSIONS}, and rejects any the caller itself lacks.
	 * An empty or absent list grants the child no `world.*` permission.
	 */
	childWorldOperations?: string[];
	/**
	 * Mutation envelope retry key. Defaults to the derived intent key, which is
	 * already the identity of this submission.
	 */
	requestId?: string;
}

export interface WorldDispatchSubmitResult {
	requestId: string;
	/** The key computed before the call, so a lost response stays recoverable. */
	intentKey: string;
	session: SessionSummary | undefined;
	custody: CustodySummary | undefined;
}

export interface WorldQuestionAnswer {
	requestId: string;
	questionObjectKey: string;
	summary: string;
}

export interface WorldQuestionAnswerResult {
	requestId: string;
	questionObjectKey: string;
	decisionObjectKey: string;
	evidenceObjectKey: string;
	goalObjectKey: string;
	questionState: string;
	goalState: string;
	resumeTriggerObjectKey: string;
	/** The stored answer for this request was returned; nothing was written. */
	replayed: boolean;
}

export interface WorldSessionInput {
	requestId: string;
	targetSessionObjectKey: string;
	text: string;
}

export interface WorldSessionInterrupt {
	requestId: string;
	targetSessionObjectKey: string;
	reason?: string;
}

export interface WorldSessionControlResult {
	requestId: string;
	operation: WorldOperation;
	targetSessionObjectKey: string;
	dispatchKey: string;
	acceptedSequence: bigint;
	detail: string;
	/** The stored effect for this request was returned; no second one was made. */
	replayed: boolean;
}

/**
 * When a dispatch watch stops.
 *
 * - `current` sends one snapshot and closes. A missing intent is current state,
 *   so it answers `found: false` with `completionMet: true`.
 * - `custody` stops once the intent is found, has an active attempt key, carries
 *   custody, and is no longer awaiting custody.
 * - `terminal` stops once the intent is found and any terminal field is set:
 *   terminal custody acceptance, an `ACCEPTED`/`FAILED`/`ABANDONED` attempt, or
 *   an `ACCEPTED`/`FAILED`/`BLOCKED` intent.
 *
 * For `custody` and `terminal` a missing intent sends one `found: false`
 * snapshot with `completionMet: false` and then closes, so a consumer must
 * handle a stream that ends without the condition ever holding.
 */
export type WorldWatchStop = "current" | "custody" | "terminal";

export interface WorldDispatchWatch {
	intentKey: string;
	stop: WorldWatchStop;
}

/** One complete watch snapshot, in the same shape a direct lookup returns. */
export interface WorldDispatchSnapshot {
	intent: DispatchIntentLookup;
	completionMet: boolean;
}

const WATCH_COMPLETION: Readonly<Record<WorldWatchStop, WorldWatchCompletion>> = {
	current: WorldWatchCompletion.CURRENT,
	custody: WorldWatchCompletion.CUSTODY,
	terminal: WorldWatchCompletion.TERMINAL,
};

/**
 * Largest request id GLaDOS accepts, in bytes.
 *
 * The daemon re-checks this and is the authority. Checking here keeps an
 * obviously invalid id from costing a connection, and keeps the tool from
 * sending an empty string that every operation would refuse.
 */
export const MAX_WORLD_REQUEST_ID_BYTES = 256;

/** Reject a request id GLaDOS would refuse, before anything is dialed. */
export function assertWorldRequestId(requestId: string): string {
	if (!requestId) throw new Error("world request id is required");
	const bytes = Buffer.byteLength(requestId, "utf-8");
	if (bytes > MAX_WORLD_REQUEST_ID_BYTES) {
		throw new Error(`world request id must be at most ${MAX_WORLD_REQUEST_ID_BYTES} bytes, got ${bytes}`);
	}
	// The daemon's own range, byte for byte: 0x20 through 0x7e. Any code point
	// above that encodes to bytes it would reject, so checking code points here
	// accepts exactly the same set.
	for (const ch of requestId) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x20 || code > 0x7e) {
			throw new Error(`world request id must be printable ASCII: ${requestId}`);
		}
	}
	return requestId;
}

/**
 * The configured GLaDOS World client.
 *
 * The client is inert unless a socket path is configured: {@link create}
 * returns `undefined` and nothing is dialed. That is the normal runtime state,
 * so construction must not be what decides whether omp talks to a daemon.
 *
 * One endpoint — the ResourceClient session and its root resource handle — is
 * established lazily and reused over a single Yamux-muxed socket, with each
 * call carried on its own muxed stream. A failed or closed endpoint is
 * discarded rather than revived, so the operation after a daemon restart builds
 * a fresh one instead of replaying a handle the daemon forgot.
 */
export class WorldClient {
	readonly socketPath: string;
	/**
	 * The caller this client's authority-checked operations are charged to.
	 *
	 * `undefined` is a complete configuration, not a broken one: that root reads
	 * the World and performs no operation. Nothing here proves the process owns
	 * the session — the local socket is the trust boundary, and this key selects
	 * whose frozen manifest GLaDOS answers from.
	 */
	readonly sessionKey: string | undefined;
	readonly #openEndpoint: (socketPath: string, signal: AbortSignal) => Promise<WorldEndpoint>;
	/**
	 * Cancels work this client started on its own behalf. Connecting is shared
	 * between concurrent callers, so no single caller's signal may cancel it;
	 * `close` is what stops it, and this is the signal that carries that.
	 */
	readonly #lifetime = new AbortController();
	#endpoint: WorldEndpoint | null = null;
	#connecting: Promise<WorldEndpoint> | null = null;
	/** The runtime child bound to {@link #endpoint}, rebound after a reconnect. */
	#runtime: { endpoint: WorldEndpoint; binding: WorldRuntimeBinding } | null = null;
	#binding: { endpoint: WorldEndpoint; pending: Promise<WorldRuntimeBinding> } | null = null;
	#closed = false;

	private constructor(socketPath: string, sessionKey: string | undefined, options: WorldClientOptions) {
		this.socketPath = socketPath;
		this.sessionKey = sessionKey;
		const dial = options.dial;
		this.#openEndpoint = options.openEndpoint ?? ((path, signal) => openResourceEndpoint(path, dial, signal));
	}

	/**
	 * Construct a client when a World socket is configured, else `undefined`.
	 *
	 * Nothing is dialed here. The unconfigured path must not construct a
	 * transport or touch the dial seam at all.
	 *
	 * A caller session key is resolved at the same moment for the same reason the
	 * socket is: the root picks its World once, so a mid-run change to the
	 * environment cannot move some operations to a different caller. A malformed
	 * optional caller disables mutations while preserving the socket's read
	 * surface; callers that require strict validation use
	 * {@link resolveWorldSessionKey} directly.
	 */
	static create(options: WorldClientOptions = {}): WorldClient | undefined {
		const socketPath = resolveWorldSocketPath(options);
		if (!socketPath) return undefined;
		let sessionKey: string | undefined;
		try {
			sessionKey = resolveWorldSessionKey(options);
		} catch {
			sessionKey = undefined;
		}
		return new WorldClient(socketPath, sessionKey, options);
	}

	/** Whether a connection is currently established. */
	get connected(): boolean {
		return this.#endpoint?.usable ?? false;
	}

	/** Whether this client can perform authority-checked World operations. */
	get canMutate(): boolean {
		return this.sessionKey !== undefined;
	}

	/**
	 * List session summaries in the daemon's object-key order.
	 *
	 * `limit` is required and must be positive: an unbounded list of a
	 * long-running daemon's sessions is a page this client has no use for and
	 * the daemon has no obligation to bound.
	 */
	async listSessions(limit: number, signal?: AbortSignal): Promise<SessionSummary[]> {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error(`session list limit must be a positive integer: ${limit}`);
		}
		if (limit > MAX_SESSION_PAGE) {
			throw new Error(`session list limit ${limit} exceeds the ${MAX_SESSION_PAGE} row page bound`);
		}
		const endpoint = await this.#connect(signal);
		const response = await this.#call(endpoint, () => endpoint.service.ListSessions({ limit }, signal), signal);
		return response.sessions ?? [];
	}

	/**
	 * Resolve one dispatch intent key directly.
	 *
	 * This is the recovery predicate for a submission whose response was lost:
	 * the key computed by {@link deriveIntentKey} before submitting resolves the
	 * work the daemon already owns. A key with no stored intent is a typed
	 * absence, not an error, and listing sessions cannot answer it.
	 *
	 * `waitForCustody` defaults to true, so an admitted attempt can hold this
	 * call open until executor custody appears or the attempt settles. Set it
	 * false to read the current `awaitingCustody` observation without waiting.
	 */
	async lookupDispatchIntent(
		key: string,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_LOOKUP_TIMEOUT_MS,
		waitForCustody: boolean = true,
	): Promise<DispatchIntentLookup> {
		const trimmed = key.trim();
		if (!trimmed) throw new Error("dispatch intent key is required");
		// The caller's own cancellation still wins; the deadline only adds an
		// upper bound so a never-binding attempt cannot hold the caller forever.
		const bounded = boundOperation(signal, timeoutMs);
		let response: LookupDispatchIntentResponse;
		try {
			const endpoint = await this.#connect(bounded.signal);
			response = await this.#call(
				endpoint,
				() => endpoint.service.LookupDispatchIntent({ intentKey: trimmed, waitForCustody }, bounded.signal),
				bounded.signal,
			);
		} catch (error) {
			// Report which clock ran out. A caller that aborted already knows.
			if (bounded.expired() && !signal?.aborted) {
				throw new Error(`dispatch intent lookup exceeded ${timeoutMs}ms for ${trimmed}`);
			}
			throw error;
		} finally {
			bounded.dispose();
		}
		return mapDispatchIntent(response);
	}

	/**
	 * Read one canonical World URI.
	 *
	 * The path is sent exactly as given. Nothing is percent-decoded here or at
	 * the daemon: object keys are restricted to a grammar that survives a URL
	 * path unchanged, so a decode on either side would be a second reading of
	 * bytes that already mean one thing. Malformed input is rejected before any
	 * connection is opened, so a bad URI never dials.
	 *
	 * Object versus listing is selected by the URI alone: a trailing `/-` asks
	 * for the bounded key listing under the resolved key. There is no mode
	 * option, so the same address always denotes the same read.
	 */
	async readWorldURI(uri: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<WorldRead> {
		const limit = options.limit ?? MAX_WORLD_READ_PAGE;
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error(`world read limit must be a positive integer: ${limit}`);
		}
		if (limit > MAX_WORLD_READ_PAGE) {
			throw new Error(`world read limit ${limit} exceeds the ${MAX_WORLD_READ_PAGE} row page bound`);
		}
		// Rejected before connecting, so a malformed read performs no dial.
		assertCanonicalWorldPath(uri);
		const signal = options.signal;
		const endpoint = await this.#connect(signal);
		const response = await this.#call(endpoint, () => endpoint.service.ReadWorldURI({ uri, limit }, signal), signal);
		const objectKey = response.objectKey ?? "";
		if (!response.found) return { found: false, objectKey };
		const read = response.read;
		if (read?.case === "snapshot") return { found: true, objectKey, kind: "snapshot", snapshot: read.value };
		if (read?.case === "agentTree") return { found: true, objectKey, kind: "agentTree", agentTree: read.value };
		if (read?.case === "listing") {
			return {
				found: true,
				objectKey,
				kind: "listing",
				keys: read.value.keys ?? [],
				truncated: read.value.truncated ?? false,
			};
		}
		throw new Error(`world read returned no arm for ${objectKey}`);
	}

	/**
	 * Derive the deterministic dispatch intent key for one identity tuple.
	 *
	 * Callers compute this before submitting so the submission stays
	 * recoverable. It touches no transport.
	 */
	deriveIntentKey(source: IntentKeySource): { intentKey: string; source: IntentKeySource } {
		return intentKey(source);
	}

	/**
	 * Submit one dispatch under the bound caller.
	 *
	 * The parent is the bound caller, not a field: a request cannot name a parent
	 * it is not. The intent key is computed here, before the call, so a lost
	 * response stays recoverable through {@link lookupDispatchIntent} — and a
	 * retry carrying the same identity resolves to the accepted attempt rather
	 * than starting a second one.
	 */
	async submitDispatch(request: WorldDispatchSubmit, signal?: AbortSignal): Promise<WorldDispatchSubmitResult> {
		const identity = this.deriveIntentKey(request.identity);
		// The envelope needs a retry key and the submission already has one, so
		// defaulting to it keeps a caller from inventing a second identity for the
		// same work.
		const requestId = assertWorldRequestId(request.requestId?.trim() || identity.intentKey);
		const response = await this.#mutate(
			"dispatch_submit",
			{
				requestId,
				operation: {
					case: "dispatchSubmit",
					value: {
						objective: identity.source.objective,
						doneCriteria: request.doneCriteria ?? "",
						adapterArgv: request.adapterArgv ?? [],
						worktreePath: request.worktreePath ?? "",
						workingDirectory: request.workingDirectory ?? "",
						maxRuntimeSeconds: BigInt(Math.max(0, Math.trunc(request.maxRuntimeSeconds ?? 0))),
						model: request.model ?? "",
						// `IntentKeySource` mirrors the generated message field for field,
						// which is the property the shared golden vectors exist to keep.
						intentIdentity: { source: identity.source, intentKey: identity.intentKey },
						childWorldOperations: request.childWorldOperations ?? [],
					},
				},
			},
			signal,
		);
		const result = expectResultArm(response, "dispatch_submit", "dispatchSubmit", requestId);
		return {
			requestId,
			intentKey: identity.intentKey,
			session: result.session,
			custody: result.custody,
		};
	}

	/**
	 * Answer one exact Question under the bound caller.
	 *
	 * `requestId` is the retry identity. Repeating it with the same content
	 * returns the stored Decision without writing again; repeating it with
	 * different content is a `RETRY_CONFLICT` rather than a silent second answer.
	 */
	async answerQuestion(request: WorldQuestionAnswer, signal?: AbortSignal): Promise<WorldQuestionAnswerResult> {
		const requestId = assertWorldRequestId(request.requestId.trim());
		const questionObjectKey = requireTarget(request.questionObjectKey, "question object key");
		const summary = request.summary.trim();
		if (!summary) throw new Error("question answer summary is required");
		const response = await this.#mutate(
			"question_answer",
			{ requestId, operation: { case: "questionAnswer", value: { questionObjectKey, summary } } },
			signal,
		);
		const result = expectResultArm(response, "question_answer", "questionAnswer", requestId);
		return {
			requestId,
			questionObjectKey: result.questionObjectKey ?? questionObjectKey,
			decisionObjectKey: result.decisionObjectKey ?? "",
			evidenceObjectKey: result.evidenceObjectKey ?? "",
			goalObjectKey: result.goalObjectKey ?? "",
			questionState: result.questionState ?? "",
			goalState: result.goalState ?? "",
			resumeTriggerObjectKey: result.resumeTriggerObjectKey ?? "",
			replayed: result.replayed ?? false,
		};
	}

	/** Deliver steering input to one target session under the bound caller. */
	async sendSessionInput(request: WorldSessionInput, signal?: AbortSignal): Promise<WorldSessionControlResult> {
		const requestId = assertWorldRequestId(request.requestId.trim());
		const targetSessionObjectKey = requireTarget(request.targetSessionObjectKey, "target session object key");
		if (!request.text) throw new Error("session input text is required");
		const response = await this.#mutate(
			"session_input",
			{ requestId, operation: { case: "sessionInput", value: { targetSessionObjectKey, text: request.text } } },
			signal,
		);
		const result = expectResultArm(response, "session_input", "sessionInput", requestId);
		return mapSessionControl("session_input", requestId, targetSessionObjectKey, result);
	}

	/**
	 * Store an interrupt for one target session under the bound caller.
	 *
	 * Acceptance means GLaDOS stored the cancellation request. Terminal
	 * acceptance and process release happen afterwards on the daemon's schedule,
	 * so a caller that needs to observe the end watches the dispatch.
	 */
	async interruptSession(request: WorldSessionInterrupt, signal?: AbortSignal): Promise<WorldSessionControlResult> {
		const requestId = assertWorldRequestId(request.requestId.trim());
		const targetSessionObjectKey = requireTarget(request.targetSessionObjectKey, "target session object key");
		const response = await this.#mutate(
			"session_interrupt",
			{
				requestId,
				operation: {
					case: "sessionInterrupt",
					value: { targetSessionObjectKey, reason: request.reason ?? "" },
				},
			},
			signal,
		);
		const result = expectResultArm(response, "session_interrupt", "sessionInterrupt", requestId);
		return mapSessionControl("session_interrupt", requestId, targetSessionObjectKey, result);
	}

	/**
	 * Stream complete dispatch snapshots until the requested condition holds.
	 *
	 * Every snapshot is whole current state rather than a delta, which is what
	 * lets a caller reopen a watch after a disconnect and continue without an
	 * event cursor. The stream can also end without the condition ever holding —
	 * a missing intent under `custody` or `terminal` is exactly that case — so a
	 * consumer decides what an unmet condition means rather than waiting forever.
	 */
	async *watchDispatch(
		request: WorldDispatchWatch,
		signal?: AbortSignal,
	): AsyncGenerator<WorldDispatchSnapshot, void, void> {
		const intentKeyValue = request.intentKey.trim();
		if (!intentKeyValue) throw new Error("dispatch intent key is required");
		const runtime = await this.#runtimeFor("dispatch_watch", signal);
		const stream = runtime.service.WatchDispatch(
			{ intentKey: intentKeyValue, completion: WATCH_COMPLETION[request.stop] },
			signal,
		);
		for await (const response of this.#iterate(runtime.endpoint, stream, signal)) {
			const result = response.result;
			if (result?.case === "authorityDenial") throw new WorldAuthorityError("dispatch_watch", result.value);
			if (result?.case === "operationFailure") {
				throw new WorldOperationError("dispatch_watch", result.value, "");
			}
			if (result?.case !== "snapshot") {
				throw new Error(`world dispatch watch returned no arm for ${intentKeyValue}`);
			}
			const snapshot = result.value;
			yield {
				intent: mapDispatchIntent(snapshot.intent ?? { found: false }),
				completionMet: snapshot.completionMet ?? false,
			};
		}
	}

	/**
	 * Release the connection and refuse further work. Idempotent.
	 *
	 * Order matters. An established endpoint is released first, while its
	 * connection scope is still live: the endpoint was opened against the
	 * lifetime signal, so cancelling that signal first would abort the courtesy
	 * resource release mid-call and reject it as `ERR_RPC_ABORT` — a failure
	 * invented by the shutdown itself.
	 *
	 * The lifetime is cancelled after, where it does the one job left: stopping
	 * a connect still in flight. That connect is then awaited, so `close` does
	 * not return while a socket is still being opened and cannot leak an
	 * endpoint that arrives late.
	 */
	async close(): Promise<void> {
		this.#closed = true;
		const connecting = this.#connecting;
		let closeFailed = false;
		let closeError: unknown;
		try {
			await this.#discard();
		} catch (error) {
			closeFailed = true;
			closeError = error;
		}
		this.#lifetime.abort(abortError());
		if (connecting) {
			const late = await connecting.catch(() => null);
			if (late) {
				try {
					await late.close();
				} catch (error) {
					if (!closeFailed) {
						closeFailed = true;
						closeError = error;
					}
				}
			}
		}
		if (closeFailed) throw closeError;
	}

	/**
	 * Run one authority-checked mutation and raise its structured refusals.
	 *
	 * A denial and a failure are results, not transport errors: they arrive on
	 * the response and are turned into the two error classes here so every caller
	 * — native tool, Claude bridge, direct user — sees the same typed refusal
	 * with the daemon's own code and fields intact.
	 */
	async #mutate(
		operation: WorldOperation,
		request: WorldRuntimeMutationRequest,
		signal?: AbortSignal,
	): Promise<WorldRuntimeMutationResponse> {
		const runtime = await this.#runtimeFor(operation, signal);
		const response = await this.#call(runtime.endpoint, () => runtime.service.Mutate(request, signal), signal);
		const result = response.result;
		if (result?.case === "authorityDenial") throw new WorldAuthorityError(operation, result.value);
		if (result?.case === "operationFailure") {
			throw new WorldOperationError(operation, result.value, request.requestId ?? "");
		}
		return response;
	}

	/** The runtime service for the current endpoint, binding the caller once. */
	async #runtimeFor(
		operation: WorldOperation,
		signal?: AbortSignal,
	): Promise<{ endpoint: WorldEndpoint; service: WorldRuntimeService }> {
		const sessionKey = this.sessionKey;
		if (!sessionKey) {
			throw new Error(
				`world ${operation} needs a caller session: set ${WORLD_SESSION_ENV} or the world.session setting`,
			);
		}
		const endpoint = await this.#connect(signal);
		const current = this.#runtime;
		if (current?.endpoint === endpoint) return { endpoint, service: current.binding.service };
		// Shared like the connect above: two concurrent operations must not open
		// two child resources for one caller on one connection. The endpoint is
		// part of the memo because a bind in flight when the connection is
		// replaced belongs to the old one, and reusing it would hand this caller a
		// child id the new connection never issued.
		let binding = this.#binding?.endpoint === endpoint ? this.#binding.pending : null;
		if (!binding) {
			const pending = this.#openRuntime(endpoint, sessionKey).finally(() => {
				if (this.#binding?.pending === pending) this.#binding = null;
			});
			// A caller that aborts leaves this promise unobserved; keep a rejection
			// from surfacing as an unhandled one.
			pending.catch(() => {});
			this.#binding = { endpoint, pending };
			binding = pending;
		}
		if (!signal) return { endpoint, service: (await binding).service };
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return { endpoint, service: (await Promise.race([binding, aborted.promise])).service };
		} finally {
			signal.removeEventListener("abort", onAbort);
			aborted.promise.catch(() => {});
		}
	}

	/**
	 * Bind the caller session to a child runtime resource on one endpoint.
	 *
	 * The binding is scoped to the endpoint that produced the id: a child id is
	 * meaningless to a connection that never issued it, so a reconnect after a
	 * daemon restart rebinds rather than replaying the old id. The call carries
	 * the client's own lifetime signal because the binding is shared — one
	 * caller's cancellation must not cancel it for the others.
	 */
	async #openRuntime(endpoint: WorldEndpoint, sessionKey: string): Promise<WorldRuntimeBinding> {
		const lifetime = this.#lifetime.signal;
		const response = await this.#call(
			endpoint,
			() => endpoint.service.AccessWorldRuntime({ callerSessionObjectKey: sessionKey }, lifetime),
			lifetime,
		);
		const resourceId = response.resourceId ?? 0;
		if (!resourceId) throw new Error(`world runtime binding for ${sessionKey} returned no child resource`);
		const binding = endpoint.accessRuntime(resourceId);
		if (this.#closed) {
			await binding.release().catch(() => {});
			throw new Error("World client is closed");
		}
		// Recorded even when the endpoint has already been replaced: the next
		// operation sees the mismatch and rebinds, and releasing a child on a
		// retired transport is a no-op.
		this.#runtime = { endpoint, binding };
		return binding;
	}

	/**
	 * Iterate one server stream, retiring the endpoint on a real failure.
	 *
	 * Cancelling a watch is scoped to that watch, exactly as a cancelled unary
	 * call is: starpc ends the one stream and the session keeps serving, so the
	 * client stays usable afterwards.
	 */
	async *#iterate<T>(
		endpoint: WorldEndpoint,
		stream: AsyncIterable<T>,
		signal?: AbortSignal,
	): AsyncGenerator<T, void, void> {
		try {
			for await (const item of stream) {
				if (signal?.aborted) throw abortError();
				yield item;
			}
		} catch (error) {
			if (isAbortError(error) && endpoint.usable) throw error;
			await this.#discard(endpoint);
			throw error;
		}
	}

	async #connect(signal?: AbortSignal): Promise<WorldEndpoint> {
		if (this.#closed) throw new Error("World client is closed");
		if (signal?.aborted) throw abortError();
		const current = this.#endpoint;
		if (current) {
			if (current.usable) return current;
			// The endpoint retired itself. Drop it so this call reconnects
			// instead of replaying a handle the daemon no longer holds.
			await this.#discard();
		}
		this.#connecting ??= this.#open().finally(() => {
			this.#connecting = null;
		});
		const connecting = this.#connecting;
		if (!signal) return await connecting;
		// Compose the two cancellations rather than conflating them: the shared
		// connect belongs to the client and only `close` stops it, while this
		// caller stops waiting the moment its own signal fires.
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([connecting, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			aborted.promise.catch(() => {});
		}
	}

	async #open(): Promise<WorldEndpoint> {
		const endpoint = await this.#openEndpoint(this.socketPath, this.#lifetime.signal);
		if (this.#closed) {
			await endpoint.close();
			throw new Error("World client is closed");
		}
		this.#endpoint = endpoint;
		return endpoint;
	}

	/**
	 * Run one call, discarding the endpoint whenever it does not complete
	 * cleanly. A transport that produced an error is not trusted for the next
	 * operation.
	 */
	async #call<T>(endpoint: WorldEndpoint, start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		// The abort can land while the connection is still opening, so it is
		// re-checked here rather than only before connecting. Starting the RPC
		// first would leave a request in flight that nobody is waiting for.
		if (signal?.aborted) throw abortError();
		try {
			return await endpoint.call(start(), signal);
		} catch (error) {
			// A cancelled call is scoped to that call: starpc ends it and the
			// session is untouched, so an endpoint that still reports itself
			// usable keeps serving. Discarding here would make every abort cost
			// the next caller a re-handshake.
			if (isAbortError(error) && endpoint.usable) throw error;
			await this.#discard(endpoint);
			throw error;
		}
	}

	/**
	 * Drop `endpoint` if it is still the current one.
	 *
	 * The identity check is the point. Two operations can share an endpoint; if
	 * the first fails, reconnects, and the second fails afterwards, an
	 * unconditional discard would close the healthy replacement the first
	 * operation just established and break calls already running on it.
	 */
	async #discard(endpoint: WorldEndpoint | null = this.#endpoint): Promise<void> {
		if (!endpoint || this.#endpoint !== endpoint) return;
		this.#endpoint = null;
		// The runtime child belongs to this endpoint and is released by its close.
		// Forgetting it here is what makes the next operation rebind the caller
		// against the replacement connection instead of a resource id the daemon
		// no longer holds.
		if (this.#runtime?.endpoint === endpoint) this.#runtime = null;
		await endpoint.close();
	}
}

/**
 * Open one Resource SDK endpoint and bind the generated GLaDOS service to its
 * root resource.
 */
export async function openResourceEndpoint(
	socketPath: string,
	dial?: DialFn,
	signal?: AbortSignal,
): Promise<WorldEndpoint> {
	const transport = new WorldTransport({ socketPath, dial });
	try {
		const ref = await transport.accessRootResource(signal);
		const service: WorldService = new GladosResourceServiceClient(ref.rpc);
		// Child resources ride this same connection and outlive no part of it, so
		// the endpoint owns them: closing releases each child before the root,
		// which is the order the daemon's handle table expects.
		const children: { release(): Promise<void> }[] = [];
		return {
			service,
			get usable() {
				return transport.usable;
			},
			call: (pending, callSignal) => callWithAbort(pending, callSignal),
			accessRuntime: resourceId => {
				const child = transport.accessResource(resourceId);
				children.push(child);
				return { service: new WorldRuntimeResourceServiceClient(child.rpc), release: () => child.release() };
			},
			close: async () => {
				try {
					// Best effort, and never at the cost of the root release: a child
					// handle the daemon already forgot must not keep the connection up.
					await Promise.allSettled(children.map(child => child.release()));
					await ref.release();
				} finally {
					await transport.close();
				}
			},
		};
	} catch (error) {
		await transport.close();
		throw error;
	}
}

/** Map one lookup or watch response onto the typed intent shape. */
function mapDispatchIntent(response: LookupDispatchIntentResponse): DispatchIntentLookup {
	if (!response.found) return { found: false };
	return {
		found: true,
		intentState: response.intentState ?? "",
		activeAttemptKey: response.activeAttemptKey ?? "",
		attemptState: response.attemptState ?? "",
		session: response.session,
		custody: response.custody,
		awaitingCustody: response.awaitingCustody ?? false,
	};
}

/** The success arms one mutation response can carry. */
type MutationResultArm = Extract<NonNullable<WorldRuntimeMutationResponse["result"]>, { case: string }>;
type MutationResultsByCase = {
	[Arm in MutationResultArm as Arm["case"]]: Arm["value"];
};

/**
 * Read the arm this operation asked for.
 *
 * Denials and failures are raised before this runs, so anything else is a
 * response that does not answer the request that was made.
 */
function expectResultArm<C extends keyof MutationResultsByCase>(
	response: WorldRuntimeMutationResponse,
	operation: WorldOperation,
	arm: C,
	requestId: string,
): MutationResultsByCase[C] {
	const result = response.result;
	if (result?.case === arm) {
		return result.value as MutationResultsByCase[C];
	}
	throw new Error(`world ${operation} returned ${result?.case ?? "no"} result for request ${requestId}`);
}

function mapSessionControl(
	operation: WorldOperation,
	requestId: string,
	targetSessionObjectKey: string,
	result: {
		targetSessionObjectKey?: string;
		dispatchKey?: string;
		acceptedSequence?: bigint;
		detail?: string;
		replayed?: boolean;
	},
): WorldSessionControlResult {
	return {
		requestId,
		operation,
		targetSessionObjectKey: result.targetSessionObjectKey ?? targetSessionObjectKey,
		dispatchKey: result.dispatchKey ?? "",
		acceptedSequence: result.acceptedSequence ?? 0n,
		detail: result.detail ?? "",
		replayed: result.replayed ?? false,
	};
}

/** Reject an empty target before it costs a connection. */
function requireTarget(value: string, label: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`world ${label} is required`);
	return trimmed;
}

/** One caller signal combined with a client-owned deadline. */
interface BoundedOperation {
	signal: AbortSignal | undefined;
	expired: () => boolean;
	dispose: () => void;
}

/**
 * Compose the caller's signal with a deadline of this client's own.
 *
 * The two cancellations stay distinguishable: `expired` reports whether the
 * deadline is what fired, so a timeout is not reported back as the caller's own
 * abort. A non-positive timeout means the caller opted out and keeps its signal
 * unchanged.
 */
function boundOperation(signal: AbortSignal | undefined, timeoutMs: number): BoundedOperation {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return { signal, expired: () => false, dispose: () => {} };
	}
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(abortError());
	}, timeoutMs);
	timer.unref?.();
	const onCallerAbort = () => controller.abort(abortError());
	if (signal?.aborted) controller.abort(abortError());
	else signal?.addEventListener("abort", onCallerAbort, { once: true });
	return {
		signal: controller.signal,
		expired: () => expired,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onCallerAbort);
		},
	};
}

/**
 * Whether one rejection is a cancellation rather than a transport failure.
 *
 * starpc does not raise a DOMException-shaped AbortError when it cancels a call
 * mid-flight: it throws a plain `new Error("ERR_RPC_ABORT")`, whose `name` is
 * just "Error". Matching on `name` alone therefore misses the library's own
 * cancellation and reads it as a dead transport — which, on a shared Yamux
 * connection, would tear down the session and every concurrent call on it
 * because one caller aborted. starpc's own predicate is the authority here, so
 * it stays correct if that sentinel ever changes.
 */
function isAbortError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || isStarpcAbortError(error);
}

/** Trailing marker that selects the bounded key listing under an address. */
export const WORLD_LISTING_SELECTOR = "/-";

/**
 * Reject a World path before it can reach a socket.
 *
 * This mirrors the daemon's validation order so the two runtimes agree on what
 * is malformed, and so an obviously bad URI costs no connection. The listing
 * selector comes off first because it is structure rather than content; the
 * byte bans then run before anything is parsed, because a fragment marker or a
 * traversal cannot be seen once a parse has consumed it. The daemon still
 * re-checks: this is a fast local guard, not the authority.
 */
export function assertCanonicalWorldPath(uri: string): void {
	if (!uri) throw new Error("world uri is required");
	const address = uri.endsWith(WORLD_LISTING_SELECTOR)
		? uri.slice(0, uri.length - WORLD_LISTING_SELECTOR.length)
		: uri;
	if (!address) throw new Error("world uri is required");
	for (const ch of address) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "%") throw new Error(`world uri must not be percent-encoded: ${uri}`);
		if (ch === "#") throw new Error(`world uri must not carry a fragment marker: ${uri}`);
		if (ch === "?") throw new Error(`world uri must not carry a query marker: ${uri}`);
		if (code <= 0x20 || code === 0x7f) {
			throw new Error(`world uri must not contain whitespace or control bytes: ${uri}`);
		}
		if (code > 0x7f) throw new Error(`world uri must be ASCII: ${uri}`);
	}
	const rooted = address.startsWith("/") ? address : `/${address}`;
	if (cleanWorldPath(rooted) !== rooted) {
		throw new Error(`world uri is not canonical: ${uri}`);
	}
	// The full form is required so an address always names the World it means.
	// The short forms the parser accepts default to session 1 and an empty
	// Space, which would silently address whatever the daemon happened to mount.
	if (!rooted.startsWith("/u/")) {
		throw new Error(`world uri must use the full /u/{session_idx}/so/{space_id}/-/{objectKey} form: ${uri}`);
	}
	if (!rooted.includes("/so/")) throw new Error(`world uri must name a Space with /so/: ${uri}`);
	if (!rooted.includes(WORLD_SUBPATH_DELIMITER)) {
		throw new Error(`world uri must name an object key after /-/: ${uri}`);
	}
	assertCanonicalWorldParts(rooted, uri);
}

/** Structural delimiter between an address and the segments it delimits. */
const WORLD_SUBPATH_DELIMITER = "/-/";

/**
 * Canonical positive decimal: no zero, no leading zeros, within uint32.
 *
 * Positive-only so `formatWorldURI` cannot emit session 0, which no mount
 * produces and which the daemon refuses.
 */
const CANONICAL_SESSION_INDEX = /^[1-9][0-9]*$/;

/**
 * Validate what the structural delimiters delimit.
 *
 * This runs after the raw bans and the clean check, in the same order the
 * daemon uses, so a key hazard that only becomes visible once `/-/` is consumed
 * is caught here rather than at the far end of a socket. Without it an address
 * carrying a malformed object key is structurally fine and dials before being
 * refused, which costs a connection to learn something local.
 *
 * The Space ID is treated as opaque: it is whatever the mount resolved, so only
 * its shape is checked here and the daemon's exact comparison against its own
 * mounted identity owns which values are legitimate.
 */
function assertCanonicalWorldParts(rooted: string, uri: string): void {
	const afterPrefix = rooted.slice("/u/".length);
	const firstSlash = afterPrefix.indexOf("/");
	if (firstSlash <= 0) throw new Error(`world uri must name a session index: ${uri}`);
	const rawSessionIdx = afterPrefix.slice(0, firstSlash);
	if (!CANONICAL_SESSION_INDEX.test(rawSessionIdx) || Number(rawSessionIdx) > 0xffff_ffff) {
		throw new Error(`world uri session index must be a canonical positive uint32: ${uri}`);
	}

	const afterSession = afterPrefix.slice(firstSlash + 1);
	if (!afterSession.startsWith("so/")) throw new Error(`world uri must name a Space with /so/: ${uri}`);
	const afterSpacePrefix = afterSession.slice("so/".length);
	const delimiter = afterSpacePrefix.indexOf(WORLD_SUBPATH_DELIMITER);
	if (delimiter === -1) throw new Error(`world uri must name an object key after /-/: ${uri}`);
	const spaceId = afterSpacePrefix.slice(0, delimiter);
	if (!spaceId) throw new Error(`world uri must name a nonempty Space id: ${uri}`);
	if (spaceId.includes("/")) throw new Error(`world uri Space id must be one segment: ${uri}`);

	// Exactly one group after the delimiter. A nonempty subpath addresses
	// something inside an object, which is reserved rather than supported.
	const groups = afterSpacePrefix.slice(delimiter + WORLD_SUBPATH_DELIMITER.length).split(WORLD_SUBPATH_DELIMITER);
	if (groups.length !== 1) {
		throw new Error(`world uri must name exactly one object key, got ${groups.length} segments: ${uri}`);
	}
	assertObjectKey(groups[0], uri);
}

/**
 * Check one object key against the daemon's canonical grammar.
 *
 * A segment is never exactly `-`, `.`, or `..`: the first is the subpath
 * delimiter marker and the other two are rewritten by path cleaning.
 */
function assertObjectKey(objectKey: string, uri: string): void {
	if (!objectKey) throw new Error(`world uri object key is required: ${uri}`);
	if (objectKey.startsWith("/") || objectKey.endsWith("/")) {
		throw new Error(`world uri object key must not start or end with "/": ${uri}`);
	}
	for (const segment of objectKey.split("/")) {
		if (!segment) throw new Error(`world uri object key has an empty segment: ${uri}`);
		if (segment === "-" || segment === "." || segment === "..") {
			throw new Error(`world uri object key segment "${segment}" is reserved: ${uri}`);
		}
		if (!WORLD_OBJECT_KEY_SEGMENT.test(segment)) {
			throw new Error(
				`world uri object key segment "${segment}" must match ${WORLD_OBJECT_KEY_SEGMENT.source}: ${uri}`,
			);
		}
	}
}

/** One World address, in the parts the canonical form is built from. */
export interface WorldAddress {
	sessionIdx: number;
	spaceId: string;
	objectKey: string;
	/** Ask for the bounded key listing under `objectKey` rather than the object. */
	listing?: boolean;
}

/**
 * Build the canonical World path for one address.
 *
 * One formatter exists so every caller — the native protocol handler, the
 * Claude tool, and any direct client user — produces byte-identical addresses
 * for the same object. The result is validated before it is returned: a
 * formatter that can emit something the reader would refuse is a way for an
 * invalid key to reach a caller as if it were addressable.
 */
export function formatWorldURI(address: WorldAddress): string {
	const path = `/u/${address.sessionIdx}/so/${address.spaceId}/-/${address.objectKey}`;
	const formatted = address.listing ? `${path}${WORLD_LISTING_SELECTOR}` : path;
	assertCanonicalWorldPath(formatted);
	return formatted;
}

/** The `spacewave://` scheme, with its empty authority. */
const WORLD_URL_PREFIX = "spacewave://";

/**
 * Build the canonical `spacewave://` URL for one address.
 *
 * The local form has an empty authority — `spacewave:///u/1/...`, three slashes
 * — because the whole address lives in the path. A nonempty authority would
 * make the first path segment look like a host, which is a different address
 * that happens to parse.
 */
export function formatWorldURL(address: WorldAddress): string {
	return `${WORLD_URL_PREFIX}${formatWorldURI(address)}`;
}

/** Go path.Clean over a rooted path, matching the daemon's identity check. */
function cleanWorldPath(rooted: string): string {
	const out: string[] = [];
	for (const segment of rooted.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			out.pop();
			continue;
		}
		out.push(segment);
	}
	return `/${out.join("/")}`;
}

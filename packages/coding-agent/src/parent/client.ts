import { isAbortError as isStarpcAbortError } from "starpc";
import { type ParentEnvironmentSources, resolveParentSessionId, resolveParentSocketPath } from "./config.js";
import type {
	AgentMessageSummary,
	AgentTreeSnapshot,
	LookupTaskIntentResponse,
	SessionSnapshot,
	SessionSummary,
	TaskAgentSpec,
	InteractiveRootBinding as WireInteractiveRootBinding,
	InteractiveRootSpec as WireInteractiveRootSpec,
	ParentFailure as WireParentFailure,
} from "./generated/parent-environment.pb.js";
import {
	InteractiveRootTransitionReason,
	ParentCapability,
	ParentFailureCode,
	PeerMessageAckOutcome,
	PeerMessageOutcome,
	TaskAgentSource,
} from "./generated/parent-environment.pb.js";
import { ParentEnvironmentServiceClient } from "./generated/parent-environment_srpc.pb.js";
import { type IntentKeySource, intentKey } from "./intent-key.js";
import { abortError, callWithAbort, type DialFn, ParentTransport } from "./transport.js";

export { ParentCapability, ParentFailureCode, PeerMessageAckOutcome, PeerMessageOutcome, TaskAgentSource };
export const MAX_SESSION_PAGE = 500;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;

export interface ParentClientOptions extends ParentEnvironmentSources {
	interactiveRoot?: boolean;
	dial?: DialFn;
	openEndpoint?: (socketPath: string, signal: AbortSignal) => Promise<ParentEndpoint>;
}
export interface InteractiveRootSpec {
	ompSessionId: string;
	processInstanceId: string;
	workingDirectory: string;
	workspaceRoots: string[];
	provider: string;
	model: string;
	transitionReason: string;
	predecessorOmpSessionId?: string;
	protocolVersion: string;
	buildIdentity: string;
}
export interface InteractiveRootBinding {
	ompSessionId: string;
	parentSessionId: string;
	generation: bigint;
	configurationDigest: string;
	provider: string;
	model: string;
}
export type DispatchIntentLookup =
	| { found: false }
	| {
			found: true;
			intentState: string;
			activeAttemptId: string;
			attemptState: string;
			session?: SessionSummary;
			awaitingParent: boolean;
	  };
export interface ParentAgentPeerResolution {
	found: boolean;
	agent?: import("./generated/parent-environment.pb.js").AgentSummary;
	session?: SessionSummary;
	inactive: boolean;
}
export interface ParentDispatchSubmit {
	identity: IntentKeySource;
	doneCriteria?: string;
	adapterArgv?: string[];
	worktreePath?: string;
	workingDirectory?: string;
	maxRuntimeSeconds?: number;
	model?: string;
	childCapabilities?: ParentCapability[];
	taskAgent?: TaskAgentSpec;
	requestId?: string;
}
export interface ParentDispatchSubmitResult {
	requestId: string;
	intentKey: string;
	session?: SessionSummary;
}
export type ParentPeerMessageTarget = { kind: "peer"; peerId: string } | { kind: "parent" };
export interface ParentPeerMessageSend {
	requestId: string;
	clientMessageId: string;
	body: string;
	replyToClientMessageId?: string;
	expectsReply?: boolean;
	target: ParentPeerMessageTarget;
}
export interface ParentPeerMessageSendResult {
	requestId: string;
	messageId: string;
	clientMessageId: string;
	toAgentId: string;
	targetSessionId: string;
	inboxSequence: bigint;
	outcome: PeerMessageOutcome;
	replayed: boolean;
}
export interface ParentPeerMessageAck {
	requestId: string;
	messageId: string;
	outcome: PeerMessageAckOutcome;
}
export interface ParentPeerMessageAckResult {
	requestId: string;
	messageId: string;
	consumedBySessionId: string;
	consumedAt: string;
	replayed: boolean;
}
export interface ParentSessionInterrupt {
	requestId: string;
	targetSessionId: string;
	reason?: string;
}
export interface ParentSessionControlResult {
	requestId: string;
	targetSessionId: string;
	acceptedSequence: bigint;
	detail: string;
	replayed: boolean;
}

export class ParentOperationError extends Error {
	readonly code: ParentFailureCode;
	readonly codeName: string;
	readonly targetId: string;
	readonly requiredCapability: string;
	readonly detail: string;
	readonly requestId: string;
	constructor(operation: string, failure: WireParentFailure, requestId = "") {
		const code = failure.code ?? ParentFailureCode.UNKNOWN;
		const codeName = ParentFailureCode[code] ?? "UNKNOWN";
		super(`parent ${operation} failed: ${codeName}${failure.detail ? ` — ${failure.detail}` : ""}`);
		this.name = "ParentOperationError";
		this.code = code;
		this.codeName = codeName;
		this.targetId = failure.targetId ?? "";
		this.requiredCapability = failure.requiredCapability ?? "";
		this.detail = failure.detail ?? "";
		this.requestId = requestId;
	}
}
export class ParentEndpointError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "ParentEndpointError";
	}
}
export interface ParentEndpoint {
	readonly service: ParentEnvironmentServiceClient;
	readonly usable: boolean;
	close(): Promise<void>;
}

function toWireInteractiveRootSpec(spec: InteractiveRootSpec): WireInteractiveRootSpec {
	const name = spec.transitionReason.toUpperCase() as keyof typeof InteractiveRootTransitionReason;
	const transitionReason = InteractiveRootTransitionReason[name];
	if (transitionReason === undefined || transitionReason === InteractiveRootTransitionReason.UNKNOWN) {
		throw new Error(`unsupported interactive root transition reason: ${spec.transitionReason}`);
	}
	return { ...spec, transitionReason };
}
function mapInteractiveBinding(binding: WireInteractiveRootBinding | undefined): InteractiveRootBinding {
	if (!binding) throw new Error("parent omitted interactive root binding");
	const required = (value: string | undefined, name: string) => {
		if (!value) throw new Error(`interactive root binding omitted ${name}`);
		return value;
	};
	if (!binding.generation) throw new Error("interactive root binding omitted generation");
	return {
		ompSessionId: required(binding.ompSessionId, "OMP session ID"),
		parentSessionId: required(binding.parentSessionId, "parent session ID"),
		generation: binding.generation,
		configurationDigest: required(binding.configurationDigest, "configuration digest"),
		provider: required(binding.provider, "provider"),
		model: required(binding.model, "model"),
	};
}
function lookupFromWire(response: LookupTaskIntentResponse): DispatchIntentLookup {
	if (!response.found) return { found: false };
	return {
		found: true,
		intentState: response.intentState ?? "",
		activeAttemptId: response.activeAttemptId ?? "",
		attemptState: response.attemptState ?? "",
		session: response.session,
		awaitingParent: response.awaitingParent ?? false,
	};
}
function requireFailure(operation: string, failure: WireParentFailure | undefined, requestId = ""): void {
	if (failure) throw new ParentOperationError(operation, failure, requestId);
}

/** One immutable connection to the parent selected at process startup. */
export class ParentClient {
	readonly #socketPath: string;
	readonly #staticSessionId: string | undefined;
	readonly #interactiveRoot: boolean;
	readonly #openEndpoint: (socketPath: string, signal: AbortSignal) => Promise<ParentEndpoint>;
	readonly #controller = new AbortController();
	#endpoint: ParentEndpoint | undefined;
	#connecting: Promise<ParentEndpoint> | undefined;
	#environmentId: string | undefined;
	#openingEnvironment: Promise<import("./generated/parent-environment.pb.js").OpenEnvironmentResponse> | undefined;
	#interactiveBinding: InteractiveRootBinding | undefined;
	#interactiveSpec: InteractiveRootSpec | undefined;
	#failure: Error | undefined;
	#closed = false;

	private constructor(socketPath: string, sessionId: string | undefined, options: ParentClientOptions) {
		this.#socketPath = socketPath;
		this.#staticSessionId = sessionId;
		this.#interactiveRoot = options.interactiveRoot === true;
		this.#openEndpoint = options.openEndpoint ?? ((path, signal) => openParentEndpoint(path, signal, options.dial));
	}
	static create(options: ParentClientOptions = {}): ParentClient | undefined {
		const socketPath = resolveParentSocketPath(options);
		if (!socketPath) return undefined;
		const sessionId = resolveParentSessionId(options);
		if (!options.interactiveRoot && !sessionId)
			throw new Error("OMP_PARENT_SESSION is required for a managed parent environment");
		return new ParentClient(socketPath, sessionId, options);
	}
	get connected(): boolean {
		return this.#endpoint !== undefined && this.#environmentId !== undefined;
	}
	get sessionKey(): string | undefined {
		return this.#interactiveBinding?.parentSessionId ?? this.#staticSessionId;
	}
	get canMutate(): boolean {
		return this.sessionKey !== undefined;
	}
	get interactiveRoot(): boolean {
		return this.#interactiveRoot;
	}
	get interactiveBinding(): InteractiveRootBinding | undefined {
		return this.#interactiveBinding;
	}

	async attachInteractiveRoot(spec: InteractiveRootSpec, signal?: AbortSignal): Promise<InteractiveRootBinding> {
		if (!this.#interactiveRoot) throw new Error("parent client is not an interactive root");
		if (this.#environmentId) throw new Error("interactive root is already attached");
		const opened = await this.#ensureEnvironment(
			{ root: { case: "interactiveRoot", value: toWireInteractiveRootSpec(spec) } },
			signal,
		);
		this.#interactiveSpec = { ...spec, workspaceRoots: [...spec.workspaceRoots] };
		this.#interactiveBinding = mapInteractiveBinding(opened.interactiveBinding);
		process.env.OMP_PARENT_SESSION = this.#interactiveBinding.parentSessionId;
		return this.#interactiveBinding;
	}
	async rotateInteractiveRoot(spec: InteractiveRootSpec, signal?: AbortSignal): Promise<InteractiveRootBinding> {
		const environmentId = this.#requireEnvironment();
		const endpoint = await this.#connect(signal);
		const binding = await this.#call(
			endpoint.service.RotateInteractiveRoot({ environmentId, spec: toWireInteractiveRootSpec(spec) }, signal),
			signal,
		);
		return this.#recordInteractive(spec, binding);
	}
	async reconfigureInteractiveRoot(spec: InteractiveRootSpec, signal?: AbortSignal): Promise<InteractiveRootBinding> {
		const environmentId = this.#requireEnvironment();
		const endpoint = await this.#connect(signal);
		const binding = await this.#call(
			endpoint.service.ReconfigureInteractiveRoot({ environmentId, spec: toWireInteractiveRootSpec(spec) }, signal),
			signal,
		);
		return this.#recordInteractive(spec, binding);
	}
	#recordInteractive(spec: InteractiveRootSpec, wire: WireInteractiveRootBinding): InteractiveRootBinding {
		this.#interactiveSpec = { ...spec, workspaceRoots: [...spec.workspaceRoots] };
		const binding = mapInteractiveBinding(wire);
		this.#interactiveBinding = binding;
		process.env.OMP_PARENT_SESSION = binding.parentSessionId;
		return binding;
	}
	async rotateInteractiveRootTransition(transition: {
		sessionId: string;
		previousSessionId?: string;
		reason: string;
		provider: string;
		model: string;
	}): Promise<void> {
		await this.rotateInteractiveRoot(
			this.#transitionSpec(
				transition.sessionId,
				transition.reason,
				transition.provider,
				transition.model,
				transition.previousSessionId,
			),
		);
	}
	async reconfigureInteractiveRootTransition(transition: { provider: string; model: string }): Promise<void> {
		const current = this.#interactiveBinding;
		if (!current) throw new Error("interactive root is not attached");
		await this.reconfigureInteractiveRoot(
			this.#transitionSpec(current.ompSessionId, "RECONFIGURE", transition.provider, transition.model),
		);
	}
	#transitionSpec(
		sessionId: string,
		reason: string,
		provider: string,
		model: string,
		predecessorOmpSessionId?: string,
	): InteractiveRootSpec {
		const current = this.#interactiveSpec;
		if (!current) throw new Error("interactive root is not attached");
		return {
			...current,
			workspaceRoots: [...current.workspaceRoots],
			ompSessionId: sessionId,
			provider,
			model,
			transitionReason: reason,
			predecessorOmpSessionId,
		};
	}
	async retireInteractiveRoot(_reason: unknown): Promise<void> {
		await this.close();
	}

	deriveIntentKey(source: IntentKeySource): { intentKey: string } {
		return { intentKey: intentKey(source).intentKey };
	}
	async listSessions(limit: number, signal?: AbortSignal): Promise<SessionSummary[]> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		return (await this.#call(service.ListSessions({ environmentId, limit }, signal), signal)).sessions ?? [];
	}
	async lookupDispatchIntent(key: string, signal?: AbortSignal): Promise<DispatchIntentLookup> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const bounded = boundOperation(signal, DEFAULT_LOOKUP_TIMEOUT_MS);
		try {
			return lookupFromWire(
				await this.#call(
					service.LookupTaskIntent({ environmentId, intentKey: key, waitForParent: true }, bounded.signal),
					bounded.signal,
				),
			);
		} catch (error) {
			if (bounded.expired() && isAbortError(error)) throw new Error(`parent task lookup timed out: ${key}`);
			throw error;
		} finally {
			bounded.dispose();
		}
	}
	async resolveAgentPeer(peerId: string, signal?: AbortSignal): Promise<ParentAgentPeerResolution> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const response = await this.#call(service.ResolveAgentPeer({ environmentId, peerId }, signal), signal);
		requireFailure("resolve agent peer", response.failure);
		return {
			found: response.found ?? false,
			agent: response.agent,
			session: response.session,
			inactive: response.inactive ?? false,
		};
	}
	async submitDispatch(request: ParentDispatchSubmit, signal?: AbortSignal): Promise<ParentDispatchSubmitResult> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const derived = intentKey(request.identity);
		const requestId = request.requestId ?? derived.intentKey;
		const response = await this.#call(
			service.SubmitTask(
				{
					environmentId,
					requestId,
					objective: derived.source.objective,
					doneCriteria: request.doneCriteria ?? "",
					adapterArgv: request.adapterArgv ?? [],
					worktreePath: request.worktreePath ?? "",
					workingDirectory: request.workingDirectory ?? "",
					maxRuntimeSeconds: BigInt(request.maxRuntimeSeconds ?? 0),
					model: request.model ?? "",
					intentIdentity: { source: derived.source, intentKey: derived.intentKey },
					childCapabilities: request.childCapabilities ?? [],
					taskAgent: request.taskAgent,
				},
				signal,
			),
			signal,
		);
		requireFailure("submit task", response.failure, requestId);
		return {
			requestId: response.requestId ?? requestId,
			intentKey: response.intentKey ?? derived.intentKey,
			session: response.session,
		};
	}
	async *watchSession(sessionId: string, signal?: AbortSignal): AsyncGenerator<SessionSnapshot> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		for await (const response of this.#iterate(service.WatchSession({ environmentId, sessionId }, signal), signal)) {
			if (!response.snapshot) throw new Error("parent session watch omitted its snapshot");
			yield response.snapshot;
		}
	}
	async *watchAgentTree(signal?: AbortSignal): AsyncGenerator<AgentTreeSnapshot> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		for await (const response of this.#iterate(service.WatchAgentTree({ environmentId }, signal), signal)) {
			if (!response.snapshot) throw new Error("parent agent-tree watch omitted its snapshot");
			yield response.snapshot;
		}
	}
	async sendPeerMessage(request: ParentPeerMessageSend, signal?: AbortSignal): Promise<ParentPeerMessageSendResult> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const target =
			request.target.kind === "peer"
				? { case: "targetPeerId" as const, value: request.target.peerId }
				: { case: "targetParent" as const, value: true };
		const response = await this.#call(
			service.SendPeerMessage(
				{
					environmentId,
					requestId: request.requestId,
					clientMessageId: request.clientMessageId,
					body: request.body,
					replyToClientMessageId: request.replyToClientMessageId ?? "",
					expectsReply: request.expectsReply ?? false,
					target,
				},
				signal,
			),
			signal,
		);
		requireFailure("send peer message", response.failure, request.requestId);
		return {
			requestId: response.requestId ?? request.requestId,
			messageId: response.messageId ?? "",
			clientMessageId: response.clientMessageId ?? "",
			toAgentId: response.toAgentId ?? "",
			targetSessionId: response.targetSessionId ?? "",
			inboxSequence: response.inboxSequence ?? 0n,
			outcome: response.outcome ?? PeerMessageOutcome.UNKNOWN,
			replayed: response.replayed ?? false,
		};
	}
	async *watchPeerMailbox(signal?: AbortSignal): AsyncGenerator<AgentMessageSummary> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		for await (const response of this.#iterate(service.WatchPeerMailbox({ environmentId }, signal), signal)) {
			const result = response.result;
			if (result?.case === "failure") throw new ParentOperationError("watch peer mailbox", result.value);
			if (result?.case !== "message") throw new Error("parent mailbox watch returned no message arm");
			yield result.value;
		}
	}
	async ackPeerMessage(request: ParentPeerMessageAck, signal?: AbortSignal): Promise<ParentPeerMessageAckResult> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const response = await this.#call(service.AckPeerMessage({ environmentId, ...request }, signal), signal);
		requireFailure("ack peer message", response.failure, request.requestId);
		return {
			requestId: response.requestId ?? request.requestId,
			messageId: response.messageId ?? "",
			consumedBySessionId: response.consumedBySessionId ?? "",
			consumedAt: response.consumedAt ?? "",
			replayed: response.replayed ?? false,
		};
	}
	async interruptSession(request: ParentSessionInterrupt, signal?: AbortSignal): Promise<ParentSessionControlResult> {
		const [service, environmentId] = await this.#runtimeFor(signal);
		const response = await this.#call(
			service.InterruptSession(
				{
					environmentId,
					requestId: request.requestId,
					targetSessionId: request.targetSessionId,
					reason: request.reason ?? "",
				},
				signal,
			),
			signal,
		);
		requireFailure("interrupt session", response.failure, request.requestId);
		return {
			requestId: response.requestId ?? request.requestId,
			targetSessionId: response.targetSessionId ?? "",
			acceptedSequence: response.acceptedSequence ?? 0n,
			detail: response.detail ?? "",
			replayed: response.replayed ?? false,
		};
	}

	async #runtimeFor(signal?: AbortSignal): Promise<[ParentEnvironmentServiceClient, string]> {
		if (!this.#environmentId) {
			const sessionId = this.#staticSessionId;
			if (!sessionId) throw new Error("parent environment is not attached");
			await this.#ensureEnvironment({ root: { case: "managedSessionId", value: sessionId } }, signal);
		}
		const endpoint = await this.#connect(signal);
		return [endpoint.service, this.#requireEnvironment()];
	}
	async #ensureEnvironment(
		request: import("./generated/parent-environment.pb.js").OpenEnvironmentRequest,
		signal?: AbortSignal,
	) {
		this.#openingEnvironment ??= this.#openEnvironment(request, this.#controller.signal).finally(() => {
			this.#openingEnvironment = undefined;
		});
		return await callWithAbort(this.#openingEnvironment, signal);
	}
	async #openEnvironment(
		request: import("./generated/parent-environment.pb.js").OpenEnvironmentRequest,
		signal?: AbortSignal,
	) {
		const endpoint = await this.#connect(signal);
		const stream = endpoint.service.OpenEnvironment(request, this.#controller.signal);
		const iterator = stream[Symbol.asyncIterator]();
		let first: IteratorResult<import("./generated/parent-environment.pb.js").OpenEnvironmentResponse>;
		try {
			first = await callWithAbort(iterator.next(), signal);
		} catch (error) {
			await this.#retire(error);
			throw error;
		}
		if (first.done || !first.value.environmentId) {
			const error = new Error("parent environment stream ended before binding");
			await this.#retire(error);
			throw error;
		}
		this.#environmentId = first.value.environmentId;
		void this.#watchLease(iterator);
		return first.value;
	}
	async #watchLease(
		iterator: AsyncIterator<import("./generated/parent-environment.pb.js").OpenEnvironmentResponse>,
	): Promise<void> {
		try {
			const next = await iterator.next();
			if (!this.#closed)
				await this.#retire(
					next.done
						? new Error("parent environment lease ended")
						: new Error("parent environment emitted an unexpected second binding"),
				);
		} catch (error) {
			if (!this.#closed && !isAbortError(error)) await this.#retire(error);
		}
	}
	#requireEnvironment(): string {
		if (!this.#environmentId) throw new Error("parent environment is not attached");
		return this.#environmentId;
	}
	async #connect(signal?: AbortSignal): Promise<ParentEndpoint> {
		if (this.#failure) throw this.#failure;
		if (this.#closed) throw new Error("parent client is closed");
		if (this.#endpoint?.usable) return this.#endpoint;
		this.#connecting ??= this.#openEndpoint(this.#socketPath, this.#controller.signal)
			.then(endpoint => (this.#endpoint = endpoint))
			.catch(error => {
				this.#failure = error instanceof Error ? error : new Error(String(error));
				throw this.#failure;
			});
		return await callWithAbort(this.#connecting, signal);
	}
	async #call<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
		try {
			return await callWithAbort(pending, signal);
		} catch (error) {
			if (!isAbortError(error)) await this.#retire(error);
			throw error;
		}
	}
	async *#iterate<T>(stream: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
		try {
			for await (const value of stream) {
				signal?.throwIfAborted();
				yield value;
			}
		} catch (error) {
			if (!isAbortError(error)) await this.#retire(error);
			throw new ParentEndpointError(error);
		}
	}
	async #retire(value: unknown): Promise<void> {
		this.#failure ??= value instanceof Error ? value : new Error(String(value));
		this.#environmentId = undefined;
		this.#interactiveBinding = undefined;
		this.#interactiveSpec = undefined;
		const endpoint = this.#endpoint;
		this.#endpoint = undefined;
		await endpoint?.close();
	}
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort(abortError());
		const endpoint = this.#endpoint;
		this.#endpoint = undefined;
		this.#environmentId = undefined;
		await endpoint?.close();
	}
}

export async function openParentEndpoint(
	socketPath: string,
	signal: AbortSignal,
	dial?: DialFn,
): Promise<ParentEndpoint> {
	const transport = new ParentTransport({ socketPath, dial });
	try {
		const rpc = await transport.connect(signal);
		const service = new ParentEnvironmentServiceClient(rpc);
		return {
			service,
			get usable() {
				return transport.usable;
			},
			close: () => transport.close(),
		};
	} catch (error) {
		await transport.close();
		throw error;
	}
}

interface BoundedOperation {
	signal?: AbortSignal;
	expired(): boolean;
	dispose(): void;
}
function boundOperation(signal: AbortSignal | undefined, timeoutMs: number): BoundedOperation {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { signal, expired: () => false, dispose: () => {} };
	const controller = new AbortController();
	let expired = false;
	const timer = setTimeout(() => {
		expired = true;
		controller.abort(abortError());
	}, timeoutMs);
	timer.unref?.();
	const onAbort = () => controller.abort(abortError());
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		expired: () => expired,
		dispose: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}
function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || isStarpcAbortError(error));
}

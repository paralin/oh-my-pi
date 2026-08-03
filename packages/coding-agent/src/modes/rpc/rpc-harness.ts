import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ImageContent } from "@oh-my-pi/pi-ai";
import { canonicalJsonStringify, isRecord } from "@oh-my-pi/pi-utils";
import { sessionSidecarDir } from "../../session/session-paths";
import { isProcessIdentityLive, processStartToken } from "../../task/isolation-ownership";
import type { RpcAgentEventPayload, RpcSessionResult, RpcSessionSteerAck, RpcSessionUsage } from "./rpc-types";

const RECLAIM_LOCK_STALE_MS = 5_000;

export type RpcHarnessEvent = RpcAgentEventPayload & { sequence: number };
export type RpcHarnessPublishedEvent = RpcAgentEventPayload & { sequence?: number };
type RpcHarnessTerminalEvent = Extract<RpcHarnessEvent, { type: "session_terminal" }>;
export type RpcHarnessResult = RpcSessionResult;
export type RpcSteeringAck = RpcSessionSteerAck;

interface EventRecord {
	kind: "event";
	event: RpcHarnessEvent;
}

interface RunRecord {
	kind: "run";
	runId: string;
	sessionId: string;
}

interface SteeringRecord {
	kind: "steering";
	steeringId: string;
	steeringSequence: number;
	message: string;
	payloadIdentity?: string;
	status: "ACCEPTED" | "REJECTED";
	queuedEvent?: RpcHarnessEvent;
}

interface TerminalRecord {
	kind: "terminal";
	event: RpcHarnessTerminalEvent;
	result: RpcHarnessResult;
}

type RpcHarnessRecord = EventRecord | RunRecord | SteeringRecord | TerminalRecord;

interface PendingStreamUpdate {
	event: RpcAgentEventPayload;
	publishedEvent: RpcAgentEventPayload;
	result: PromiseWithResolvers<RpcHarnessEvent>;
}

function runClaimFile(runIndexFile: string, runId: string): string {
	const digest = Bun.SHA256.hash(runId, "hex");
	return path.join(`${runIndexFile}.locks`, digest);
}

/**
 * Derives the payload identity a `session.steer` retry has to reproduce.
 *
 * A supervisor that replays accepted steering after a restart rebuilds the
 * request from its own records, so semantically identical members can arrive in
 * another order. Hashing the canonicalized payload keeps that retry idempotent
 * and lets accepted-but-not-injected work still be redelivered, while a changed
 * message or image set moves the digest and stays rejected as a mismatch.
 */
export function rpcSteeringPayloadIdentity(message: string, images: ImageContent[] | undefined): string {
	return Bun.SHA256.hash(canonicalJsonStringify([message, images ?? []]), "hex");
}
/** Returns the durable RPC record path beside an OMP session transcript. */
export function rpcHarnessRecordFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSidecarDir(sessionFile), "rpc-ledger", "events.jsonl");
}

/**
 * Sequences RPC events, records them to an append-only JSONL file, and answers
 * replay, run-binding, steering acknowledgement, and terminal-result reads for
 * one session.
 */
export class RpcHarnessSessionOwner {
	static #runLocks = new Map<string, Promise<void>>();

	readonly sessionId: string;
	readonly #recordFile: string;
	readonly #runIndexFile: string;
	readonly #publish: ((event: RpcHarnessPublishedEvent) => void) | undefined;
	readonly #displayEvent: ((event: RpcHarnessEvent) => RpcHarnessEvent) | undefined;
	readonly #displayResult: ((result: RpcHarnessResult) => RpcHarnessResult) | undefined;
	#nextEventSequence = 1;
	#nextSteeringSequence = 1;
	#events: RpcHarnessEvent[] = [];
	#persistedEvents: RpcHarnessEvent[] = [];
	#steering = new Map<string, RpcSteeringAck>();
	#steeringMessages = new Map<string, string>();
	#steeringPayloads = new Map<string, string>();
	#steeringQueued = new Set<string>();
	#steeringInjected = new Set<string>();
	#result: RpcHarnessResult | undefined;
	#sealing = false;
	#terminalTask: Promise<RpcHarnessResult> | undefined;
	#resultWaiters: Array<{
		resolve: (result: RpcHarnessResult) => void;
		reject: (error: Error) => void;
	}> = [];
	#eventTail: Promise<void> = Promise.resolve();
	#steeringTail: Promise<void> = Promise.resolve();
	#pendingStreamUpdate: PendingStreamUpdate | undefined;
	#failure: Error | undefined;
	#ownedRunLeases = new Map<string, string>();
	#boundRunId: string | undefined;
	#sessionLeaseToken: string | undefined;

	constructor(
		sessionId: string,
		recordFile: string,
		runIndexFile: string,
		publish: ((event: RpcHarnessPublishedEvent) => void) | undefined,
		displayEvent: ((event: RpcHarnessEvent) => RpcHarnessEvent) | undefined,
		displayResult: ((result: RpcHarnessResult) => RpcHarnessResult) | undefined,
	) {
		this.sessionId = sessionId;
		this.#recordFile = recordFile;
		this.#runIndexFile = runIndexFile;
		this.#publish = publish;
		this.#displayEvent = displayEvent;
		this.#displayResult = displayResult;
	}

	/** Opens a session owner and reloads its durable RPC record. */
	static async open(
		sessionId: string,
		recordFile: string,
		publish?: (event: RpcHarnessPublishedEvent) => void,
		runIndexFile = path.join(path.dirname(recordFile), "rpc-runs.jsonl"),
		options: {
			acquireSessionLease?: boolean;
			displayEvent?: (event: RpcHarnessEvent) => RpcHarnessEvent;
			displayResult?: (result: RpcHarnessResult) => RpcHarnessResult;
		} = {},
	): Promise<RpcHarnessSessionOwner> {
		const owner = new RpcHarnessSessionOwner(
			sessionId,
			recordFile,
			runIndexFile,
			publish,
			options.displayEvent,
			options.displayResult,
		);
		let acquired = false;
		try {
			if (options.acquireSessionLease) acquired = await owner.#acquireSessionLease();
			await owner.#load();
			return owner;
		} catch (error) {
			if (acquired) await owner.#releaseSessionLease();
			throw error;
		}
	}

	/** Persists the caller's run binding before start is acknowledged. */
	async bindRun(runId: string): Promise<{ runId: string; sessionId: string; existing: boolean }> {
		if (!runId.trim()) throw new Error("run_id must not be empty");
		return this.#withRunLock(async () => {
			if (this.#boundRunId !== undefined && this.#boundRunId !== runId) {
				throw new Error(`RPC owner is already bound to run_id ${this.#boundRunId}`);
			}
			if (this.#ownedRunLeases.has(runId)) {
				return { runId, sessionId: this.sessionId, existing: true };
			}

			const acquiredSessionLease = await this.#acquireSessionLease();
			try {
				const claim = await this.#claimRun(runId);
				if (!claim.claimed && claim.sessionId !== this.sessionId) {
					throw new Error(`run_id is bound to session ${claim.sessionId}`);
				}
				await this.#acquireRunLease(runId);
				if (this.#boundRunId === undefined) {
					const record: RunRecord = { kind: "run", runId, sessionId: this.sessionId };
					await this.#appendTo(this.#recordFile, record);
				}
				this.#boundRunId = runId;
				return { runId, sessionId: this.sessionId, existing: !claim.claimed };
			} catch (error) {
				await this.#releaseRunLease(runId);
				if (acquiredSessionLease || this.#ownedRunLeases.size === 0) await this.#releaseSessionLease();
				throw error;
			}
		});
	}

	/** Releases this process's live run leases while preserving durable bindings. */
	async dispose(): Promise<void> {
		this.#flushPendingStreamUpdate();
		try {
			await this.#eventTail;
		} finally {
			await Promise.all([...this.#ownedRunLeases.keys()].map(runId => this.#releaseRunLease(runId)));
			await this.#releaseSessionLease();
		}
	}

	/** Persists one event in owner order, then publishes its display form with the same sequence. */
	appendEvent(event: RpcAgentEventPayload, publishedEvent: RpcAgentEventPayload = event): Promise<RpcHarnessEvent> {
		if (event.type !== "message_update") {
			this.#flushPendingStreamUpdate();
			return this.#queueEvent(() => this.#persistEvent(event, [publishedEvent]));
		}
		const pending = this.#pendingStreamUpdate;
		if (pending) {
			this.#queuePublication(pending.publishedEvent);
			pending.event = event;
			pending.publishedEvent = publishedEvent;
			return pending.result.promise;
		}
		const update: PendingStreamUpdate = {
			event,
			publishedEvent,
			result: Promise.withResolvers<RpcHarnessEvent>(),
		};
		this.#pendingStreamUpdate = update;
		return update.result.promise;
	}

	#flushPendingStreamUpdate(): void {
		const pending = this.#pendingStreamUpdate;
		if (!pending) return;
		this.#pendingStreamUpdate = undefined;
		this.#queueEvent(() => this.#persistEvent(pending.event, [pending.publishedEvent])).then(
			pending.result.resolve,
			pending.result.reject,
		);
	}

	#queueEvent(task: () => Promise<RpcHarnessEvent>): Promise<RpcHarnessEvent> {
		return this.#trackEventTask(this.#eventTail.then(task));
	}

	#queuePublication(event: RpcAgentEventPayload): void {
		const task = this.#eventTail.then(() => {
			if (this.#failure) throw this.#failure;
			this.#publish?.({ ...event });
		});
		this.#trackEventTask(task).catch(() => {});
	}

	async #persistEvent(event: RpcAgentEventPayload, publishedEvents: RpcAgentEventPayload[]): Promise<RpcHarnessEvent> {
		if (this.#failure) throw this.#failure;
		if (this.#result) throw new Error("cannot append an event after the terminal result");
		const sequence = this.#nextEventSequence++;
		const sequenced: RpcHarnessEvent = { ...event, sequence };
		await this.#append({ kind: "event", event: sequenced });
		this.#persistedEvents.push(sequenced);
		this.#events.push(this.#displayEvent?.(sequenced) ?? sequenced);
		for (const [index, publishedEvent] of publishedEvents.entries()) {
			this.#publish?.(
				index === publishedEvents.length - 1 ? { ...publishedEvent, sequence } : { ...publishedEvent },
			);
		}
		return sequenced;
	}

	/** Replays durable events strictly after the requested sequence. */
	async replay(afterSequence = 0, limit?: number): Promise<RpcHarnessEvent[]> {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
			throw new Error("after_sequence must be a non-negative integer");
		if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000))
			throw new Error("limit must be an integer from 1 to 1000");
		this.#flushPendingStreamUpdate();
		await this.#eventTail;
		const events = this.#events.filter(event => event.sequence > afterSequence);
		return limit === undefined ? events : events.slice(0, limit);
	}

	/** Returns provider-safe event values for internal result aggregation. */
	async replayPersisted(): Promise<RpcHarnessEvent[]> {
		this.#flushPendingStreamUpdate();
		await this.#eventTail;
		return [...this.#persistedEvents];
	}

	get latestSequence(): number {
		return this.#nextEventSequence - 1;
	}

	/** Records queued and injected steering while making retries idempotent. */
	steer(
		steeringId: string,
		message: string,
		deliver: () => Promise<void>,
		payloadIdentity = message,
	): Promise<RpcSteeringAck> {
		if (!steeringId.trim()) throw new Error("steering_id must not be empty");
		const task = this.#steeringTail.then(() => this.#steer(steeringId, message, payloadIdentity, deliver));
		this.#steeringTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	/** Records steering injection after its user message reaches durable session history. */
	markSteeringInjected(steeringId: string): Promise<void> {
		const task = this.#steeringTail.then(async () => {
			const prior = this.#steering.get(steeringId);
			if (prior?.status !== "ACCEPTED" || this.#steeringInjected.has(steeringId)) return;
			await this.appendEvent({
				type: "steering_injected",
				steeringId,
				steeringSequence: prior.steeringSequence,
			});
			this.#steeringInjected.add(steeringId);
		});
		this.#steeringTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	/** Prevents new episode work while earlier durable boundaries finish. */
	beginResultSeal(): void {
		if (!this.#result) this.#sealing = true;
	}
	/** Reopens episode work when draining accepted delivery started a continuation. */
	cancelResultSeal(): void {
		if (!this.#result && !this.#terminalTask) this.#sealing = false;
	}

	/** Persists the terminal event and immutable result before publishing terminal state. */
	completeResult(input: Omit<RpcHarnessResult, "resultId" | "terminalSequence">): Promise<RpcHarnessResult> {
		if (this.#result) return Promise.resolve(this.#result);
		if (this.#terminalTask) return this.#terminalTask;
		this.beginResultSeal();
		this.#flushPendingStreamUpdate();
		const task = this.#eventTail.then(async () => {
			if (this.#result) return this.#result;
			if (this.#failure) throw this.#failure;
			const terminalSequence = this.#nextEventSequence++;
			const resultId = `${this.sessionId}:result`;
			const usage: RpcSessionUsage = { ...input.usage };
			const terminalEvent: RpcHarnessTerminalEvent = {
				type: "session_terminal",
				sessionId: this.sessionId,
				outcome: input.outcome,
				stopReason: input.stopReason,
				finalMessage: input.finalMessage,
				usage,
				resultId,
				terminalSequence,
				sequence: terminalSequence,
			};
			const persistedResult: RpcHarnessResult = Object.freeze({
				...input,
				usage: Object.freeze(usage),
				resultId,
				terminalSequence,
			});
			await this.#append({ kind: "terminal", event: terminalEvent, result: persistedResult });
			const result = Object.freeze(this.#displayResult?.(persistedResult) ?? persistedResult);
			const displayEvent: RpcHarnessEvent = { ...terminalEvent, finalMessage: result.finalMessage };
			this.#persistedEvents.push(terminalEvent);
			this.#events.push(displayEvent);
			this.#result = result;
			for (const waiter of this.#resultWaiters) waiter.resolve(result);
			this.#resultWaiters = [];
			this.#publish?.(displayEvent);
			return result;
		});
		this.#terminalTask = this.#trackEventTask(task);
		return this.#terminalTask;
	}

	/** Blocks until terminal and returns the same immutable record on every call. */
	waitResult(): Promise<RpcHarnessResult> {
		if (this.#result) return Promise.resolve(this.#result);
		if (this.#failure) return Promise.reject(this.#failure);
		const { promise, resolve, reject } = Promise.withResolvers<RpcHarnessResult>();
		this.#resultWaiters.push({ resolve, reject });
		return promise;
	}

	get hasResult(): boolean {
		return this.#result !== undefined;
	}

	/**
	 * Whether a terminal result can still be recorded. Only a latched append
	 * failure takes sealing away; a failure on a path that never reached the
	 * ledger — a session transcript flush, for one — leaves the run sealable.
	 */
	get canSealResult(): boolean {
		return this.#failure === undefined;
	}

	isBoundToRun(runId: string): boolean {
		return this.#boundRunId === runId;
	}

	assertAcceptingWork(): void {
		if (this.#result || this.#sealing) throw new Error("run result is already sealed");
	}

	async #load(): Promise<void> {
		await this.#loadFile(this.#recordFile);
		await this.#repairSteeringQueuedEvents();
	}

	async #loadFile(file: string): Promise<void> {
		const text = await fs.readFile(file, "utf8").catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (text === undefined) return;
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (!line.trim()) continue;
			let record: RpcHarnessRecord;
			try {
				record = JSON.parse(line);
			} catch (error) {
				if (index === lines.length - 1 && !text.endsWith("\n")) {
					const validPrefix = text.slice(0, text.lastIndexOf("\n") + 1);
					await fs.truncate(file, Buffer.byteLength(validPrefix, "utf8"));
					return;
				}
				throw error;
			}
			if (record.kind === "run") {
				if (record.sessionId !== this.sessionId) {
					throw new Error(`session ledger run is bound to session ${record.sessionId}`);
				}
				if (this.#boundRunId !== undefined && this.#boundRunId !== record.runId) {
					throw new Error(`session ledger contains multiple run IDs: ${this.#boundRunId}, ${record.runId}`);
				}
				this.#boundRunId = record.runId;
				continue;
			}
			if (record.kind === "event") {
				this.#persistedEvents.push(record.event);
				this.#events.push(this.#displayEvent?.(record.event) ?? record.event);
				this.#nextEventSequence = Math.max(this.#nextEventSequence, record.event.sequence + 1);
				if (record.event.type === "steering_injected") this.#steeringInjected.add(record.event.steeringId);
				if (record.event.type === "steering_queued") {
					this.#steeringMessages.set(record.event.steeringId, record.event.message);
					this.#steeringQueued.add(record.event.steeringId);
				}
			} else if (record.kind === "steering") {
				this.#nextSteeringSequence = Math.max(this.#nextSteeringSequence, record.steeringSequence + 1);
				this.#steering.set(record.steeringId, {
					status: record.status,
					steeringSequence: record.steeringSequence,
				});
				this.#steeringMessages.set(record.steeringId, record.message);
				if (record.payloadIdentity !== undefined) {
					this.#steeringPayloads.set(record.steeringId, record.payloadIdentity);
				}
				if (record.queuedEvent) {
					this.#persistedEvents.push(record.queuedEvent);
					this.#events.push(this.#displayEvent?.(record.queuedEvent) ?? record.queuedEvent);
					this.#nextEventSequence = Math.max(this.#nextEventSequence, record.queuedEvent.sequence + 1);
					this.#steeringQueued.add(record.steeringId);
				}
			} else if (record.kind === "terminal") {
				const persistedResult = Object.freeze({
					...record.result,
					usage: Object.freeze({ ...record.result.usage }),
				});
				const result = Object.freeze(this.#displayResult?.(persistedResult) ?? persistedResult);
				this.#persistedEvents.push(record.event);
				this.#events.push(
					this.#displayEvent?.({ ...record.event, finalMessage: result.finalMessage }) ?? {
						...record.event,
						finalMessage: result.finalMessage,
					},
				);
				this.#nextEventSequence = Math.max(this.#nextEventSequence, record.event.sequence + 1);
				this.#result = result;
			}
		}
		if (!text.endsWith("\n") && text.trim()) await fs.appendFile(file, "\n");
	}

	async #repairSteeringQueuedEvents(): Promise<void> {
		for (const [steeringId, ack] of this.#steering) {
			if (ack.status !== "ACCEPTED" || this.#steeringQueued.has(steeringId)) continue;
			const message = this.#steeringMessages.get(steeringId);
			if (message === undefined) continue;
			const event: RpcHarnessEvent = {
				type: "steering_queued",
				steeringId,
				steeringSequence: ack.steeringSequence,
				message,
				sequence: this.#nextEventSequence++,
			};
			await this.#append({ kind: "event", event });
			this.#persistedEvents.push(event);
			this.#events.push(this.#displayEvent?.(event) ?? event);
			this.#steeringQueued.add(steeringId);
		}
	}

	async #steer(
		steeringId: string,
		message: string,
		payloadIdentity: string,
		deliver: () => Promise<void>,
	): Promise<RpcSteeringAck> {
		const prior = this.#steering.get(steeringId);
		const priorPayload = this.#steeringPayloads.get(steeringId);
		const priorMessage = this.#steeringMessages.get(steeringId);
		if (
			(priorPayload !== undefined && priorPayload !== payloadIdentity) ||
			(priorPayload === undefined && priorMessage !== undefined && priorMessage !== message)
		) {
			throw new Error(`steering_id payload does not match the original request: ${steeringId}`);
		}
		if (prior && prior.status === "ACCEPTED" && this.#steeringInjected.has(steeringId))
			return { ...prior, status: "DUPLICATE" };
		const steeringSequence = prior?.steeringSequence ?? this.#nextSteeringSequence++;
		const accepted: RpcSteeringAck = { status: "ACCEPTED", steeringSequence };
		if (prior?.status !== "ACCEPTED") {
			await this.#queueEvent(async () => {
				if (this.#failure) throw this.#failure;
				if (this.#result) throw new Error("cannot append steering after the terminal result");
				const event: RpcHarnessEvent = {
					type: "steering_queued",
					steeringId,
					steeringSequence,
					message,
					sequence: this.#nextEventSequence++,
				};
				await this.#append({
					kind: "steering",
					steeringId,
					steeringSequence,
					status: "ACCEPTED",
					message,
					payloadIdentity,
					queuedEvent: event,
				});
				this.#persistedEvents.push(event);
				this.#events.push(this.#displayEvent?.(event) ?? event);
				this.#publish?.(event);
				return event;
			});
			this.#steering.set(steeringId, accepted);
			this.#steeringMessages.set(steeringId, message);
			this.#steeringPayloads.set(steeringId, payloadIdentity);
			this.#steeringQueued.add(steeringId);
		}
		try {
			await deliver();
			return accepted;
		} catch {
			const rejected: RpcSteeringAck = { status: "REJECTED", steeringSequence };
			await this.#trackEventTask(
				this.#eventTail.then(() =>
					this.#append({
						kind: "steering",
						steeringId,
						steeringSequence,
						status: "REJECTED",
						message,
						payloadIdentity,
					}),
				),
			);
			this.#steering.set(steeringId, rejected);
			await this.appendEvent({ type: "steering_rejected", steeringId, steeringSequence });
			return rejected;
		}
	}

	async #withRunLock<T>(callback: () => Promise<T>): Promise<T> {
		const prior = RpcHarnessSessionOwner.#runLocks.get(this.#runIndexFile) ?? Promise.resolve();
		const { promise: current, resolve: release } = Promise.withResolvers<void>();
		const chain = prior.then(() => current);
		RpcHarnessSessionOwner.#runLocks.set(this.#runIndexFile, chain);
		await prior;
		try {
			return await callback();
		} finally {
			release();
			if (RpcHarnessSessionOwner.#runLocks.get(this.#runIndexFile) === chain)
				RpcHarnessSessionOwner.#runLocks.delete(this.#runIndexFile);
		}
	}

	async #claimRun(runId: string): Promise<{ claimed: boolean; sessionId: string }> {
		const claimFile = runClaimFile(this.#runIndexFile, runId);
		const claimDir = path.dirname(claimFile);
		await fs.mkdir(claimDir, { recursive: true, mode: 0o700 });
		const stagedClaim = path.join(claimDir, `.${path.basename(claimFile)}.${process.pid}.${crypto.randomUUID()}.tmp`);
		await fs.writeFile(stagedClaim, this.sessionId, { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			try {
				await fs.link(stagedClaim, claimFile);
				return { claimed: true, sessionId: this.sessionId };
			} catch (error) {
				if (!isRecord(error) || error.code !== "EEXIST") throw error;
				const sessionId = (await fs.readFile(claimFile, "utf8")).trim();
				if (!sessionId) throw new Error(`run_id claim is incomplete: ${runId}`);
				return { claimed: false, sessionId };
			}
		} finally {
			await fs.rm(stagedClaim, { force: true });
		}
	}

	async #acquireSessionLease(): Promise<boolean> {
		if (this.#sessionLeaseToken) return false;
		this.#sessionLeaseToken = await this.#acquireLease(
			`${this.#recordFile}.owner`,
			`session ledger already has a live owner: ${this.sessionId}`,
		);
		return true;
	}

	async #acquireRunLease(runId: string): Promise<void> {
		const leaseFile = `${runClaimFile(this.#runIndexFile, runId)}.owner`;
		const token = await this.#acquireLease(leaseFile, `run_id already has a live owner: ${runId}`);
		this.#ownedRunLeases.set(runId, token);
	}

	async #acquireLease(leaseFile: string, busyMessage: string): Promise<string> {
		await fs.mkdir(path.dirname(leaseFile), { recursive: true, mode: 0o700 });
		const reclaimLock = `${leaseFile}.reclaim`;
		const token = crypto.randomUUID();
		const startToken = await processStartToken(process.pid);
		const content = JSON.stringify({ pid: process.pid, ...(startToken ? { startToken } : {}), token });
		for (;;) {
			if (await this.#publishExclusiveFile(leaseFile, content)) return token;
			let leaseText: string;
			try {
				leaseText = await fs.readFile(leaseFile, "utf8");
			} catch (readError) {
				if (isRecord(readError) && readError.code === "ENOENT") continue;
				throw readError;
			}
			let lease: unknown;
			try {
				lease = JSON.parse(leaseText);
			} catch {
				lease = undefined;
			}
			if (
				isRecord(lease) &&
				typeof lease.pid === "number" &&
				Number.isSafeInteger(lease.pid) &&
				lease.pid > 0 &&
				(await isProcessIdentityLive(
					lease.pid,
					typeof lease.startToken === "string" ? lease.startToken : undefined,
				))
			) {
				throw new Error(busyMessage);
			}
			if (!(await this.#acquireReclaimLock(reclaimLock, content))) {
				const retry = Promise.withResolvers<void>();
				setImmediate(retry.resolve);
				await retry.promise;
				continue;
			}
			try {
				const current = await fs.readFile(leaseFile, "utf8").catch(readError => {
					if (isRecord(readError) && readError.code === "ENOENT") return undefined;
					throw readError;
				});
				if (current !== leaseText) continue;
				await fs.rm(leaseFile);
				if (await this.#publishExclusiveFile(leaseFile, content)) return token;
			} finally {
				await fs.rm(reclaimLock, { recursive: true, force: true });
			}
		}
	}

	async #publishExclusiveFile(file: string, content: string): Promise<boolean> {
		const staging = path.join(
			path.dirname(file),
			`.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
		);
		await fs.writeFile(staging, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		try {
			try {
				await fs.link(staging, file);
				return true;
			} catch (error) {
				if (!isRecord(error) || error.code !== "EEXIST") throw error;
				return false;
			}
		} finally {
			await fs.rm(staging, { force: true });
		}
	}

	async #acquireReclaimLock(reclaimLock: string, content: string): Promise<boolean> {
		const ownerFile = path.join(reclaimLock, "owner.json");
		try {
			await fs.mkdir(reclaimLock, { mode: 0o700 });
			try {
				await fs.writeFile(ownerFile, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			} catch (error) {
				await fs.rm(reclaimLock, { recursive: true, force: true });
				throw error;
			}
			return true;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
		const stat = await fs.stat(reclaimLock).catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!stat) return false;
		const existing = await fs.readFile(stat.isDirectory() ? ownerFile : reclaimLock, "utf8").catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		let owner: unknown;
		try {
			owner = existing === undefined ? undefined : JSON.parse(existing);
		} catch {
			owner = undefined;
		}
		if (
			isRecord(owner) &&
			typeof owner.pid === "number" &&
			Number.isSafeInteger(owner.pid) &&
			owner.pid > 0 &&
			(await isProcessIdentityLive(owner.pid, typeof owner.startToken === "string" ? owner.startToken : undefined))
		) {
			return false;
		}
		if (existing === undefined && Date.now() - stat.mtimeMs < RECLAIM_LOCK_STALE_MS) return false;
		const abandoned = `${reclaimLock}.${crypto.randomUUID()}.stale`;
		try {
			await fs.rename(reclaimLock, abandoned);
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
			return false;
		}
		await fs.rm(abandoned, { recursive: true, force: true });
		return false;
	}

	async #releaseRunLease(runId: string): Promise<void> {
		const token = this.#ownedRunLeases.get(runId);
		if (!token) return;
		try {
			await this.#releaseLease(`${runClaimFile(this.#runIndexFile, runId)}.owner`, token);
		} finally {
			this.#ownedRunLeases.delete(runId);
		}
	}

	async #releaseSessionLease(): Promise<void> {
		const token = this.#sessionLeaseToken;
		if (!token) return;
		try {
			await this.#releaseLease(`${this.#recordFile}.owner`, token);
		} finally {
			this.#sessionLeaseToken = undefined;
		}
	}

	async #releaseLease(leaseFile: string, token: string): Promise<void> {
		try {
			const lease: unknown = JSON.parse(await fs.readFile(leaseFile, "utf8"));
			if (isRecord(lease) && lease.token === token) await fs.rm(leaseFile, { force: true });
		} catch (error) {
			if (!isRecord(error) || error.code !== "ENOENT") throw error;
		}
	}

	#trackEventTask<T>(task: Promise<T>): Promise<T> {
		const tracked = task.catch(error => {
			this.#failure ??= error instanceof Error ? error : new Error(String(error));
			for (const waiter of this.#resultWaiters) waiter.reject(this.#failure);
			this.#resultWaiters = [];
			throw error;
		});
		this.#eventTail = tracked.then(
			() => undefined,
			() => undefined,
		);
		return tracked;
	}

	async #append(record: RpcHarnessRecord): Promise<void> {
		await this.#appendTo(this.#recordFile, record);
	}

	async #appendTo(file: string, record: RpcHarnessRecord): Promise<void> {
		await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	}
}

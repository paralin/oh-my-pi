import * as fs from "node:fs/promises";
import * as path from "node:path";

import { sessionSteeringDirForSessionFile } from "../../session/session-steering";
import type { RpcAgentEventPayload, RpcSessionResult, RpcSessionSteerAck, RpcSessionUsage } from "./rpc-types";

export type RpcHarnessEvent = RpcAgentEventPayload & { sequence: number };
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
	status: "ACCEPTED" | "REJECTED";
}

interface ResultRecord {
	kind: "result";
	result: RpcHarnessResult;
}

type RpcHarnessRecord = EventRecord | RunRecord | SteeringRecord | ResultRecord;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Returns the durable RPC record path beside an OMP session transcript. */
export function rpcHarnessRecordFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSteeringDirForSessionFile(sessionFile), "rpc.jsonl");
}

/** Owns RPC event ordering, replay, idempotency, and terminal state for one session. */
export class RpcHarnessSessionOwner {
	static #runLocks = new Map<string, Promise<void>>();

	readonly sessionId: string;
	readonly #recordFile: string;
	readonly #runIndexFile: string;
	readonly #publish: ((event: RpcHarnessEvent) => void) | undefined;
	#nextEventSequence = 1;
	#nextSteeringSequence = 1;
	#events: RpcHarnessEvent[] = [];
	#runs = new Map<string, string>();
	#steering = new Map<string, RpcSteeringAck>();
	#steeringInjected = new Set<string>();
	#result: RpcHarnessResult | undefined;
	#resultWaiters: Array<(result: RpcHarnessResult) => void> = [];
	#eventTail: Promise<void> = Promise.resolve();
	#steeringTail: Promise<void> = Promise.resolve();
	#failure: Error | undefined;

	private constructor(
		sessionId: string,
		recordFile: string,
		runIndexFile: string,
		publish: ((event: RpcHarnessEvent) => void) | undefined,
	) {
		this.sessionId = sessionId;
		this.#recordFile = recordFile;
		this.#runIndexFile = runIndexFile;
		this.#publish = publish;
	}

	/** Constructs an RpcHarnessSessionOwner and reloads its durable RPC record. */
	static async open(
		sessionId: string,
		recordFile: string,
		publish?: (event: RpcHarnessEvent) => void,
		runIndexFile = path.join(path.dirname(recordFile), "rpc-runs.jsonl"),
	): Promise<RpcHarnessSessionOwner> {
		const owner = new RpcHarnessSessionOwner(sessionId, recordFile, runIndexFile, publish);
		await owner.#load();
		return owner;
	}

	/** Persists the caller's run binding before start is acknowledged. */
	async bindRun(runId: string): Promise<{ runId: string; sessionId: string; existing: boolean }> {
		if (!runId.trim()) throw new Error("run_id must not be empty");
		return this.#withRunLock(async () => {
			const existingSessionId = this.#runs.get(runId);
			if (existingSessionId !== undefined) {
				if (existingSessionId !== this.sessionId)
					throw new Error(`run_id is bound to session ${existingSessionId}`);
				return { runId, sessionId: this.sessionId, existing: true };
			}

			const claim = await this.#claimRun(runId);
			if (!claim.claimed) {
				if (claim.sessionId !== this.sessionId) throw new Error(`run_id is bound to session ${claim.sessionId}`);
				this.#runs.set(runId, this.sessionId);
				return { runId, sessionId: this.sessionId, existing: true };
			}

			const record: RunRecord = { kind: "run", runId, sessionId: this.sessionId };
			await this.#appendTo(this.#runIndexFile, record);
			this.#runs.set(runId, this.sessionId);
			if (this.#runIndexFile !== this.#recordFile) await this.#appendTo(this.#recordFile, record);
			return { runId, sessionId: this.sessionId, existing: false };
		});
	}

	/** Appends one event through #eventTail in call order and assigns its sequence before publication. */
	appendEvent(event: RpcAgentEventPayload): Promise<RpcHarnessEvent> {
		const task = this.#eventTail.then(async () => {
			if (this.#failure) throw this.#failure;
			if (this.#result) throw new Error("cannot append an event after the terminal result");
			const sequenced: RpcHarnessEvent = { ...event, sequence: this.#nextEventSequence++ };
			await this.#append({ kind: "event", event: sequenced });
			this.#events.push(sequenced);
			this.#publish?.(sequenced);
			return sequenced;
		});
		return this.#trackEventTask(task);
	}

	/** Replays durable events strictly after the requested sequence. */
	async replay(afterSequence = 0): Promise<RpcHarnessEvent[]> {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
			throw new Error("after_sequence must be a non-negative integer");
		await this.#eventTail;
		return this.#events.filter(event => event.sequence > afterSequence);
	}

	/** Records queued and injected steering while making retries idempotent. */
	steer(steeringId: string, message: string, deliver: () => Promise<void>): Promise<RpcSteeringAck> {
		if (!steeringId.trim()) throw new Error("steering_id must not be empty");
		const task = this.#steeringTail.then(() => this.#steer(steeringId, message, deliver));
		this.#steeringTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	/** Persists the terminal event and immutable result before publishing terminal state. */
	completeResult(input: Omit<RpcHarnessResult, "resultId" | "terminalSequence">): Promise<RpcHarnessResult> {
		const task = this.#eventTail.then(async () => {
			if (this.#result) return this.#result;
			if (this.#failure) throw this.#failure;
			const terminalSequence = this.#nextEventSequence++;
			const resultId = `${this.sessionId}:result`;
			const usage: RpcSessionUsage = { ...input.usage };
			const terminalEvent: RpcHarnessEvent = {
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
			await this.#append({ kind: "event", event: terminalEvent });
			this.#events.push(terminalEvent);
			const result: RpcHarnessResult = Object.freeze({
				...input,
				usage: Object.freeze(usage),
				resultId,
				terminalSequence,
			});
			await this.#append({ kind: "result", result });
			this.#result = result;
			for (const resolve of this.#resultWaiters) resolve(result);
			this.#resultWaiters = [];
			this.#publish?.(terminalEvent);
			return result;
		});
		return this.#trackEventTask(task);
	}

	/** Blocks until terminal and returns the same immutable record on every call. */
	waitResult(): Promise<RpcHarnessResult> {
		if (this.#result) return Promise.resolve(this.#result);
		const { promise, resolve } = Promise.withResolvers<RpcHarnessResult>();
		this.#resultWaiters.push(resolve);
		return promise;
	}

	get hasResult(): boolean {
		return this.#result !== undefined;
	}

	async #load(): Promise<void> {
		await this.#loadFile(this.#recordFile);
		if (this.#runIndexFile !== this.#recordFile) await this.#loadFile(this.#runIndexFile, true);
	}

	async #loadFile(file: string, runsOnly = false): Promise<void> {
		const text = await fs.readFile(file, "utf8").catch(error => {
			if (isRecord(error) && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (text === undefined) return;
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const record = JSON.parse(line) as RpcHarnessRecord;
			if (record.kind === "run") {
				this.#runs.set(record.runId, record.sessionId);
				continue;
			}
			if (runsOnly) continue;
			if (record.kind === "event") {
				this.#events.push(record.event);
				this.#nextEventSequence = Math.max(this.#nextEventSequence, record.event.sequence + 1);
				if (record.event.type === "steering_injected") this.#steeringInjected.add(record.event.steeringId);
			} else if (record.kind === "steering") {
				this.#nextSteeringSequence = Math.max(this.#nextSteeringSequence, record.steeringSequence + 1);
				this.#steering.set(record.steeringId, {
					status: record.status,
					steeringSequence: record.steeringSequence,
				});
			} else if (record.kind === "result") {
				this.#result = Object.freeze({ ...record.result, usage: Object.freeze({ ...record.result.usage }) });
			}
		}
	}

	async #steer(steeringId: string, message: string, deliver: () => Promise<void>): Promise<RpcSteeringAck> {
		const prior = this.#steering.get(steeringId);
		if (prior && prior.status === "ACCEPTED" && this.#steeringInjected.has(steeringId))
			return { ...prior, status: "DUPLICATE" };
		const steeringSequence = prior?.steeringSequence ?? this.#nextSteeringSequence++;
		const accepted: RpcSteeringAck = { status: "ACCEPTED", steeringSequence };
		await this.#append({ kind: "steering", steeringId, steeringSequence, status: "ACCEPTED" });
		this.#steering.set(steeringId, accepted);
		await this.appendEvent({ type: "steering_queued", steeringId, steeringSequence, message });
		try {
			await deliver();
			await this.appendEvent({ type: "steering_injected", steeringId, steeringSequence });
			this.#steeringInjected.add(steeringId);
			return accepted;
		} catch {
			const rejected: RpcSteeringAck = { status: "REJECTED", steeringSequence };
			await this.#append({ kind: "steering", steeringId, steeringSequence, status: "REJECTED" });
			this.#steering.set(steeringId, rejected);
			await this.appendEvent({ type: "steering_rejected", steeringId, steeringSequence });
			return rejected;
		}
	}

	async #withRunLock<T>(callback: () => Promise<T>): Promise<T> {
		const prior = RpcHarnessSessionOwner.#runLocks.get(this.#runIndexFile) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => {
			release = resolve;
		});
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
		const claimFile = path.join(`${this.#runIndexFile}.locks`, Buffer.from(runId).toString("base64url"));
		await fs.mkdir(path.dirname(claimFile), { recursive: true, mode: 0o700 });
		try {
			await fs.writeFile(claimFile, this.sessionId, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return { claimed: true, sessionId: this.sessionId };
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			const sessionId = (await fs.readFile(claimFile, "utf8")).trim();
			if (!sessionId) throw new Error(`run_id claim is incomplete: ${runId}`);
			return { claimed: false, sessionId };
		}
	}

	#trackEventTask<T>(task: Promise<T>): Promise<T> {
		const tracked = task.catch(error => {
			this.#failure ??= error instanceof Error ? error : new Error(String(error));
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

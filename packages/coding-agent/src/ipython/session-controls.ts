import { randomUUID } from "node:crypto";
import type { IpythonHostHandler, IpythonHostHandlers, IpythonHostRequest } from "./controller";
import type { HarnessKind, HarnessService, HarnessUpdateInput, HarnessWriteInput } from "./harness-service";

export interface SessionGoalResponse {
	goal: unknown;
	remaining_tokens: number | null;
	completion_budget_report: string | null;
}

export interface SessionControlHost {
	sessionId(): string;
	isDisposed(): boolean;
	goalGet(): SessionGoalResponse;
	goalCreate(objective: string, tokenBudget?: number): Promise<SessionGoalResponse>;
	goalComplete(): Promise<SessionGoalResponse>;
	goalPause?(reason: string): Promise<SessionGoalResponse>;
	goalResume?(): Promise<SessionGoalResponse>;
	contextUsage(): { tokens: number | null; contextWindow: number | null; percent: number | null };
	waitForIdle(): Promise<void>;
	runCompaction(instructions?: string): Promise<void>;
	resumeAfterCompaction(): Promise<void>;
	resumeRefinement(instructions: string | undefined, global: boolean): Promise<void>;
	createCheckpoint(label?: string): Promise<Record<string, unknown>>;
	hasCheckpoint(): boolean;
	runRewind(report: string): Promise<void>;
	applyTodo(operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
	deliverHeartbeat(heartbeat: RlmHeartbeat): Promise<void>;
	reportFailure(message: string): void;
}

export interface RlmHeartbeat {
	id: string;
	status: "active" | "paused" | "cancelled";
	label: string | null;
	delivery_mode: "steer" | "follow_up";
	instruction: string;
	schedule: string;
	created_at: string;
	updated_at: string;
	next_run_at: string | null;
	last_run_at: string | null;
	last_error: string | null;
	run_count: number;
}

export interface OmpSessionControlServiceOptions {
	host: SessionControlHost;
	harness: HarnessService;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface HeartbeatState {
	value: RlmHeartbeat;
	intervalMs: number;
	timer?: ReturnType<typeof setTimeout>;
	sessionId: string;
}

const MAX_INSTRUCTION_CHARS = 16_384;
const MAX_LABEL_CHARS = 128;
const DEFAULT_HEARTBEAT_INTERVAL = "5m";
const MIN_HEARTBEAT_MS = 1_000;
const MAX_HEARTBEAT_MS = 24 * 60 * 60 * 1_000;

function aborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Session control request aborted");
	}
}

function requiredString(value: unknown, label: string, max = MAX_INSTRUCTION_CHARS): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
	if (value.length > max) throw new Error(`${label} must be at most ${max} characters`);
	return value.trim();
}

function optionalString(value: unknown, label: string, max = MAX_INSTRUCTION_CHARS): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requiredString(value, label, max);
}

function boolean(value: unknown, fallback: boolean, label: string): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
	return value;
}

function integer(value: unknown, label: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
	}
	return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
	if (value === undefined || value === null) return undefined;
	return record(value, label);
}

function assertFields(payload: Record<string, unknown>, allowed: readonly string[], operation: string): void {
	const names = new Set(["type", ...allowed]);
	const unknown = Object.keys(payload).filter(key => !names.has(key));
	if (unknown.length > 0) throw new Error(`${operation} received unknown field(s): ${unknown.sort().join(", ")}`);
}

function harnessKind(value: unknown): HarnessKind {
	if (value !== "prompt" && value !== "memory" && value !== "skill" && value !== "subagent") {
		throw new Error('harness kind must be "prompt", "memory", "skill", or "subagent"');
	}
	return value;
}

function parseInterval(value: string): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/i.exec(value);
	if (!match) throw new Error('heartbeat interval must look like "30s", "5m", or "1h"');
	const amount = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
	const milliseconds = Math.round(amount * multiplier);
	if (!Number.isFinite(milliseconds) || milliseconds < MIN_HEARTBEAT_MS || milliseconds > MAX_HEARTBEAT_MS) {
		throw new Error("heartbeat interval must be from 1 second to 24 hours");
	}
	return milliseconds;
}

function cloneHeartbeat(value: RlmHeartbeat): RlmHeartbeat {
	return { ...value };
}

export class OmpSessionControlService {
	readonly #host: SessionControlHost;
	readonly #harness: HarnessService;
	readonly #now: () => number;
	readonly #setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	readonly #clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
	readonly #heartbeats = new Map<string, HeartbeatState>();
	readonly #deferred = new Set<Promise<void>>();
	readonly #lifecycle = new AbortController();
	#compactPending = false;
	#compactInFlight = false;
	#refinePending = false;
	#refineInFlight = false;
	#rewindPending = false;
	#rewindInFlight = false;

	constructor(options: OmpSessionControlServiceOptions) {
		this.#host = options.host;
		this.#harness = options.harness;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? setTimeout;
		this.#clearTimer = options.clearTimer ?? clearTimeout;
	}

	get harness(): HarnessService {
		return this.#harness;
	}

	goalGet(): SessionGoalResponse {
		return this.#host.goalGet();
	}

	async goalCreate(
		objective: string,
		tokenBudget: number | undefined,
		signal?: AbortSignal,
	): Promise<SessionGoalResponse> {
		aborted(signal);
		return await this.#host.goalCreate(objective, tokenBudget);
	}

	async goalComplete(signal?: AbortSignal): Promise<SessionGoalResponse> {
		aborted(signal);
		return await this.#host.goalComplete();
	}

	async goalPause(reason: string, signal?: AbortSignal): Promise<SessionGoalResponse> {
		aborted(signal);
		if (!this.#host.goalPause) throw new Error("Goal pause is unavailable in this session");
		return await this.#host.goalPause(reason);
	}

	async goalResume(signal?: AbortSignal): Promise<SessionGoalResponse> {
		aborted(signal);
		if (!this.#host.goalResume) throw new Error("Goal resume is unavailable in this session");
		return await this.#host.goalResume();
	}

	compactStatus(): Record<string, unknown> {
		const usage = this.#host.contextUsage();
		return {
			tokens: usage.tokens,
			context_window: usage.contextWindow,
			percent: usage.percent,
			scheduled: this.#compactPending,
			in_flight: this.#compactInFlight,
		};
	}

	scheduleCompaction(instructions: string | undefined, request: IpythonHostRequest): Record<string, unknown> {
		aborted(request.signal);
		if (request.origin !== "model") {
			return { scheduled: false, reason: "compaction can only be scheduled from an active model turn" };
		}
		if (this.#compactPending || this.#compactInFlight) {
			return { scheduled: false, reason: "compaction is already scheduled" };
		}
		this.#compactPending = true;
		const sessionId = this.#host.sessionId();
		this.#trackDeferred(
			this.#runDeferred(
				"compaction",
				sessionId,
				() => {
					this.#compactPending = false;
					this.#compactInFlight = true;
				},
				async () => {
					await this.#host.runCompaction(instructions);
					await this.#host.resumeAfterCompaction();
				},
				() => {
					this.#compactPending = false;
					this.#compactInFlight = false;
				},
			),
		);
		return {
			scheduled: true,
			note: "Compaction runs when the current turn ends; the session resumes automatically afterwards.",
		};
	}

	refineStatus(): Record<string, unknown> {
		return { pending: this.#refinePending, in_flight: this.#refineInFlight };
	}

	scheduleRefinement(
		instructions: string | undefined,
		global: boolean,
		request: IpythonHostRequest,
	): Record<string, unknown> {
		aborted(request.signal);
		if (request.origin !== "model") {
			return { scheduled: false, reason: "refinement can only be scheduled from an active model turn" };
		}
		if (this.#refinePending || this.#refineInFlight) {
			return { scheduled: false, reason: "refinement is already scheduled" };
		}
		this.#refinePending = true;
		const sessionId = this.#host.sessionId();
		this.#trackDeferred(
			this.#runDeferred(
				"refinement",
				sessionId,
				() => {
					this.#refinePending = false;
					this.#refineInFlight = true;
				},
				async () => await this.#host.resumeRefinement(instructions, global),
				() => {
					this.#refinePending = false;
					this.#refineInFlight = false;
				},
			),
		);
		return {
			scheduled: true,
			note: "Refinement runs when the current turn ends; the session resumes automatically afterwards.",
		};
	}

	#trackDeferred(task: Promise<void>): void {
		this.#deferred.add(task);
		void task.finally(() => this.#deferred.delete(task));
	}

	async waitForDeferred(): Promise<void> {
		while (this.#deferred.size > 0) await Promise.allSettled([...this.#deferred]);
	}

	async #waitForIdleOrAbort(): Promise<void> {
		if (this.#lifecycle.signal.aborted) throw this.#lifecycle.signal.reason;
		const stopped = Promise.withResolvers<void>();
		const onAbort = () => stopped.reject(this.#lifecycle.signal.reason);
		this.#lifecycle.signal.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([this.#host.waitForIdle(), stopped.promise]);
		} finally {
			this.#lifecycle.signal.removeEventListener("abort", onAbort);
		}
	}

	async #runDeferred(
		label: string,
		sessionId: string,
		started: () => void,
		run: () => Promise<void>,
		finished: () => void,
	): Promise<void> {
		try {
			await this.#waitForIdleOrAbort();
			if (this.#lifecycle.signal.aborted || this.#host.isDisposed() || this.#host.sessionId() !== sessionId) return;
			started();
			await run();
		} catch (error) {
			if (!this.#lifecycle.signal.aborted) {
				this.#host.reportFailure(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		} finally {
			finished();
		}
	}

	rewindStatus(): Record<string, unknown> {
		return {
			available: this.#host.hasCheckpoint(),
			scheduled: this.#rewindPending,
			in_flight: this.#rewindInFlight,
		};
	}

	scheduleRewind(report: string, request: IpythonHostRequest): Record<string, unknown> {
		aborted(request.signal);
		if (!this.#host.hasCheckpoint()) {
			return { scheduled: false, reason: "no active checkpoint" };
		}
		if (this.#rewindPending || this.#rewindInFlight) {
			return { scheduled: false, reason: "rewind is already scheduled" };
		}
		this.#rewindPending = true;
		const sessionId = this.#host.sessionId();
		this.#trackDeferred(
			this.#runDeferred(
				"rewind",
				sessionId,
				() => {
					this.#rewindPending = false;
					this.#rewindInFlight = true;
				},
				async () => await this.#host.runRewind(report),
				() => {
					this.#rewindPending = false;
					this.#rewindInFlight = false;
				},
			),
		);
		return {
			scheduled: true,
			note: "Rewind runs after the current cell and turn finish; the session resumes from the checkpoint.",
		};
	}

	async createCheckpoint(label: string | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
		aborted(signal);
		return await this.#host.createCheckpoint(label);
	}

	async applyTodo(
		operation: string,
		payload: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		aborted(signal);
		return await this.#host.applyTodo(operation, payload);
	}

	listHeartbeats(includeInactive = false): RlmHeartbeat[] {
		this.#resetForSessionTransition();
		return [...this.#heartbeats.values()]
			.map(state => cloneHeartbeat(state.value))
			.filter(heartbeat => includeInactive || heartbeat.status !== "cancelled")
			.sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
	}

	createHeartbeat(input: {
		instruction: string;
		interval?: string;
		label?: string;
		deliveryMode?: "steer" | "follow_up";
	}): RlmHeartbeat {
		this.#resetForSessionTransition();
		const now = new Date(this.#now()).toISOString();
		const schedule = input.interval ?? DEFAULT_HEARTBEAT_INTERVAL;
		const intervalMs = parseInterval(schedule);
		const value: RlmHeartbeat = {
			id: `rlmhb_${randomUUID()}`,
			status: "active",
			label: input.label ?? null,
			delivery_mode: input.deliveryMode ?? "steer",
			instruction: input.instruction,
			schedule,
			created_at: now,
			updated_at: now,
			next_run_at: new Date(this.#now() + intervalMs).toISOString(),
			last_run_at: null,
			last_error: null,
			run_count: 0,
		};
		const state: HeartbeatState = { value, intervalMs, sessionId: this.#host.sessionId() };
		this.#heartbeats.set(value.id, state);
		this.#arm(state);
		return cloneHeartbeat(value);
	}

	updateHeartbeat(input: {
		id: string;
		instruction?: string;
		interval?: string;
		label?: string;
		status?: "pause" | "resume";
		deliveryMode?: "steer" | "follow_up";
	}): RlmHeartbeat | null {
		this.#resetForSessionTransition();
		const state = this.#heartbeats.get(input.id);
		if (!state) return null;
		if (input.instruction !== undefined) state.value.instruction = input.instruction;
		if (input.label !== undefined) state.value.label = input.label;
		if (input.deliveryMode !== undefined) state.value.delivery_mode = input.deliveryMode;
		if (input.interval !== undefined) {
			state.value.schedule = input.interval;
			state.intervalMs = parseInterval(input.interval);
		}
		if (input.status === "pause") state.value.status = "paused";
		if (input.status === "resume") state.value.status = "active";
		state.value.updated_at = new Date(this.#now()).toISOString();
		if (state.timer) this.#clearTimer(state.timer);
		state.timer = undefined;
		state.value.next_run_at =
			state.value.status === "active" ? new Date(this.#now() + state.intervalMs).toISOString() : null;
		if (state.value.status === "active") this.#arm(state);
		return cloneHeartbeat(state.value);
	}

	deleteHeartbeat(id: string): RlmHeartbeat | null {
		this.#resetForSessionTransition();
		const state = this.#heartbeats.get(id);
		if (!state) return null;
		if (state.timer) this.#clearTimer(state.timer);
		state.value.status = "cancelled";
		state.value.updated_at = new Date(this.#now()).toISOString();
		state.value.next_run_at = null;
		this.#heartbeats.delete(id);
		return cloneHeartbeat(state.value);
	}

	#arm(state: HeartbeatState): void {
		if (state.value.status !== "active" || this.#lifecycle.signal.aborted) return;
		state.timer = this.#setTimer(() => {
			state.timer = undefined;
			void this.#fire(state);
		}, state.intervalMs);
		state.timer.unref?.();
	}

	async #fire(state: HeartbeatState): Promise<void> {
		if (
			this.#lifecycle.signal.aborted ||
			this.#host.isDisposed() ||
			state.value.status !== "active" ||
			state.sessionId !== this.#host.sessionId()
		) {
			return;
		}
		const now = new Date(this.#now()).toISOString();
		state.value.last_run_at = now;
		state.value.updated_at = now;
		state.value.run_count++;
		try {
			await this.#host.deliverHeartbeat(cloneHeartbeat(state.value));
			state.value.last_error = null;
		} catch (error) {
			state.value.last_error = error instanceof Error ? error.message : String(error);
			this.#host.reportFailure(`RLM heartbeat ${state.value.id} failed: ${state.value.last_error}`);
		}
		if (state.value.status === "active" && state.sessionId === this.#host.sessionId()) {
			state.value.next_run_at = new Date(this.#now() + state.intervalMs).toISOString();
			this.#arm(state);
		}
	}

	#resetForSessionTransition(): void {
		const current = this.#host.sessionId();
		if ([...this.#heartbeats.values()].every(state => state.sessionId === current)) return;
		for (const state of this.#heartbeats.values()) if (state.timer) this.#clearTimer(state.timer);
		this.#heartbeats.clear();
	}

	dispose(): void {
		if (this.#lifecycle.signal.aborted) return;
		this.#lifecycle.abort(new Error("Session control service disposed"));
		for (const state of this.#heartbeats.values()) if (state.timer) this.#clearTimer(state.timer);
		this.#heartbeats.clear();
	}
}

function handlerMap(): Record<string, IpythonHostHandler> {
	return {};
}

export function createSessionControlIpythonHostHandlers(service: OmpSessionControlService): IpythonHostHandlers {
	const handlers = handlerMap();
	const add = (name: string, handler: IpythonHostHandler): void => {
		handlers[name] = handler;
	};
	add("goal.get", async request => {
		assertFields(request.data, [], "goal.get");
		return service.goalGet() as unknown as Record<string, unknown>;
	});
	add("goal.create", async request => {
		assertFields(request.data, ["objective", "token_budget"], "goal.create");
		const objective = requiredString(request.data.objective, "goal.create objective");
		const tokenBudget =
			request.data.token_budget === undefined
				? undefined
				: integer(request.data.token_budget, "goal.create token_budget", 1, Number.MAX_SAFE_INTEGER);
		return (await service.goalCreate(objective, tokenBudget, request.signal)) as unknown as Record<string, unknown>;
	});
	add("goal.complete", async request => {
		assertFields(request.data, [], "goal.complete");
		return (await service.goalComplete(request.signal)) as unknown as Record<string, unknown>;
	});
	add("goal.pause", async request => {
		assertFields(request.data, ["reason"], "goal.pause");
		return (await service.goalPause(
			requiredString(request.data.reason, "goal.pause reason", 1000),
			request.signal,
		)) as unknown as Record<string, unknown>;
	});
	add("goal.resume", async request => {
		assertFields(request.data, [], "goal.resume");
		return (await service.goalResume(request.signal)) as unknown as Record<string, unknown>;
	});
	add("compact.status", async request => {
		assertFields(request.data, [], "compact.status");
		return service.compactStatus();
	});
	add("compact.run", async request => {
		assertFields(request.data, ["instructions"], "compact.run");
		return service.scheduleCompaction(optionalString(request.data.instructions, "compact.run instructions"), request);
	});
	add("refine.status", async request => {
		assertFields(request.data, [], "refine.status");
		return service.refineStatus();
	});
	add("refine.run", async request => {
		assertFields(request.data, ["instructions", "global"], "refine.run");
		return service.scheduleRefinement(
			optionalString(request.data.instructions, "refine.run instructions"),
			boolean(request.data.global, false, "refine.run global"),
			request,
		);
	});
	add("checkpoint.status", async request => {
		assertFields(request.data, [], "checkpoint.status");
		return service.rewindStatus();
	});
	add("checkpoint.rewind", async request => {
		assertFields(request.data, ["report"], "checkpoint.rewind");
		return service.scheduleRewind(requiredString(request.data.report, "checkpoint.rewind report", 64_000), request);
	});
	add("checkpoint.create", async request => {
		assertFields(request.data, ["label"], "checkpoint.create");
		return await service.createCheckpoint(
			optionalString(request.data.label, "checkpoint.create label", 128),
			request.signal,
		);
	});
	add("todo.apply", async request => {
		assertFields(request.data, ["operation", "payload"], "todo.apply");
		return await service.applyTodo(
			requiredString(request.data.operation, "todo.apply operation", 32),
			optionalRecord(request.data.payload, "todo.apply payload") ?? {},
			request.signal,
		);
	});
	add("rlm_heartbeat.list", async request => {
		assertFields(request.data, ["include_inactive"], "rlm_heartbeat.list");
		return {
			heartbeats: service.listHeartbeats(
				boolean(request.data.include_inactive, false, "rlm_heartbeat.list include_inactive"),
			),
		};
	});
	add("rlm_heartbeat.create", async request => {
		assertFields(request.data, ["instruction", "interval", "label", "delivery_mode"], "rlm_heartbeat.create");
		const deliveryMode = request.data.delivery_mode;
		if (deliveryMode !== undefined && deliveryMode !== "steer" && deliveryMode !== "follow_up") {
			throw new Error('rlm_heartbeat.create delivery_mode must be "steer" or "follow_up"');
		}
		return {
			heartbeat: service.createHeartbeat({
				instruction: requiredString(request.data.instruction, "rlm_heartbeat.create instruction"),
				interval: optionalString(request.data.interval, "rlm_heartbeat.create interval", 32),
				label: optionalString(request.data.label, "rlm_heartbeat.create label", MAX_LABEL_CHARS),
				deliveryMode,
			}),
		};
	});
	add("rlm_heartbeat.update", async request => {
		assertFields(
			request.data,
			["id", "instruction", "interval", "label", "status", "delivery_mode"],
			"rlm_heartbeat.update",
		);
		const status = request.data.status;
		if (status !== undefined && status !== "pause" && status !== "resume") {
			throw new Error('rlm_heartbeat.update status must be "pause" or "resume"');
		}
		const deliveryMode = request.data.delivery_mode;
		if (deliveryMode !== undefined && deliveryMode !== "steer" && deliveryMode !== "follow_up") {
			throw new Error('rlm_heartbeat.update delivery_mode must be "steer" or "follow_up"');
		}
		if (
			request.data.instruction === undefined &&
			request.data.interval === undefined &&
			request.data.label === undefined &&
			status === undefined &&
			deliveryMode === undefined
		) {
			throw new Error("rlm_heartbeat.update requires at least one field to update");
		}
		return {
			heartbeat: service.updateHeartbeat({
				id: requiredString(request.data.id, "rlm_heartbeat.update id", 128),
				instruction: optionalString(request.data.instruction, "rlm_heartbeat.update instruction"),
				interval: optionalString(request.data.interval, "rlm_heartbeat.update interval", 32),
				label: optionalString(request.data.label, "rlm_heartbeat.update label", MAX_LABEL_CHARS),
				status,
				deliveryMode,
			}),
		};
	});
	add("rlm_heartbeat.delete", async request => {
		assertFields(request.data, ["id"], "rlm_heartbeat.delete");
		return { heartbeat: service.deleteHeartbeat(requiredString(request.data.id, "rlm_heartbeat.delete id", 128)) };
	});
	addHarnessHandlers(handlers, service.harness);
	return handlers;
}

function addHarnessHandlers(handlers: Record<string, IpythonHostHandler>, harness: HarnessService): void {
	const add = (name: string, handler: IpythonHostHandler): void => {
		handlers[name] = handler;
	};
	const write = (payload: Record<string, unknown>, operation: string): HarnessWriteInput => ({
		kind: harnessKind(payload.kind),
		id: optionalString(payload.id, `${operation} id`, 80),
		title: requiredString(payload.title, `${operation} title`, 256),
		content: requiredString(payload.content, `${operation} content`, 64_000),
		path: optionalString(payload.path, `${operation} path`, 256),
		reference: optionalRecord(payload.reference, `${operation} reference`),
		arguments: optionalRecord(payload.arguments, `${operation} arguments`),
		metadata: optionalRecord(payload.metadata, `${operation} metadata`),
		source: optionalString(payload.source, `${operation} source`, 128),
		global: boolean(payload.global, false, `${operation} global`),
	});
	for (const operation of ["upsert", "create"] as const) {
		add(`harness.${operation}`, async request => {
			assertFields(
				request.data,
				["kind", "id", "title", "content", "path", "reference", "arguments", "metadata", "source", "global"],
				`harness.${operation}`,
			);
			const input = write(request.data, `harness.${operation}`);
			return { entry: await harness[operation](input, request.signal) };
		});
	}
	add("harness.update", async request => {
		assertFields(
			request.data,
			["kind", "id", "title", "content", "path", "reference", "arguments", "metadata", "source", "global"],
			"harness.update",
		);
		const input = write(request.data, "harness.update");
		if (!input.id) throw new Error("harness.update id is required");
		return { entry: await harness.update(input as HarnessUpdateInput, request.signal) };
	});
	add("harness.get", async request => {
		assertFields(request.data, ["kind", "id", "global"], "harness.get");
		return {
			entry: await harness.get(
				harnessKind(request.data.kind),
				requiredString(request.data.id, "harness.get id", 80),
				boolean(request.data.global, false, "harness.get global"),
				request.signal,
			),
		};
	});
	add("harness.delete", async request => {
		assertFields(request.data, ["kind", "id", "global"], "harness.delete");
		return {
			deleted: await harness.delete(
				harnessKind(request.data.kind),
				requiredString(request.data.id, "harness.delete id", 80),
				boolean(request.data.global, false, "harness.delete global"),
				request.signal,
			),
		};
	});
	add("harness.list", async request => {
		assertFields(request.data, ["kind", "global"], "harness.list");
		return {
			entries: await harness.list(
				request.data.kind === undefined || request.data.kind === null ? undefined : harnessKind(request.data.kind),
				boolean(request.data.global, false, "harness.list global"),
				request.signal,
			),
		};
	});
	add("harness.record_refinement", async request => {
		assertFields(
			request.data,
			["id", "trigger", "changes", "evidence", "outcome", "global"],
			"harness.record_refinement",
		);
		const rawChanges = request.data.changes;
		const changes = typeof rawChanges === "string" ? [rawChanges] : rawChanges;
		if (!Array.isArray(changes) || !changes.every(change => typeof change === "string")) {
			throw new TypeError("harness.record_refinement changes must be a string or list of strings");
		}
		return {
			event: await harness.recordRefinement(
				{
					id: optionalString(request.data.id, "harness.record_refinement id", 80),
					trigger: requiredString(request.data.trigger, "harness.record_refinement trigger", 4_000),
					changes,
					evidence: optionalString(request.data.evidence, "harness.record_refinement evidence", 8_000),
					outcome: optionalString(request.data.outcome, "harness.record_refinement outcome", 8_000),
					global: boolean(request.data.global, false, "harness.record_refinement global"),
				},
				request.signal,
			),
		};
	});
	add("harness.plan_refinement", async request => {
		assertFields(request.data, ["observation", "failing_component", "next_step"], "harness.plan_refinement");
		return {
			observation: requiredString(request.data.observation, "harness.plan_refinement observation", 8_000),
			failing_component:
				optionalString(request.data.failing_component, "harness.plan_refinement failing_component", 1_000) ?? "",
			next_step: optionalString(request.data.next_step, "harness.plan_refinement next_step", 2_000) ?? "",
		};
	});
	add("harness.overview", async request => {
		assertFields(request.data, ["max_entries_per_kind", "global"], "harness.overview");
		const max =
			request.data.max_entries_per_kind === undefined
				? 20
				: integer(request.data.max_entries_per_kind, "harness.overview max_entries_per_kind", 1, 100);
		return {
			overview: await harness.overview(
				boolean(request.data.global, false, "harness.overview global"),
				max,
				request.signal,
			),
		};
	});
	add("harness.snapshot", async request => {
		assertFields(request.data, ["global"], "harness.snapshot");
		return {
			snapshot: await harness.snapshot(
				boolean(request.data.global, false, "harness.snapshot global"),
				request.signal,
			),
		};
	});
}

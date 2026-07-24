import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { sessionSteeringDirForSessionFile } from "./session/session-steering";

const MAX_SEARCH_MINUTES = 366 * 24 * 60;
const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CronJob {
	id: string;
	expression: string;
	prompt: string;
	recurring: boolean;
	durable: boolean;
	createdAt: number;
	expiresAt?: number;
	nextFireAt: number;
}

export interface CronSchedule {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
	domWildcard: boolean;
	dowWildcard: boolean;
}

function isCronJob(value: unknown): value is CronJob {
	if (!value || typeof value !== "object") return false;
	const job = value as Record<string, unknown>;
	return (
		typeof job.id === "string" &&
		typeof job.expression === "string" &&
		typeof job.prompt === "string" &&
		typeof job.recurring === "boolean" &&
		typeof job.durable === "boolean" &&
		typeof job.createdAt === "number" &&
		typeof job.nextFireAt === "number" &&
		(job.expiresAt === undefined || typeof job.expiresAt === "number")
	);
}

export function parseCronExpression(expression: string): CronSchedule {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("Cron expression must have exactly 5 fields.");
	const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields;
	if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
		throw new Error("Cron expression has an empty field.");
	}
	return {
		minutes: parseCronField(minutes, 0, 59),
		hours: parseCronField(hours, 0, 23),
		daysOfMonth: parseCronField(daysOfMonth, 1, 31),
		months: parseCronField(months, 1, 12),
		daysOfWeek: parseCronField(daysOfWeek, 0, 7, true),
		domWildcard: daysOfMonth === "*",
		dowWildcard: daysOfWeek === "*",
	};
}

function parseCronField(field: string, min: number, max: number, sundayAlias = false): Set<number> {
	const values = new Set<number>();
	for (const item of field.split(",")) {
		if (!item) throw new Error(`Invalid cron field: ${field}`);
		const parts = item.split("/");
		if (parts.length > 2) throw new Error(`Invalid cron step: ${item}`);
		const [rangePart, stepPart] = parts;
		const step = stepPart === undefined ? 1 : Number(stepPart);
		if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${item}`);
		let start: number;
		let end: number;
		if (rangePart === "*") {
			start = min;
			end = max;
		} else if (rangePart?.includes("-")) {
			const range = rangePart.split("-");
			if (range.length !== 2) throw new Error(`Invalid cron range: ${item}`);
			start = Number(range[0]);
			end = Number(range[1]);
		} else {
			start = Number(rangePart);
			end = stepPart === undefined ? start : max;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
			throw new Error(`Cron value out of range: ${item}`);
		}
		for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
	}
	if (values.size === 0) throw new Error(`Cron field has no values: ${field}`);
	return values;
}

export function nextCronFire(expression: string, after: Date): Date {
	const schedule = parseCronExpression(expression);
	const candidate = new Date(after);
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);
	for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
		const dayOfMonthMatches = schedule.daysOfMonth.has(candidate.getDate());
		const dayOfWeekMatches = schedule.daysOfWeek.has(candidate.getDay());
		const dayMatches = schedule.domWildcard
			? dayOfWeekMatches
			: schedule.dowWildcard
				? dayOfMonthMatches
				: dayOfMonthMatches || dayOfWeekMatches;
		if (
			schedule.months.has(candidate.getMonth() + 1) &&
			schedule.hours.has(candidate.getHours()) &&
			schedule.minutes.has(candidate.getMinutes()) &&
			dayMatches
		) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error("Cron expression has no match within one year.");
}

function parseStoredJobs(text: string, now: number): CronJob[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) throw new Error("Scheduled task store must contain an array.");
	const jobs: CronJob[] = [];
	for (const value of parsed) {
		if (!isCronJob(value)) continue;
		const job = value;
		parseCronExpression(job.expression);
		if (job.recurring && job.expiresAt !== undefined && job.expiresAt <= now) continue;
		if (!job.recurring && job.nextFireAt <= now) job.nextFireAt = now;
		if (job.recurring && job.nextFireAt <= now) {
			job.nextFireAt = nextCronFire(job.expression, new Date(now)).getTime();
		}
		jobs.push(job);
	}
	return jobs;
}

export type CronTimer = NodeJS.Timeout;
export type CronTimerFactory = (callback: () => void, delay: number) => CronTimer;
export interface CronManagerOptions {
	sessionFile?: string | null;
	getSessionFile?: () => string | null | undefined;
	getSessionId?: () => string | undefined;
	isIdle: () => boolean;
	enqueuePrompt: (prompt: string) => Promise<void>;
	now?: () => number;
	setTimer?: CronTimerFactory;
	clearTimer?: (timer: CronTimer) => void;
}

export class CronManager {
	readonly #getSessionFile: () => string | undefined;
	readonly #getSessionId: (() => string | undefined) | undefined;
	readonly #isIdle: () => boolean;
	readonly #enqueuePrompt: (prompt: string) => Promise<void>;
	readonly #now: () => number;
	readonly #setTimer: CronTimerFactory;
	readonly #clearTimer: (timer: CronTimer) => void;
	#sessionFile: string | undefined;
	#sessionKey: string | undefined;
	#sessionLoaded = false;
	#jobsBySession = new Map<string | undefined, Map<string, CronJob>>();
	#jobs = new Map<string, CronJob>();
	#loadedSessions = new Set<string | undefined>();
	#timer: CronTimer | undefined;
	#processing = false;
	#sequence = 0;

	constructor(options: CronManagerOptions) {
		const fixedSessionFile = options.sessionFile ? path.resolve(options.sessionFile) : undefined;
		const getSessionFile = options.getSessionFile;
		this.#getSessionFile = getSessionFile
			? () => {
					const sessionFile = getSessionFile();
					return sessionFile ? path.resolve(sessionFile) : undefined;
				}
			: () => fixedSessionFile;
		this.#getSessionId = options.getSessionId;
		this.#isIdle = options.isIdle;
		this.#enqueuePrompt = options.enqueuePrompt;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
	}

	async load(): Promise<void> {
		this.#refreshSession();
		this.#armTimer();
	}

	async create(input: {
		expression: string;
		prompt: string;
		recurring?: boolean;
		durable?: boolean;
	}): Promise<CronJob> {
		this.#refreshSession();
		if (!input.prompt.trim()) throw new Error("Cron prompt cannot be empty.");
		if (input.durable && !this.#sessionFile) throw new Error("Durable cron jobs require a persisted session.");
		parseCronExpression(input.expression);
		const now = this.#now();
		const job: CronJob = {
			id: `cron-${now.toString(36)}-${(++this.#sequence).toString(36)}`,
			expression: input.expression.trim(),
			prompt: input.prompt,
			recurring: input.recurring ?? true,
			durable: input.durable ?? false,
			createdAt: now,
			expiresAt: input.recurring === false ? undefined : now + RECURRING_LIFETIME_MS,
			nextFireAt: nextCronFire(input.expression, new Date(now)).getTime(),
		};
		this.#jobs.set(job.id, job);
		await this.#persist();
		this.#armTimer();
		return job;
	}

	list(): CronJob[] {
		this.#refreshSession();
		return [...this.#jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt);
	}

	async delete(id: string): Promise<boolean> {
		this.#refreshSession();
		const deleted = this.#jobs.delete(id);
		if (deleted) await this.#persist();
		this.#armTimer();
		return deleted;
	}

	notifyIdle(): void {
		this.#refreshSession();
		if (this.#isIdle()) void this.#processDue();
	}

	dispose(): void {
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
	}

	storePath(): string {
		this.#refreshSession();
		if (!this.#sessionFile) throw new Error("Scheduled task storage requires a persisted session.");
		return path.join(sessionSteeringDirForSessionFile(this.#sessionFile), "scheduled_tasks.json");
	}

	async #persist(
		sessionFile: string | undefined = this.#sessionFile,
		jobs: Map<string, CronJob> = this.#jobs,
	): Promise<void> {
		if (!sessionFile) return;
		const durable = [...jobs.values()].filter(job => job.durable).sort((a, b) => a.nextFireAt - b.nextFireAt);
		const store = path.join(sessionSteeringDirForSessionFile(sessionFile), "scheduled_tasks.json");
		await mkdir(path.dirname(store), { recursive: true });
		await writeFile(store, `${JSON.stringify(durable, null, 2)}\n`, "utf8");
	}

	#refreshSession(): void {
		const sessionFileValue = this.#getSessionFile();
		const sessionFile = sessionFileValue ? path.resolve(sessionFileValue) : undefined;
		const sessionKey = sessionFile ?? this.#getSessionId?.();
		if (this.#sessionLoaded && this.#sessionFile === sessionFile && this.#sessionKey === sessionKey) {
			return;
		}
		if (this.#timer !== undefined) {
			this.#clearTimer(this.#timer);
			this.#timer = undefined;
		}
		if (this.#sessionLoaded) this.#jobsBySession.set(this.#sessionKey, this.#jobs);
		this.#sessionFile = sessionFile;
		this.#sessionKey = sessionKey;
		this.#sessionLoaded = true;
		this.#jobs = this.#jobsBySession.get(sessionKey) ?? new Map<string, CronJob>();
		this.#jobsBySession.set(sessionKey, this.#jobs);
		if (!this.#loadedSessions.has(sessionKey)) {
			if (sessionFile) {
				try {
					const store = path.join(sessionSteeringDirForSessionFile(sessionFile), "scheduled_tasks.json");
					for (const job of parseStoredJobs(readFileSync(store, "utf8"), this.#now())) {
						this.#jobs.set(job.id, job);
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			this.#loadedSessions.add(sessionKey);
		}
		this.#armTimer();
	}

	#armTimer(): void {
		this.#refreshSession();
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		const next = [...this.#jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt)[0];
		if (!next) {
			this.#timer = undefined;
			return;
		}
		const delay = Math.max(0, Math.min(next.nextFireAt - this.#now(), 2_147_000_000));
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			this.#refreshSession();
			void this.#processDue();
		}, delay);
	}

	async #processDue(): Promise<void> {
		this.#refreshSession();
		if (this.#processing) return;
		this.#processing = true;
		const sessionFile = this.#sessionFile;
		const sessionKey = this.#sessionKey;
		const jobs = this.#jobs;
		try {
			// Deliver every due job as soon as it fires, whether the turn is active
			// or idle. The delivery owner (the session) routes each notification to
			// the next tool-call boundary when streaming and wakes a turn when idle,
			// so the scheduler never waits for interactive input to hand a job off.
			while (true) {
				this.#refreshSession();
				if (this.#sessionFile !== sessionFile || this.#sessionKey !== sessionKey || this.#jobs !== jobs) {
					break;
				}
				const now = this.#now();
				const job = [...jobs.values()]
					.sort((a, b) => a.nextFireAt - b.nextFireAt)
					.find(candidate => candidate.nextFireAt <= now);
				if (!job) break;
				const previousNextFireAt = job.nextFireAt;
				if (job.recurring) {
					const next = nextCronFire(job.expression, new Date(Math.max(job.nextFireAt, now)));
					if (job.expiresAt !== undefined && next.getTime() >= job.expiresAt) jobs.delete(job.id);
					else job.nextFireAt = next.getTime();
				} else {
					jobs.delete(job.id);
				}
				await this.#persist(sessionFile, jobs);
				this.#refreshSession();
				if (this.#sessionFile !== sessionFile || this.#sessionKey !== sessionKey || this.#jobs !== jobs) {
					if (job.recurring) job.nextFireAt = previousNextFireAt;
					jobs.set(job.id, job);
					await this.#persist(sessionFile, jobs);
					break;
				}
				await this.#enqueuePrompt(job.prompt);
			}
		} catch (error) {
			process.emitWarning(`Cron job delivery failed: ${String(error)}`);
		} finally {
			this.#processing = false;
			this.#armTimer();
		}
	}
}

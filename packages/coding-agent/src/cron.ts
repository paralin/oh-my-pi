import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const MINUTE_MS = 60_000;
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

export type CronTimer = NodeJS.Timeout;
export type CronTimerFactory = (callback: () => void, delay: number) => CronTimer;

export interface CronManagerOptions {
	sessionFile?: string | null;
	isIdle: () => boolean;
	enqueuePrompt: (prompt: string) => Promise<void>;
	now?: () => number;
	setTimer?: CronTimerFactory;
	clearTimer?: (timer: CronTimer) => void;
}

export class CronManager {
	readonly #sessionFile: string | undefined;
	readonly #isIdle: () => boolean;
	readonly #enqueuePrompt: (prompt: string) => Promise<void>;
	readonly #now: () => number;
	readonly #setTimer: CronTimerFactory;
	readonly #clearTimer: (timer: CronTimer) => void;
	#jobs = new Map<string, CronJob>();
	#timer: CronTimer | undefined;
	#processing = false;
	#sequence = 0;

	constructor(options: CronManagerOptions) {
		this.#sessionFile = options.sessionFile ?? undefined;
		this.#isIdle = options.isIdle;
		this.#enqueuePrompt = options.enqueuePrompt;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
	}

	async load(): Promise<void> {
		if (!this.#sessionFile) return;
		try {
			const text = await readFile(this.storePath(), "utf8");
			const parsed: unknown = JSON.parse(text);
			if (!Array.isArray(parsed)) throw new Error("Scheduled task store must contain an array.");
			for (const value of parsed) {
				if (!isCronJob(value)) continue;
				const job = value;
				parseCronExpression(job.expression);
				if (job.recurring && job.expiresAt !== undefined && job.expiresAt <= this.#now()) continue;
				if (!job.recurring && job.nextFireAt <= this.#now()) job.nextFireAt = this.#now();
				if (job.recurring && job.nextFireAt <= this.#now()) {
					job.nextFireAt = nextCronFire(job.expression, new Date(this.#now())).getTime();
				}
				this.#jobs.set(job.id, job);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.#armTimer();
	}

	async create(input: {
		expression: string;
		prompt: string;
		recurring?: boolean;
		durable?: boolean;
	}): Promise<CronJob> {
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
		return [...this.#jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt);
	}

	async delete(id: string): Promise<boolean> {
		const deleted = this.#jobs.delete(id);
		if (deleted) await this.#persist();
		this.#armTimer();
		return deleted;
	}

	notifyIdle(): void {
		if (this.#isIdle()) void this.#processDue();
	}

	dispose(): void {
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
	}

	storePath(): string {
		return path.join(path.dirname(this.#sessionFile!), ".omp", "scheduled_tasks.json");
	}

	async #persist(): Promise<void> {
		if (!this.#sessionFile) return;
		const durable = this.list().filter(job => job.durable);
		const store = this.storePath();
		await mkdir(path.dirname(store), { recursive: true });
		await writeFile(store, `${JSON.stringify(durable, null, 2)}\n`, "utf8");
	}

	#armTimer(): void {
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		const next = this.list()[0];
		if (!next) {
			this.#timer = undefined;
			return;
		}
		const delay = Math.max(0, Math.min(next.nextFireAt - this.#now(), 2_147_000_000));
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			void this.#processDue();
		}, delay);
	}

	async #processDue(): Promise<void> {
		if (this.#processing || !this.#isIdle()) return;
		this.#processing = true;
		try {
			while (this.#isIdle()) {
				const now = this.#now();
				const job = this.list().find(candidate => candidate.nextFireAt <= now);
				if (!job) break;
				if (job.recurring) {
					const next = nextCronFire(job.expression, new Date(Math.max(job.nextFireAt, now - MINUTE_MS)));
					if (job.expiresAt !== undefined && next.getTime() >= job.expiresAt) this.#jobs.delete(job.id);
					else job.nextFireAt = next.getTime();
				} else {
					this.#jobs.delete(job.id);
				}
				await this.#persist();
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

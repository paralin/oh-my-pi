import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { isEnoent, logger, withTimeout } from "@oh-my-pi/pi-utils";
import { sessionSidecarDir } from "./session/session-paths";
import { FileSessionStorage, type SessionStorage } from "./session/session-storage";

const MAX_SEARCH_MINUTES = 8 * 366 * 24 * 60;
const RECURRING_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const DELIVERY_RETRY_BASE_MS = 1_000;
const DELIVERY_RETRY_MAX_MS = 60_000;
const REFRESH_RETRY_BASE_MS = 250;
const REFRESH_RETRY_MAX_MS = 30_000;
const EXPIRY_RETRY_GRACE_MS = 5 * 60 * 1_000;
const DELIVERY_CLAIM_RETRY_MS = 1_000;
const DELIVERY_LEASE_MS = 5 * 60 * 1_000;
const DURABLE_MUTATION_CLAIM_RETRY_MS = 10;
const DISPOSE_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Marks the async context of a serialized mutation. `suspend()`/`dispose()`
 * drain the mutation chain, so a delivery that tears down the session it was
 * handed to would otherwise await itself; the scope lets those callers detect
 * the re-entry and skip the drain instead of deadlocking.
 */
const mutationScope = new AsyncLocalStorage<true>();

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

interface CronDeliveryRetry {
	attempts: number;
	retryAt: number;
	delivered: boolean;
}

interface CronDeliveryClaim {
	path: string;
	storage: SessionStorage;
	owner: string;
}

function supportsDurableClaims(storage: SessionStorage): boolean {
	return (
		typeof storage.acquireLease === "function" &&
		typeof storage.renewLease === "function" &&
		typeof storage.releaseLease === "function"
	);
}

interface CronClaimMaintenance {
	renew(): Promise<boolean>;
	stop(): Promise<void>;
}

function maintainDeliveryClaim(claim: CronDeliveryClaim | undefined, now: () => number): CronClaimMaintenance {
	const renewLease = claim?.storage.renewLease;
	if (!claim || !renewLease) {
		return {
			renew: () => Promise.resolve(true),
			stop: () => Promise.resolve(),
		};
	}
	let renewal = Promise.resolve(true);
	const renew = (): Promise<boolean> => {
		renewal = renewal.then(async held => {
			if (!held) return false;
			const renewedAt = now();
			try {
				return await renewLease.call(
					claim.storage,
					claim.path,
					claim.owner,
					renewedAt + DELIVERY_LEASE_MS,
					renewedAt,
				);
			} catch (error) {
				logger.warn("Cron delivery lease renewal failed", { error });
				return false;
			}
		});
		return renewal;
	};
	const timer = setInterval(() => {
		void renew();
	}, DELIVERY_LEASE_MS / 3);
	timer.unref();
	return {
		renew,
		stop: async () => {
			clearInterval(timer);
			await renewal;
		},
	};
}

async function acquireDeliveryClaim(
	store: string,
	storage: SessionStorage,
	now: number,
): Promise<CronDeliveryClaim | undefined> {
	const acquireLease = storage.acquireLease;
	if (!acquireLease || !storage.renewLease || !storage.releaseLease) return undefined;
	const path = `${store}.delivery`;
	const owner = crypto.randomUUID();
	const acquired = await acquireLease.call(storage, path, owner, now + DELIVERY_LEASE_MS, now);
	return acquired ? { path, storage, owner } : undefined;
}

async function releaseDeliveryClaim(claim: CronDeliveryClaim): Promise<void> {
	try {
		await claim.storage.releaseLease?.(claim.path, claim.owner);
	} catch (error) {
		logger.warn("Cron delivery claim release failed", { error });
	}
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

function isUnitWildcard(field: string): boolean {
	return field.split(",").some(member => {
		const [range, step] = member.split("/");
		return range === "*" && (step === undefined || Number(step) === 1);
	});
}

export function parseCronExpression(expression: string): CronSchedule {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error("Cron expression must have exactly 5 fields.");
	const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields;
	if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
		throw new Error("Cron expression has an empty field.");
	}
	const parsedDaysOfMonth = parseCronField(daysOfMonth, 1, 31);
	const parsedDaysOfWeek = parseCronField(daysOfWeek, 0, 7, true);
	return {
		minutes: parseCronField(minutes, 0, 59),
		hours: parseCronField(hours, 0, 23),
		daysOfMonth: parsedDaysOfMonth,
		months: parseCronField(months, 1, 12),
		daysOfWeek: parsedDaysOfWeek,
		domWildcard: isUnitWildcard(daysOfMonth),
		dowWildcard: isUnitWildcard(daysOfWeek),
	};
}

function parseCronField(field: string, min: number, max: number, sundayAlias = false): Set<number> {
	const values = new Set<number>();
	for (const item of field.split(",")) {
		if (!item) throw new Error(`Invalid cron field: ${field}`);
		const parts = item.split("/");
		if (parts.length > 2) throw new Error(`Invalid cron step: ${item}`);
		const [rangePart, stepPart] = parts;
		if (stepPart !== undefined && !/^\d+$/.test(stepPart)) throw new Error(`Invalid cron step: ${item}`);
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
			if (!range.every(endpoint => /^\d+$/.test(endpoint))) throw new Error(`Invalid cron range: ${item}`);
			start = Number(range[0]);
			end = Number(range[1]);
		} else {
			if (rangePart === undefined || !/^\d+$/.test(rangePart)) throw new Error(`Invalid cron value: ${item}`);
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
	throw new Error("Cron expression has no match within eight years.");
}

function parseStoredJobs(text: string, now: number, normalizeOverdue = true): CronJob[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		logger.warn("Ignoring malformed scheduled task store", { error });
		return [];
	}
	if (!Array.isArray(parsed)) {
		logger.warn("Ignoring scheduled task store with a non-array root");
		return [];
	}
	const jobs: CronJob[] = [];
	for (const value of parsed) {
		if (!isCronJob(value)) continue;
		const job = value;
		try {
			parseCronExpression(job.expression);
		} catch {
			continue;
		}
		if (
			job.recurring &&
			job.expiresAt !== undefined &&
			(job.expiresAt < now || (job.expiresAt === now && job.nextFireAt > now))
		) {
			continue;
		}
		if (normalizeOverdue && !job.recurring && job.nextFireAt <= now) job.nextFireAt = now;
		if (normalizeOverdue && job.recurring && job.nextFireAt <= now) {
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
	storage?: SessionStorage;
	enqueuePrompt: (prompt: string) => Promise<void>;
	now?: () => number;
	setTimer?: CronTimerFactory;
	clearTimer?: (timer: CronTimer) => void;
}

export class CronManager {
	readonly #getSessionFile: () => string | undefined;
	readonly #getSessionId: (() => string | undefined) | undefined;
	readonly #tracksSessionMoves: boolean;
	readonly #storage: SessionStorage;
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
	#sessionLoads = new Map<string | undefined, Promise<void>>();
	#timer: CronTimer | undefined;
	#refreshRetryTimer: CronTimer | undefined;
	#refreshGeneration = 0;
	#processing = false;
	#mutationTail: Promise<void> = Promise.resolve();
	#disposed = false;
	#suspended = false;
	#started = false;
	#completedForkCopy: string | undefined;
	readonly #deliveryRetries = new WeakMap<CronJob, CronDeliveryRetry>();

	constructor(options: CronManagerOptions) {
		const fixedSessionFile = options.sessionFile ? path.resolve(options.sessionFile) : undefined;
		const getSessionFile = options.getSessionFile;
		this.#tracksSessionMoves = getSessionFile !== undefined;
		this.#getSessionFile = getSessionFile
			? () => {
					const sessionFile = getSessionFile();
					return sessionFile ? path.resolve(sessionFile) : undefined;
				}
			: () => fixedSessionFile;
		this.#getSessionId = options.getSessionId;
		this.#storage = options.storage ?? new FileSessionStorage();
		this.#enqueuePrompt = options.enqueuePrompt;
		this.#now = options.now ?? Date.now;
		this.#setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
		this.#clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
	}

	async prepare(): Promise<void> {
		if (this.#disposed || this.#suspended) return;
		this.#refreshSession();
		const wasLoaded = this.#loadedSessions.has(this.#sessionKey);
		await this.#loadCurrentSession();
		if (!wasLoaded) return;
		await this.#serializeMutation(async () => {
			if (this.#disposed || this.#suspended) return;
			await this.#syncDurableView();
		});
	}

	async load(): Promise<void> {
		this.#started = true;
		await this.prepare();
		this.#armTimer();
	}

	start(): void {
		if (this.#disposed || this.#started) return;
		this.#started = true;
		this.refresh();
	}

	/** Refresh jobs and timers after the live AgentSession changes identity. */
	refresh(): void {
		if (this.#disposed || this.#suspended) return;
		this.#started = true;
		this.#cancelRefreshRetry();
		const generation = ++this.#refreshGeneration;
		this.#refreshSession();
		const sessionKey = this.#sessionKey;
		const load = (attempt: number): void => {
			void this.#loadCurrentSession()
				.then(() => {
					if (generation !== this.#refreshGeneration || sessionKey !== this.#sessionKey) return;
					this.#armTimer();
				})
				.catch(error => {
					logger.warn("Cron session load failed", { error });
					if (
						this.#disposed ||
						this.#suspended ||
						generation !== this.#refreshGeneration ||
						sessionKey !== this.#sessionKey
					) {
						return;
					}
					// Retry for as long as this session stays current instead of
					// abandoning the load after a fixed attempt count. Durable jobs
					// only become schedulable once this lands, so a finite window let
					// an outage that outlived it suppress every persisted job for the
					// rest of the session. The ladder climbs to a ceiling rather than
					// ending; the single retry slot means one timer at a time, and
					// refresh/suspend/dispose all cancel it, so it cannot outlive the
					// session or stack up.
					this.#refreshRetryTimer = this.#setTimer(
						() => {
							this.#refreshRetryTimer = undefined;
							if (
								this.#disposed ||
								this.#suspended ||
								generation !== this.#refreshGeneration ||
								sessionKey !== this.#sessionKey
							) {
								return;
							}
							load(attempt + 1);
						},
						Math.min(REFRESH_RETRY_BASE_MS * 2 ** attempt, REFRESH_RETRY_MAX_MS),
					);
				});
		};
		load(0);
	}

	async suspend(): Promise<void> {
		this.#refreshGeneration++;
		this.#cancelRefreshRetry();
		if (this.#disposed) return;
		this.#suspended = true;
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		await this.#drainMutations();
	}

	async suspendForFork(): Promise<void> {
		this.#completedForkCopy = undefined;
		await this.suspend();
	}

	async copyForkStore(oldSessionFile: string, newSessionFile: string): Promise<void> {
		const oldStore = path.join(sessionSidecarDir(oldSessionFile), "scheduled_tasks.json");
		const newStore = path.join(sessionSidecarDir(newSessionFile), "scheduled_tasks.json");
		const text = await this.#readDurableStore(oldStore);
		if (text !== undefined) await this.#storage.writeTextAtomic(newStore, text);
	}

	async completeFork(
		result: { oldSessionFile: string; newSessionFile: string } | undefined,
		isCurrent: () => boolean = () => true,
	): Promise<void> {
		if (result) {
			const copyKey = `${result.oldSessionFile}\0${result.newSessionFile}`;
			if (this.#completedForkCopy !== copyKey) {
				await this.copyForkStore(result.oldSessionFile, result.newSessionFile);
				this.#completedForkCopy = copyKey;
			}
		}
		if (!isCurrent()) return;
		await this.resume(isCurrent);
		if (isCurrent()) this.#completedForkCopy = undefined;
	}

	async resume(isCurrent: () => boolean = () => true): Promise<void> {
		if (this.#disposed || !isCurrent()) return;
		this.#suspended = false;
		this.#refreshSession();
		this.#loadedSessions.delete(this.#sessionKey);
		await this.#loadCurrentSession();
		if (!isCurrent()) {
			this.#suspended = true;
			if (this.#timer !== undefined) this.#clearTimer(this.#timer);
			this.#timer = undefined;
			return;
		}
		this.#armTimer();
	}

	create(input: { expression: string; prompt: string; recurring?: boolean; durable?: boolean }): Promise<CronJob> {
		return this.#serializeMutation(async () => {
			const durable = input.durable ?? false;
			if (durable) {
				await this.#loadCurrentSession();
			} else {
				// A session-only job neither reads nor writes the durable store, so an
				// unreadable store must not be able to reject it. The session is left
				// deliberately unloaded on failure: `#armTimer` then schedules only the
				// session-only half of the map, and `refresh`'s retry ladder still owns
				// landing the durable view. A later successful load only adds durable
				// entries, so this job survives that reconciliation.
				await this.#loadCurrentSession().catch(error => {
					logger.warn("Cron durable load failed; creating session-only job", { error });
				});
			}
			if (!input.prompt.trim()) throw new Error("Cron prompt cannot be empty.");
			if (durable && !this.#sessionFile) throw new Error("Durable cron jobs require a persisted session.");
			if (durable && !supportsDurableClaims(this.#storage)) {
				throw new Error("Durable cron jobs require storage lease support.");
			}
			parseCronExpression(input.expression);
			const now = this.#now();
			const job: CronJob = {
				id: `cron-${now.toString(36)}-${crypto.randomUUID()}`,
				expression: input.expression.trim(),
				prompt: input.prompt,
				recurring: input.recurring ?? true,
				durable,
				createdAt: now,
				expiresAt: input.recurring === false ? undefined : now + RECURRING_LIFETIME_MS,
				nextFireAt: nextCronFire(input.expression, new Date(now)).getTime(),
			};
			try {
				if (job.durable) {
					await this.#withDurableMutation(() => {
						this.#jobs.set(job.id, job);
					});
				} else {
					this.#jobs.set(job.id, job);
				}
			} catch (error) {
				this.#jobs.delete(job.id);
				throw error;
			}
			this.#started = true;
			this.#armTimer();
			return job;
		});
	}

	list(): CronJob[] {
		this.#refreshSession();
		return [...this.#jobs.values()].sort((a, b) => a.nextFireAt - b.nextFireAt);
	}

	delete(id: string): Promise<boolean> {
		return this.#serializeMutation(async () => {
			this.#refreshSession();
			const cached = this.#jobs.get(id);
			if (cached && !cached.durable) {
				this.#jobs.delete(id);
				this.#armTimer();
				return true;
			}
			await this.#loadCurrentSession();
			let deleted: CronJob | undefined;
			const remove = (): boolean => {
				deleted = this.#jobs.get(id);
				if (!deleted) return false;
				this.#jobs.delete(id);
				return true;
			};
			try {
				const loaded = this.#jobs.get(id);
				const didDelete =
					this.#sessionFile && (!loaded || loaded.durable) ? await this.#withDurableMutation(remove) : remove();
				this.#armTimer();
				return didDelete;
			} catch (error) {
				if (deleted) this.#jobs.set(id, deleted);
				throw error;
			}
		});
	}

	/**
	 * Stop scheduling, then wait for durable custody that is already in flight.
	 *
	 * The guards and timer teardown run before the first await, so no timer,
	 * refresh, or fresh delivery claim can start once disposal begins. An
	 * occurrence whose prompt was already accepted still owns its lease and has
	 * yet to publish `scheduled_tasks.json`, so disposal — and therefore the
	 * SDK's awaited `session.dispose()` — stays pending until that write and the
	 * lease release land. Returning earlier lets an embedder close Redis/SQL
	 * underneath the write and replay the accepted prompt on restart. The drain
	 * is bounded so a wedged storage backend cannot hold teardown open forever.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		this.#refreshGeneration++;
		this.#cancelRefreshRetry();
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		this.#timer = undefined;
		try {
			await withTimeout(
				this.#drainMutations(),
				DISPOSE_DRAIN_TIMEOUT_MS,
				"Timed out draining cron delivery during dispose",
			);
		} catch (error) {
			logger.warn("Cron delivery did not settle during dispose", { error });
		}
	}

	/**
	 * Await the serialized mutation chain — durable claims, lease renewals, and
	 * scheduled task writes — until it stops growing. Mutations queued while the
	 * drain runs (a concurrent `create`/`delete` racing teardown) are covered by
	 * re-reading the tail. Callers reached from inside a mutation would await
	 * their own work, so they return immediately instead.
	 */
	async #drainMutations(): Promise<void> {
		if (mutationScope.getStore()) return;
		let drained: Promise<void> | undefined;
		while (drained !== this.#mutationTail) {
			drained = this.#mutationTail;
			await drained;
		}
	}

	storePath(): string {
		this.#refreshSession();
		if (!this.#sessionFile) throw new Error("Scheduled task storage requires a persisted session.");
		return path.join(sessionSidecarDir(this.#sessionFile), "scheduled_tasks.json");
	}

	async #persist(
		sessionFile: string | undefined = this.#sessionFile,
		jobs: Map<string, CronJob> = this.#jobs,
		sessionKey: string | undefined = this.#sessionKey,
	): Promise<void> {
		if (!sessionFile) return;
		const durable = [...jobs.values()].filter(job => job.durable).sort((a, b) => a.nextFireAt - b.nextFireAt);
		const text = `${JSON.stringify(durable, null, 2)}\n`;
		let target = sessionFile;
		const obsoleteStores: string[] = [];
		const writtenStores: Array<{ store: string; previous: string | undefined }> = [];
		try {
			while (target) {
				const store = path.join(sessionSidecarDir(target), "scheduled_tasks.json");
				const previous = this.#tracksSessionMoves
					? await this.#storage.readText(store).catch(async error => {
							if (isEnoent(error) || !(await this.#storage.exists(store))) return undefined;
							throw error;
						})
					: undefined;
				await this.#storage.writeTextAtomic(store, text);
				writtenStores.push({ store, previous });
				const currentFileValue = this.#getSessionFile();
				const currentFile = currentFileValue ? path.resolve(currentFileValue) : undefined;
				const currentKey = this.#getSessionId?.() ?? currentFile;
				if (!currentFile || currentKey !== sessionKey || currentFile === target) break;
				obsoleteStores.push(store);
				target = currentFile;
			}
		} catch (error) {
			const rollbackErrors: unknown[] = [];
			for (const written of writtenStores.reverse()) {
				try {
					if (written.previous === undefined) await this.#storage.unlink(written.store);
					else await this.#storage.writeTextAtomic(written.store, written.previous);
				} catch (rollbackError) {
					if (!isEnoent(rollbackError) || written.previous !== undefined) rollbackErrors.push(rollbackError);
				}
			}
			if (rollbackErrors.length > 0) {
				throw new AggregateError([error, ...rollbackErrors], "Failed to publish or restore scheduled task stores");
			}
			throw error;
		}
		const canonicalStore = path.join(sessionSidecarDir(target), "scheduled_tasks.json");
		for (const store of obsoleteStores) {
			if (store === canonicalStore) continue;
			await this.#storage.unlink(store).catch(error => {
				if (!isEnoent(error)) {
					logger.warn("Failed to remove obsolete cron job store", { store, error });
				}
			});
		}
	}

	async #withDurableMutation<T>(mutation: () => T): Promise<T> {
		const sessionFile = this.#sessionFile;
		const sessionKey = this.#sessionKey;
		const jobs = this.#jobs;
		const generation = this.#refreshGeneration;
		if (!sessionFile) throw new Error("Durable cron jobs require a persisted session.");
		const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
		let claim: CronDeliveryClaim | undefined;
		while (!claim) {
			if (
				this.#disposed ||
				this.#suspended ||
				generation !== this.#refreshGeneration ||
				this.#sessionFile !== sessionFile ||
				this.#sessionKey !== sessionKey
			) {
				throw new Error("Cron session changed while acquiring durable storage.");
			}
			claim = await acquireDeliveryClaim(store, this.#storage, this.#now());
			if (!claim) await Bun.sleep(DURABLE_MUTATION_CLAIM_RETRY_MS);
		}
		const maintenance = maintainDeliveryClaim(claim, this.#now);
		try {
			this.#refreshSession();
			if (this.#sessionFile !== sessionFile || this.#sessionKey !== sessionKey || this.#jobs !== jobs) {
				throw new Error("Cron session changed while acquiring durable storage.");
			}
			await this.#reloadDurableJobs(sessionFile, jobs);
			const result = mutation();
			if (!(await maintenance.renew())) throw new Error("Cron delivery lease was lost.");
			await this.#persist(sessionFile, jobs, sessionKey);
			return result;
		} finally {
			await maintenance.stop();
			await releaseDeliveryClaim(claim);
		}
	}

	async #readDurableStore(store: string): Promise<string | undefined> {
		await this.#storage.refresh?.();
		return this.#storage.readText(store).catch(async error => {
			if (isEnoent(error) || !(await this.#storage.exists(store))) return undefined;
			throw error;
		});
	}

	async #reloadDurableJobs(sessionFile: string, jobs: Map<string, CronJob>, normalizeOverdue = false): Promise<void> {
		const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
		const text = await this.#readDurableStore(store);
		const retries = new Map<string, CronDeliveryRetry>();
		for (const job of jobs.values()) {
			if (!job.durable) continue;
			const retry = this.#deliveryRetries.get(job);
			if (retry) retries.set(`${job.id}\0${job.nextFireAt}`, retry);
			jobs.delete(job.id);
		}
		if (text === undefined) return;
		for (const job of parseStoredJobs(text, this.#now(), normalizeOverdue)) {
			jobs.set(job.id, job);
			const retry = retries.get(`${job.id}\0${job.nextFireAt}`);
			if (retry) this.#deliveryRetries.set(job, retry);
		}
	}

	#cancelRefreshRetry(): void {
		if (this.#refreshRetryTimer === undefined) return;
		this.#clearTimer(this.#refreshRetryTimer);
		this.#refreshRetryTimer = undefined;
	}

	#refreshSession(): void {
		const sessionFileValue = this.#getSessionFile();
		const sessionFile = sessionFileValue ? path.resolve(sessionFileValue) : undefined;
		const sessionKey = this.#getSessionId?.() ?? sessionFile;
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
	}

	/**
	 * Re-read the durable half of the current session's store. `#loadedSessions`
	 * records only that a first load happened, so on its own it pins this manager
	 * to whatever the store held then — but the store is shared, and a peer
	 * manager on the same session can add a durable job and exit before its fire
	 * time. `prepare()` runs this on every entry (`load()`, and so `cron_list`)
	 * so a peer's job becomes visible and gets a timer instead of waiting for a
	 * session transition, restart, or local durable mutation.
	 *
	 * Session-only jobs and delivery retries are preserved by `#reloadDurableJobs`.
	 * `prepare()` serializes this refresh with create, delete, and due delivery, so
	 * it cannot reinsert an occurrence while its delivery is awaiting acceptance.
	 * No durable claim is needed because this only publishes a snapshot that a
	 * peer writer committed atomically.
	 */
	async #syncDurableView(): Promise<void> {
		this.#refreshSession();
		const sessionFile = this.#sessionFile;
		if (!sessionFile || !this.#loadedSessions.has(this.#sessionKey)) return;
		await this.#reloadDurableJobs(sessionFile, this.#jobs);
	}
	async #loadCurrentSession(): Promise<void> {
		this.#refreshSession();
		const sessionKey = this.#sessionKey;
		if (this.#loadedSessions.has(sessionKey)) return;
		let load = this.#sessionLoads.get(sessionKey);
		if (!load) {
			const sessionFile = this.#sessionFile;
			const jobs = this.#jobs;
			load = (async () => {
				if (sessionFile) {
					const store = path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json");
					const text = await this.#readDurableStore(store);
					if (text !== undefined) {
						for (const job of parseStoredJobs(text, this.#now())) jobs.set(job.id, job);
					}
				}
				this.#loadedSessions.add(sessionKey);
			})().finally(() => {
				if (this.#sessionLoads.get(sessionKey) === load) this.#sessionLoads.delete(sessionKey);
			});
			this.#sessionLoads.set(sessionKey, load);
		}
		await load;
	}

	#nextAttemptAt(job: CronJob): number {
		return Math.max(job.nextFireAt, this.#deliveryRetries.get(job)?.retryAt ?? 0);
	}

	/**
	 * Push a job's next attempt onto the bounded exponential ladder. Every
	 * failure path shares this so a job can never come back due at the same
	 * instant it failed, which is what keeps `#armTimer` from re-entering the
	 * due loop with a zero delay.
	 */
	#backOffDelivery(job: CronJob, failedAt: number, delivered?: boolean): void {
		const prior = this.#deliveryRetries.get(job);
		const attempts = (prior?.attempts ?? 0) + 1;
		const retryDelay = Math.min(DELIVERY_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6), DELIVERY_RETRY_MAX_MS);
		this.#deliveryRetries.set(job, {
			attempts,
			retryAt: failedAt + retryDelay,
			delivered: delivered ?? prior?.delivered ?? false,
		});
	}

	/**
	 * Hold a durable occurrence back for another pass. Contention with a peer
	 * that holds the claim is expected and retries flat; a durable backend that
	 * failed outright climbs the ladder so an outage cannot be re-probed on
	 * every wake.
	 */
	#deferDurableAttempt(job: CronJob, now: number, failed: boolean): void {
		if (failed) {
			this.#backOffDelivery(job, now);
			return;
		}
		this.#deliveryRetries.set(job, {
			attempts: 0,
			retryAt: now + DELIVERY_CLAIM_RETRY_MS,
			delivered: false,
		});
	}

	#isRecurringExpired(job: CronJob, now: number): boolean {
		if (!job.recurring || job.expiresAt === undefined) return false;
		// An occurrence that came due inside the lifetime is still owed its
		// delivery. `#backOffDelivery` parks the retry past `expiresAt`, so
		// retiring on the wall clock alone drops the final prompt precisely
		// because its first attempt failed. Retirement therefore keys off when the
		// occurrence was DUE (`job.nextFireAt`) rather than when it will next be
		// attempted (`#nextAttemptAt`, which folds in `retryAt`), and only while a
		// retry is actually pending — without that a long-overdue occurrence would
		// also be resurrected after a suspend, which nothing asks for.
		//
		// The reprieve is bounded. The delivery ladder caps at
		// `DELIVERY_RETRY_MAX_MS` and never gives up, so an occurrence that can
		// never be delivered would otherwise retry every minute for the life of
		// the session. `EXPIRY_RETRY_GRACE_MS` past `expiresAt` the job retires
		// undelivered, which is the old behaviour, just no longer immediate.
		if (
			this.#deliveryRetries.get(job) !== undefined &&
			job.nextFireAt <= job.expiresAt &&
			now <= job.expiresAt + EXPIRY_RETRY_GRACE_MS
		) {
			return false;
		}
		return job.expiresAt < now || (job.expiresAt === now && this.#nextAttemptAt(job) > now);
	}

	#armTimer(): void {
		if (this.#disposed || this.#suspended || !this.#started) return;
		this.#refreshSession();
		// `#loadedSessions` records that the durable view is authoritative, which
		// is a precondition for scheduling durable jobs only — arming on a map that
		// is missing every entry of an unreadable store would be a silent partial
		// schedule. Session-only jobs need no storage at all, so while the load is
		// still outstanding the loop arms for those alone rather than not at all;
		// otherwise a durable outage starves work that never touches the store, and
		// a session-only job accepted during the outage would never fire.
		const durableLoaded = this.#loadedSessions.has(this.#sessionKey);
		if (this.#timer !== undefined) this.#clearTimer(this.#timer);
		let wakeAt: number | undefined;
		for (const job of this.#jobs.values()) {
			if (!durableLoaded && job.durable) continue;
			const nextAttemptAt = this.#nextAttemptAt(job);
			// A recurring job also wakes the loop at its expiry so the sweep can
			// retire it, but that instant is already in the past once retiring a
			// durable entry has failed. Honour the retry there too, otherwise the
			// stale expiry pins the delay at zero and spins the failing backend.
			const expiryWakeAt =
				job.expiresAt === undefined
					? Number.POSITIVE_INFINITY
					: Math.max(job.expiresAt, this.#deliveryRetries.get(job)?.retryAt ?? 0);
			const candidate = job.recurring ? Math.min(nextAttemptAt, expiryWakeAt) : nextAttemptAt;
			if (wakeAt === undefined || candidate < wakeAt) wakeAt = candidate;
		}
		if (wakeAt === undefined) {
			this.#timer = undefined;
			return;
		}
		const delay = Math.max(0, Math.min(wakeAt - this.#now(), 2_147_000_000));
		this.#timer = this.#setTimer(() => {
			this.#timer = undefined;
			if (this.#disposed || this.#suspended) return;
			// `#processDue` opens with the same load, so calling it here too would
			// only duplicate it — and now that the loop can be armed before the
			// durable view lands, a rejection here would escape this `void` instead
			// of being contained by the pass.
			void this.#serializeMutation(() => this.#processDue());
		}, delay);
	}

	#serializeMutation<T>(mutation: () => Promise<T>): Promise<T> {
		// Run the body inside the mutation scope so anything it awaits — notably
		// `#enqueuePrompt`, which can hand control to session teardown — is seen
		// as re-entrant by `#drainMutations`.
		const scoped = (): Promise<T> => mutationScope.run(true, mutation);
		const task = this.#mutationTail.then(scoped, scoped);
		this.#mutationTail = task.then(
			() => undefined,
			() => undefined,
		);
		return task;
	}

	async #processDue(): Promise<void> {
		if (this.#disposed || this.#suspended) return;
		// An unreadable durable store must not abort the pass. The due loop below
		// contains durable work behind its own claim and reload and defers it when
		// either fails, so session-only occurrences still reach delivery; the
		// session stays unloaded, so durable entries keep waiting for the ladder.
		await this.#loadCurrentSession().catch(error => {
			logger.warn("Cron session load failed", { error });
		});
		if (this.#processing) return;
		this.#processing = true;
		let sessionFile = this.#sessionFile;
		const sessionKey = this.#sessionKey;
		const jobs = this.#jobs;
		try {
			// Deliver every due job as soon as it fires, whether the turn is active
			// or idle. `AgentSession.deliverScheduledPrompt` routes the notification
			// to the next tool-call boundary while streaming and wakes a turn while
			// idle. Starting the full due set before awaiting preserves one batch.
			while (true) {
				if (this.#disposed || this.#suspended) break;
				this.#refreshSession();
				if (this.#sessionKey !== sessionKey || this.#jobs !== jobs) break;
				sessionFile = this.#sessionFile;
				const now = this.#now();
				const needsDurableClaim = [...jobs.values()].some(
					candidate =>
						candidate.durable &&
						(this.#nextAttemptAt(candidate) <= now || this.#isRecurringExpired(candidate, now)),
				);
				// A failing durable backend must not take the whole batch down with
				// it: claiming and reloading are contained here so session-only
				// occurrences, which need neither, still reach delivery below.
				let durableFailed = false;
				let claim: CronDeliveryClaim | undefined;
				if (needsDurableClaim && sessionFile) {
					try {
						claim = await acquireDeliveryClaim(
							path.join(sessionSidecarDir(sessionFile), "scheduled_tasks.json"),
							this.#storage,
							now,
						);
					} catch (error) {
						durableFailed = true;
						logger.warn("Cron durable delivery claim failed", { error });
					}
				}
				const maintenance = maintainDeliveryClaim(claim, this.#now);
				try {
					if (claim && sessionFile) {
						try {
							await this.#reloadDurableJobs(sessionFile, jobs);
						} catch (error) {
							// The durable view is now unreliable, so durable entries are
							// deferred rather than acted on; the claim is still released
							// by this block's `finally`.
							durableFailed = true;
							logger.warn("Cron durable job reload failed", { error });
						}
					}
					const durableReady = claim !== undefined && !durableFailed;

					let durableExpired = false;
					for (const candidate of jobs.values()) {
						if (this.#isRecurringExpired(candidate, now)) {
							if (candidate.durable && !durableReady) {
								this.#deferDurableAttempt(candidate, now, durableFailed);
								continue;
							}
							jobs.delete(candidate.id);
							if (candidate.durable) durableExpired = true;
						}
					}
					if (durableExpired) {
						if (!(await maintenance.renew())) throw new Error("Cron delivery lease was lost.");
						await this.#persist(sessionFile, jobs, sessionKey);
					}
					let due = [...jobs.values()]
						.sort((a, b) => this.#nextAttemptAt(a) - this.#nextAttemptAt(b))
						.filter(candidate => this.#nextAttemptAt(candidate) <= now);
					if (needsDurableClaim && !durableReady) {
						for (const candidate of due) {
							if (!candidate.durable) continue;
							this.#deferDurableAttempt(candidate, now, durableFailed);
						}
						due = due.filter(candidate => !candidate.durable);
					}
					if (due.length === 0) {
						break;
					}

					const deliveries = due.map(job => {
						const previousNextFireAt = job.nextFireAt;
						if (job.recurring) {
							const next = nextCronFire(job.expression, new Date(Math.max(job.nextFireAt, now)));
							// `expiresAt` is inclusive, matching `#isRecurringExpired` and
							// `parseStoredJobs`: a match landing exactly on it is the final
							// occurrence and still gets delivered. Retiring on equality here
							// would drop that boundary occurrence while advancing past the one
							// before it. The job is retired on the following pass instead, once
							// its next match is strictly later than `expiresAt`.
							if (job.expiresAt !== undefined && next.getTime() > job.expiresAt) jobs.delete(job.id);
							else job.nextFireAt = next.getTime();
						} else {
							jobs.delete(job.id);
						}
						return {
							job,
							previousNextFireAt,
							priorRetry: this.#deliveryRetries.get(job),
						};
					});
					const restore = (delivery: (typeof deliveries)[number]): void => {
						delivery.job.nextFireAt = delivery.previousNextFireAt;
						jobs.set(delivery.job.id, delivery.job);
					};
					if (this.#disposed || this.#suspended) {
						for (const delivery of deliveries) restore(delivery);
						break;
					}
					this.#refreshSession();
					if (this.#sessionKey !== sessionKey || this.#jobs !== jobs) {
						for (const delivery of deliveries) restore(delivery);
						break;
					}
					sessionFile = this.#sessionFile;

					const outcomes = await Promise.allSettled(
						deliveries.map(delivery =>
							delivery.priorRetry?.delivered ? Promise.resolve() : this.#enqueuePrompt(delivery.job.prompt),
						),
					);
					let deliveryError: unknown;
					for (const [index, outcome] of outcomes.entries()) {
						if (outcome.status === "fulfilled") continue;
						const delivery = deliveries[index];
						if (!delivery) continue;
						restore(delivery);
						this.#backOffDelivery(delivery.job, this.#now(), false);
						deliveryError ??= outcome.reason;
					}

					const durableAccepted = deliveries.filter(
						(delivery, index) => delivery.job.durable && outcomes[index]?.status === "fulfilled",
					);
					try {
						if (durableAccepted.length > 0) {
							if (!(await maintenance.renew())) throw new Error("Cron delivery lease was lost.");
							await this.#persist(sessionFile, jobs, sessionKey);
						}
					} catch (error) {
						for (const delivery of durableAccepted) {
							restore(delivery);
							this.#backOffDelivery(delivery.job, this.#now(), true);
						}
						throw error;
					}
					for (const [index, delivery] of deliveries.entries()) {
						if (outcomes[index]?.status === "fulfilled") this.#deliveryRetries.delete(delivery.job);
					}
					if (deliveryError !== undefined) throw deliveryError;
					// The session-only half of a mixed batch is delivered; durable
					// entries are on the retry ladder. Re-probing the failed backend
					// in another iteration would only repeat the failure.
					if (durableFailed) break;
				} finally {
					await maintenance.stop();
					if (claim) await releaseDeliveryClaim(claim);
				}
			}
		} catch (error) {
			// Back off every occurrence still overdue at the failure, durable or
			// not. A session-only job left due here would make `#armTimer` re-arm
			// at zero delay and spin the loop through the same failure. Entries
			// that already took a retry above keep it, so bounds stay intact.
			const failedAt = this.#now();
			for (const job of jobs.values()) {
				if (this.#nextAttemptAt(job) > failedAt) continue;
				this.#backOffDelivery(job, failedAt);
			}
			logger.warn("Cron job delivery failed", { error });
		} finally {
			this.#processing = false;
			if (!this.#disposed && !this.#suspended) this.#armTimer();
		}
	}
}

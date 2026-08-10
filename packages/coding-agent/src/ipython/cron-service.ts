import type { CronJob, CronManager, CronUpdatePatch } from "../cron";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_ID_CHARS = 256;
const MAX_EXPRESSION_CHARS = 256;
const MAX_PROMPT_CHARS = 65_536;

export interface IpythonCronServiceOptions {
	readonly owner: (request: IpythonHostRequest) => CronManager;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string, max: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${name} must be a nonempty string`);
	}
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalString(data: Readonly<Record<string, unknown>>, name: string, max: number): string | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	return requiredString(data, name, max);
}

function optionalBoolean(data: Readonly<Record<string, unknown>>, name: string): boolean | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function publicJob(job: CronJob): Readonly<Record<string, unknown>> {
	return {
		id: job.id,
		expression: job.expression,
		prompt: job.prompt,
		recurring: job.recurring,
		durable: job.durable,
		created_at: job.createdAt,
		...(job.expiresAt === undefined ? {} : { expires_at: job.expiresAt }),
		next_fire_at: job.nextFireAt,
	};
}

/** Exposes the session's CronManager through the typed IPython host protocol. */
export class IpythonCronService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonCronServiceOptions) {
		this.handlers = {
			"cron.create": request => this.#create(request),
			"cron.list": request => this.#list(request),
			"cron.update": request => this.#update(request),
			"cron.delete": request => this.#delete(request),
		};
	}

	#getManager(request: IpythonHostRequest): CronManager {
		request.signal.throwIfAborted();
		return this.options.owner(request);
	}

	async #create(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["expression", "prompt", "recurring", "durable"]);
		const expression = requiredString(request.data, "expression", MAX_EXPRESSION_CHARS);
		const prompt = requiredString(request.data, "prompt", MAX_PROMPT_CHARS);
		const recurring = optionalBoolean(request.data, "recurring");
		const durable = optionalBoolean(request.data, "durable");
		const cron = this.#getManager(request);
		request.signal.throwIfAborted();
		const job = await cron.create({ expression, prompt, recurring, durable });
		request.signal.throwIfAborted();
		return { job: publicJob(job) };
	}

	async #list(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, []);
		const cron = this.#getManager(request);
		request.signal.throwIfAborted();
		await cron.prepare();
		request.signal.throwIfAborted();
		return { jobs: cron.list().map(publicJob) };
	}

	async #update(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["id", "expression", "prompt", "recurring"]);
		const id = requiredString(request.data, "id", MAX_ID_CHARS);
		const patch: CronUpdatePatch = {
			expression: optionalString(request.data, "expression", MAX_EXPRESSION_CHARS),
			prompt: optionalString(request.data, "prompt", MAX_PROMPT_CHARS),
			recurring: optionalBoolean(request.data, "recurring"),
		};
		if (patch.expression === undefined && patch.prompt === undefined && patch.recurring === undefined) {
			throw new TypeError("update requires at least one field");
		}
		const cron = this.#getManager(request);
		request.signal.throwIfAborted();
		const job = await cron.update(id, patch);
		request.signal.throwIfAborted();
		return { job: job ? publicJob(job) : null };
	}

	async #delete(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["id"]);
		const id = requiredString(request.data, "id", MAX_ID_CHARS);
		const cron = this.#getManager(request);
		request.signal.throwIfAborted();
		const deleted = await cron.delete(id);
		request.signal.throwIfAborted();
		return { deleted };
	}
}

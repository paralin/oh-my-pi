import { type } from "arktype";
import type { ExtensionFactory, ToolDefinition } from "../extensibility/extensions";

const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_MESSAGE_LENGTH = 25_000;

const cronSchema = type({
	action: "'set' | 'cancel' | 'list'",
	"delay_seconds?": type("number").describe("seconds to wait before the first delivery"),
	"interval_seconds?": type("number").describe("seconds between recurring deliveries; omit for a one-shot timer"),
	"message?": type("string").describe("user message to deliver when the timer fires"),
	"id?": type("string").describe("scheduled timer id to cancel"),
});

export type CronParams = typeof cronSchema.infer;

interface CronJob {
	id: string;
	message: string;
	dueAt: number;
	intervalMs?: number;
	timer?: NodeJS.Timeout;
}

export interface CronDetails {
	jobs: Array<{ id: string; message: string; dueAt: string; intervalSeconds?: number }>;
}

export type CronTool = ToolDefinition<typeof cronSchema, CronDetails>;

export interface CronRuntime {
	tool: CronTool;
	dispose(): void;
}

interface CronMessageAPI {
	sendUserMessage(content: string, options: { deliverAs: "followUp" }): void;
}

function jobDetails(jobs: Iterable<CronJob>): CronDetails {
	return {
		jobs: Array.from(jobs, job => ({
			id: job.id,
			message: job.message,
			dueAt: new Date(job.dueAt).toISOString(),
			...(job.intervalMs === undefined ? {} : { intervalSeconds: job.intervalMs / 1_000 }),
		})),
	};
}

export function createCronRuntime(api: CronMessageAPI, now: () => number = Date.now): CronRuntime {
	const jobs = new Map<string, CronJob>();
	const schedule = (job: CronJob, delayMs: number): void => {
		job.dueAt = now() + delayMs;
		job.timer = setTimeout(() => {
			if (jobs.get(job.id) !== job) return;
			if (job.intervalMs === undefined) jobs.delete(job.id);
			else schedule(job, job.intervalMs);
			api.sendUserMessage(job.message, { deliverAs: "followUp" });
		}, delayMs);
	};
	const tool: CronTool = {
		name: "cron",
		label: "Cron",
		description:
			"Schedule an in-process one-shot or recurring timer that delivers a user message to this model session. Recurring timers coalesce missed intervals after suspension into one delivery. Use list or cancel to inspect or remove timers. Timers exist only while this OMP process is running.",
		parameters: cronSchema,
		async execute(_toolCallId, params) {
			if (params.action === "list") {
				const details = jobDetails(jobs.values());
				return {
					content: [
						{
							type: "text",
							text:
								details.jobs.length === 0
									? "No timers scheduled."
									: `${details.jobs.length} timer(s) scheduled.`,
						},
					],
					details,
				};
			}

			if (params.action === "cancel") {
				if (!params.id) throw new Error("id is required when action is cancel");
				const job = jobs.get(params.id);
				if (!job) throw new Error(`Unknown cron timer: ${params.id}`);
				clearTimeout(job.timer);
				jobs.delete(job.id);
				return {
					content: [{ type: "text", text: `Cancelled timer ${job.id}.` }],
					details: jobDetails(jobs.values()),
				};
			}

			if (
				!Number.isFinite(params.delay_seconds) ||
				params.delay_seconds === undefined ||
				params.delay_seconds <= 0
			) {
				throw new Error("delay_seconds must be a positive finite number when action is set");
			}
			if (params.delay_seconds > MAX_DELAY_SECONDS) {
				throw new Error(`delay_seconds cannot exceed ${MAX_DELAY_SECONDS}`);
			}
			if (
				params.interval_seconds !== undefined &&
				(!Number.isFinite(params.interval_seconds) || params.interval_seconds <= 0)
			) {
				throw new Error("interval_seconds must be a positive finite number when provided");
			}
			if (params.interval_seconds !== undefined && params.interval_seconds > MAX_DELAY_SECONDS) {
				throw new Error(`interval_seconds cannot exceed ${MAX_DELAY_SECONDS}`);
			}
			const message = params.message?.trim();
			if (!message) throw new Error("message is required when action is set");
			if (message.length > MAX_MESSAGE_LENGTH) {
				throw new Error(`message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
			}

			const job: CronJob = {
				id: crypto.randomUUID(),
				message,
				dueAt: 0,
				intervalMs: params.interval_seconds === undefined ? undefined : params.interval_seconds * 1_000,
			};
			jobs.set(job.id, job);
			schedule(job, params.delay_seconds * 1_000);
			return {
				content: [{ type: "text", text: `Scheduled timer ${job.id} for ${new Date(job.dueAt).toISOString()}.` }],
				details: jobDetails(jobs.values()),
			};
		},
	};

	return {
		tool,
		dispose() {
			for (const job of jobs.values()) clearTimeout(job.timer);
			jobs.clear();
		},
	};
}

export const createCronExtension: ExtensionFactory = api => {
	const runtime = createCronRuntime(api);
	api.registerTool(runtime.tool);
	api.on("session_shutdown", () => runtime.dispose());
};

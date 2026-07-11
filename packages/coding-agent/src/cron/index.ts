import { type } from "arktype";
import type { ExtensionFactory, ToolDefinition } from "../extensibility/extensions";

const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
const MAX_MESSAGE_LENGTH = 25_000;

const cronSchema = type({
	action: "'set' | 'cancel' | 'list'",
	"delay_seconds?": type("number").describe("seconds to wait before delivering the user message"),
	"message?": type("string").describe("user message to deliver when the timer fires"),
	"id?": type("string").describe("scheduled timer id to cancel"),
});

export type CronParams = typeof cronSchema.infer;

interface CronJob {
	id: string;
	message: string;
	dueAt: number;
	timer: NodeJS.Timeout;
}

export interface CronDetails {
	jobs: Array<{ id: string; message: string; dueAt: string }>;
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
		})),
	};
}

export function createCronRuntime(api: CronMessageAPI): CronRuntime {
	const jobs = new Map<string, CronJob>();
	const tool: CronTool = {
		name: "cron",
		label: "Cron",
		description:
			"Schedule an in-process one-shot timer that delivers a user message to this model session. Use list or cancel to inspect or remove timers. Timers exist only while this OMP process is running.",
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
			const message = params.message?.trim();
			if (!message) throw new Error("message is required when action is set");
			if (message.length > MAX_MESSAGE_LENGTH) {
				throw new Error(`message cannot exceed ${MAX_MESSAGE_LENGTH} characters`);
			}

			const id = crypto.randomUUID();
			const dueAt = Date.now() + params.delay_seconds * 1_000;
			const timer = setTimeout(() => {
				jobs.delete(id);
				api.sendUserMessage(message, { deliverAs: "followUp" });
			}, params.delay_seconds * 1_000);
			jobs.set(id, { id, message, dueAt, timer });
			return {
				content: [{ type: "text", text: `Scheduled timer ${id} for ${new Date(dueAt).toISOString()}.` }],
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

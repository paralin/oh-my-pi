import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import type { CronJob } from "../cron";
import cronCreateDescription from "../prompts/tools/cron-create.md" with { type: "text" };
import cronDeleteDescription from "../prompts/tools/cron-delete.md" with { type: "text" };
import cronListDescription from "../prompts/tools/cron-list.md" with { type: "text" };
import type { ToolSession } from ".";

const cronCreateSchema = type({
	expression: type("string").describe("standard 5-field cron expression evaluated in local time"),
	prompt: type("string").describe("user prompt to enqueue when the job fires"),
	"recurring?": type("boolean").describe("repeat on each match; default true, otherwise fire once and auto-delete"),
	"durable?": type("boolean").describe("persist across sessions; default false for session-only in-memory jobs"),
});
const cronListSchema = type({});
const cronDeleteSchema = type({ id: type("string").describe("job id returned by cron_create or cron_list") });

type CronCreateParams = typeof cronCreateSchema.infer;
type CronDeleteParams = typeof cronDeleteSchema.infer;

function formatJob(job: CronJob): string {
	const expiry = job.expiresAt === undefined ? "no expiry" : `expires ${new Date(job.expiresAt).toLocaleString()}`;
	return `${job.id} | ${job.expression} | next ${new Date(job.nextFireAt).toLocaleString()} | ${job.recurring ? `recurring, ${expiry}` : "one-shot"} | ${job.durable ? "durable" : "session-only"}`;
}

export class CronCreateTool implements AgentTool<typeof cronCreateSchema> {
	readonly name = "cron_create";
	readonly approval = "read" as const;
	readonly label = "Cron Create";
	readonly summary = "Schedule a prompt for a later idle turn";
	readonly description = cronCreateDescription;
	readonly parameters = cronCreateSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: CronCreateParams): Promise<AgentToolResult> {
		const manager = this.session.cronManager;
		if (!manager) throw new Error("Cron scheduling is not available in this session.");
		const job = await manager.create(params);
		return { content: [{ type: "text", text: `Scheduled ${formatJob(job)}.` }], details: job };
	}
}

export class CronListTool implements AgentTool<typeof cronListSchema> {
	readonly name = "cron_list";
	readonly approval = "read" as const;
	readonly label = "Cron List";
	readonly summary = "List scheduled prompt jobs";
	readonly description = cronListDescription;
	readonly parameters = cronListSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(): Promise<AgentToolResult> {
		const manager = this.session.cronManager;
		if (!manager) throw new Error("Cron scheduling is not available in this session.");
		const jobs = manager.list();
		return {
			content: [{ type: "text", text: jobs.length === 0 ? "No scheduled jobs." : jobs.map(formatJob).join("\n") }],
			details: { jobs },
		};
	}
}

export class CronDeleteTool implements AgentTool<typeof cronDeleteSchema> {
	readonly name = "cron_delete";
	readonly approval = "read" as const;
	readonly label = "Cron Delete";
	readonly summary = "Delete a scheduled prompt job";
	readonly description = cronDeleteDescription;
	readonly parameters = cronDeleteSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	async execute(_id: string, params: CronDeleteParams): Promise<AgentToolResult> {
		const manager = this.session.cronManager;
		if (!manager) throw new Error("Cron scheduling is not available in this session.");
		const deleted = await manager.delete(params.id);
		return {
			content: [{ type: "text", text: deleted ? `Deleted ${params.id}.` : `No job found for ${params.id}.` }],
			details: { deleted },
		};
	}
}

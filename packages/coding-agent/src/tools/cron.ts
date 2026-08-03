import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { CronJob } from "../cron";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import cronCreateDescription from "../prompts/tools/cron-create.md" with { type: "text" };
import cronDeleteDescription from "../prompts/tools/cron-delete.md" with { type: "text" };
import cronListDescription from "../prompts/tools/cron-list.md" with { type: "text" };
import { renderStatusLine, truncateToWidth } from "../tui";
import type { ToolSession } from ".";
import { createCachedComponent, formatMoreItems, PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS } from "./render-utils";

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
	readonly approval = "write" as const;
	readonly label = "Cron Create";
	readonly summary = "Schedule a prompt on a cron expression";
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
		await manager.load();
		const jobs = manager.list();
		return {
			content: [{ type: "text", text: jobs.length === 0 ? "No scheduled jobs." : jobs.map(formatJob).join("\n") }],
			details: { jobs },
		};
	}
}

export class CronDeleteTool implements AgentTool<typeof cronDeleteSchema> {
	readonly name = "cron_delete";
	readonly approval = "write" as const;
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

// =============================================================================
// TUI Renderer
// =============================================================================

type CronRenderOperation = "create" | "list" | "delete";
type CronRenderArgs = Partial<CronCreateParams & CronDeleteParams>;
type CronRenderDetails = CronJob | { jobs: CronJob[] } | { deleted: boolean };

function cronDisplayLine(text: string): string {
	return replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " ");
}

function isCronJob(details: CronRenderDetails | undefined): details is CronJob {
	return details !== undefined && "expression" in details;
}

function cronMode(job: CronJob): string[] {
	const mode = [job.recurring ? "recurring" : "one-shot", job.durable ? "durable" : "session-only"];
	if (job.expiresAt !== undefined) mode.push(`expires ${new Date(job.expiresAt).toLocaleString()}`);
	return mode;
}

function cronJobRow(job: CronJob, theme: Theme): string {
	return [
		theme.fg("accent", cronDisplayLine(job.expression)),
		theme.fg("dim", cronDisplayLine(job.id)),
		theme.fg("dim", `next ${new Date(job.nextFireAt).toLocaleString()}`),
		...cronMode(job).map(value => theme.fg("dim", value)),
	].join(theme.sep.dot);
}

function createCronRenderer(op: CronRenderOperation) {
	return {
		inline: true,
		mergeCallAndResult: true,
		renderCall(args: CronRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
			const meta =
				op === "create"
					? [
							args.recurring === false ? "one-shot" : "recurring",
							args.durable === true ? "durable" : "session-only",
						]
					: [];
			const header = renderStatusLine(
				{
					icon: "pending",
					title: `Cron ${op}`,
					description:
						op === "create"
							? truncateToWidth(cronDisplayLine(args.expression ?? ""), TRUNCATE_LENGTHS.TITLE)
							: op === "delete"
								? truncateToWidth(cronDisplayLine(args.id ?? ""), TRUNCATE_LENGTHS.TITLE)
								: undefined,
					meta,
				},
				theme,
			);
			return new Text(header, 1, 0);
		},
		renderResult(
			result: { content: Array<{ type: string; text?: string }>; details?: CronRenderDetails; isError?: boolean },
			options: RenderResultOptions,
			theme: Theme,
			args?: CronRenderArgs,
		): Component {
			const details = result.details;
			const text = result.content
				.filter(part => part.type === "text")
				.map(part => part.text ?? "")
				.join("\n")
				.trim();
			const body: string[] = [];
			let description =
				op === "create"
					? truncateToWidth(cronDisplayLine(args?.expression ?? ""), TRUNCATE_LENGTHS.TITLE)
					: op === "delete"
						? truncateToWidth(cronDisplayLine(args?.id ?? ""), TRUNCATE_LENGTHS.TITLE)
						: undefined;
			let meta: string[] = [];
			let icon: "error" | "warning" | undefined;

			if (result.isError) {
				icon = "error";
				body.push(theme.fg("error", cronDisplayLine(text || "Unknown error")));
			} else if (op === "create" && isCronJob(details)) {
				description = truncateToWidth(cronDisplayLine(details.expression), TRUNCATE_LENGTHS.TITLE);
				meta = [theme.fg("dim", `next ${new Date(details.nextFireAt).toLocaleString()}`), ...cronMode(details)];
				body.push(
					`${theme.fg("accent", cronDisplayLine(details.id))} ${theme.fg("dim", cronDisplayLine(details.prompt))}`,
				);
			} else if (op === "list" && details && "jobs" in details) {
				description = `${details.jobs.length} ${details.jobs.length === 1 ? "job" : "jobs"}`;
				body.push(...details.jobs.map(job => cronJobRow(job, theme)));
			} else if (op === "delete" && details && "deleted" in details) {
				meta = [details.deleted ? theme.fg("success", "deleted") : theme.fg("warning", "not found")];
				if (!details.deleted) icon = "warning";
			} else if (text) {
				body.push(theme.fg("toolOutput", cronDisplayLine(text)));
			}

			const header = renderStatusLine(
				{
					...(icon ? { icon } : { iconOverride: theme.styledSymbol("status.done", "accent") }),
					title: `Cron ${op}`,
					description,
					meta,
				},
				theme,
			);

			return createCachedComponent(
				() => options.expanded,
				(width, expanded) => {
					let visible = body;
					if (!expanded && body.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
						const remaining = body.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
						visible = [
							...body.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS),
							theme.fg("dim", formatMoreItems(remaining, "job")),
						];
					}
					return [header, ...visible].map(line => truncateToWidth(line, width));
				},
				{ paddingX: 1 },
			);
		},
	};
}

export const cronCreateToolRenderer = createCronRenderer("create");
export const cronListToolRenderer = createCronRenderer("list");
export const cronDeleteToolRenderer = createCronRenderer("delete");

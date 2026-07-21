import { describe, expect, it } from "bun:test";
import type { CronJob } from "@oh-my-pi/pi-coding-agent/cron";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	cronCreateToolRenderer,
	cronDeleteToolRenderer,
	cronListToolRenderer,
} from "@oh-my-pi/pi-coding-agent/tools/cron";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { sanitizeText } from "@oh-my-pi/pi-utils";

async function theme() {
	const uiTheme = await getThemeByName("dark");
	expect(uiTheme).toBeDefined();
	return uiTheme!;
}

const lines = (component: { render: (width: number) => readonly string[] }, width = 200) =>
	sanitizeText(component.render(width).join("\n")).split("\n");

const job = (overrides: Partial<CronJob> = {}): CronJob => ({
	id: "cron-7f3a",
	expression: "15 9 * * 1-5",
	prompt: "Review the launch queue",
	recurring: true,
	durable: false,
	createdAt: Date.UTC(2026, 6, 20, 12),
	nextFireAt: Date.UTC(2026, 6, 21, 9, 15),
	expiresAt: Date.UTC(2026, 6, 27, 12),
	...overrides,
});

describe("cron rendering", () => {
	it("registers merged renderers for every cron operation", () => {
		expect(Object.is(toolRenderers.cron_create.renderResult, cronCreateToolRenderer.renderResult)).toBe(true);
		expect(Object.is(toolRenderers.cron_list.renderResult, cronListToolRenderer.renderResult)).toBe(true);
		expect(Object.is(toolRenderers.cron_delete.renderResult, cronDeleteToolRenderer.renderResult)).toBe(true);
		expect(toolRenderers.cron_create.mergeCallAndResult).toBe(true);
	});

	it("renders a created schedule with timing, lifetime, storage, id, and prompt", async () => {
		const uiTheme = await theme();
		const schedule = job();
		const rendered = lines(
			cronCreateToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Scheduled." }], details: schedule },
				{ expanded: false, isPartial: false },
				uiTheme,
				{ expression: schedule.expression, prompt: schedule.prompt },
			),
		);

		expect(rendered[0]).toContain("Cron create");
		expect(rendered[0]).toContain(schedule.expression);
		expect(rendered[0]).toContain("next");
		expect(rendered[0]).toContain("recurring");
		expect(rendered[0]).toContain("session-only");
		expect(rendered[1]).toContain(schedule.id);
		expect(rendered[1]).toContain(schedule.prompt);
	});

	it("renders a capped schedule list as structured rows", async () => {
		const uiTheme = await theme();
		const jobs = Array.from({ length: 11 }, (_, index) =>
			job({ id: `cron-${index}`, expression: `${index} 9 * * *`, expiresAt: undefined }),
		);
		const rendered = lines(
			cronListToolRenderer.renderResult(
				{ content: [{ type: "text", text: "" }], details: { jobs } },
				{ expanded: false, isPartial: false },
				uiTheme,
				{},
			),
		);

		expect(rendered[0]).toContain("Cron list");
		expect(rendered[0]).toContain("11 jobs");
		expect(rendered.some(line => line.includes("cron-0") && line.includes("next"))).toBe(true);
		expect(rendered.some(line => line.includes("cron-10"))).toBe(false);
		expect(rendered.some(line => line.includes("3 more jobs"))).toBe(true);
	});

	it("distinguishes deletion from a missing schedule", async () => {
		const uiTheme = await theme();
		const deleted = lines(
			cronDeleteToolRenderer.renderResult(
				{ content: [{ type: "text", text: "Deleted cron-7f3a." }], details: { deleted: true } },
				{ expanded: false, isPartial: false },
				uiTheme,
				{ id: "cron-7f3a" },
			),
		);
		const missing = lines(
			cronDeleteToolRenderer.renderResult(
				{ content: [{ type: "text", text: "No job found." }], details: { deleted: false } },
				{ expanded: false, isPartial: false },
				uiTheme,
				{ id: "cron-missing" },
			),
		);

		expect(deleted[0]).toContain("Cron delete");
		expect(deleted[0]).toContain("deleted");
		expect(missing[0]).toContain("Cron delete");
		expect(missing[0]).toContain("not found");
	});
});

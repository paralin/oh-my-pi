import { describe, expect, test } from "bun:test";

import { buildScheduledNotification } from "../../src/session/scheduled-notification";

function contentText(content: unknown): string {
	if (typeof content !== "string") throw new Error("expected string notification content");
	return content;
}

describe("buildScheduledNotification", () => {
	test("identical fired prompts coalesce into one singular notification", () => {
		const pulse = "Cadence pulse: reconcile lanes and refresh the agenda.";
		const message = buildScheduledNotification([{ prompt: pulse }, { prompt: pulse }, { prompt: `${pulse}\n` }]);
		expect(message).not.toBeNull();
		const text = contentText(message!.content);
		expect(text).toContain("A scheduled task fired.");
		expect(text.match(/<scheduled-task>/g)).toHaveLength(1);
		expect(message!.details).toEqual({ prompts: [pulse] });
	});

	test("distinct prompts keep batching with an accurate count", () => {
		const message = buildScheduledNotification([
			{ prompt: "pulse" },
			{ prompt: "boundary check lane A" },
			{ prompt: "pulse" },
		]);
		expect(message).not.toBeNull();
		const text = contentText(message!.content);
		expect(text).toContain("2 scheduled tasks fired.");
		expect(text.match(/<scheduled-task>/g)).toHaveLength(2);
	});

	test("returns null when every prompt is empty", () => {
		expect(buildScheduledNotification([{ prompt: "" }, { prompt: "  " }])).toBeNull();
	});
});

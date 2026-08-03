import { describe, expect, it } from "bun:test";
import { buildScheduledNotification, formatScheduledNotificationContent } from "../session/scheduled-notification";

/** Native-free proof of the role fix: a fired scheduled prompt becomes a
 *  system-authored (`attribution: "agent"`) custom message, never a synthesized
 *  user turn. This module imports only a type from pi-agent-core, so it exercises
 *  the delivery contract without the native runtime. */
describe("scheduled notification builder", () => {
	it("builds a system-authored notification, not a user turn", () => {
		const message = buildScheduledNotification([{ prompt: "boundary ping" }]);
		expect(message).not.toBeNull();
		expect(message!.role).toBe("custom");
		expect(message!.attribution).toBe("agent");
		expect(message!.attribution).not.toBe("user");
		expect(message!.content).toContain("boundary ping");
		expect(message!.content).toContain("system notification");
	});

	it("batches multiple due jobs into one legible notification", () => {
		const message = buildScheduledNotification([{ prompt: "first" }, { prompt: "second" }]);
		expect(message!.content).toContain("first");
		expect(message!.content).toContain("second");
		expect(message!.content).toContain("2 scheduled tasks fired");
	});

	it("drops empty prompts and returns null when nothing survives", () => {
		expect(buildScheduledNotification([{ prompt: "   " }])).toBeNull();
		const message = buildScheduledNotification([{ prompt: "" }, { prompt: "kept" }]);
		expect(message!.content).toContain("kept");
		expect(message!.content).toContain("A scheduled task fired");
	});

	it("trims each prompt inside its own delimiter", () => {
		const content = formatScheduledNotificationContent(["  padded  "]);
		expect(content).toContain("<scheduled-task>\npadded\n</scheduled-task>");
	});
});

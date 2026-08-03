import type { CustomMessage } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import scheduledNotificationTemplate from "../prompts/system/scheduled-notification.md" with { type: "text" };

/** SCHEDULED_NOTIFICATION_KIND names the yield-queue channel that carries fired
 *  scheduled-prompt (cron) jobs. Streaming turns steer the notification through
 *  the agent loop; idle enqueues wake a turn. */
export const SCHEDULED_NOTIFICATION_KIND = "scheduled";

/** ScheduledNotificationEntry is one fired scheduled-prompt awaiting delivery. */
export interface ScheduledNotificationEntry {
	prompt: string;
}

/** formatScheduledNotificationContent renders one or more fired scheduled
 *  prompts as a single system-authored notification body. Each prompt keeps its
 *  own delimiter so batched deliveries stay individually legible. */
export function formatScheduledNotificationContent(prompts: string[]): string {
	const normalizedPrompts = prompts.map(text => text.trim());
	return prompt.render(scheduledNotificationTemplate, {
		multiple: normalizedPrompts.length > 1,
		prompts: normalizedPrompts,
	});
}

/** buildScheduledNotification batches fired scheduled prompts into one
 *  system-authored (`attribution: "agent"`) custom message. Identical prompts
 *  coalesce to one occurrence: a recurring job that fires repeatedly while a
 *  turn blocks delivery (a cadence pulse) reads as one pending pulse, not a
 *  backlog to be worked through N times. Distinct prompts keep batching. It
 *  never synthesizes a user-role turn. Returns null when no entry carries a
 *  non-empty prompt. */
export function buildScheduledNotification(entries: ScheduledNotificationEntry[]): CustomMessage | null {
	const prompts = [...new Set(entries.map(entry => entry.prompt.trim()).filter(text => text.length > 0))];
	if (prompts.length === 0) return null;
	return {
		role: "custom",
		customType: "scheduled:notification",
		display: true,
		attribution: "agent",
		timestamp: Date.now(),
		content: formatScheduledNotificationContent(prompts),
		details: { prompts },
	};
}

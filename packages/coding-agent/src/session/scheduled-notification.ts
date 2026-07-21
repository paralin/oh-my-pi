import type { CustomMessage } from "@oh-my-pi/pi-agent-core";

/** SCHEDULED_NOTIFICATION_KIND names the yield-queue channel that carries fired
 *  scheduled-prompt (cron) jobs. Streaming turns drain it at the next completed
 *  tool-call boundary; idle enqueues wake a turn. */
export const SCHEDULED_NOTIFICATION_KIND = "scheduled";

/** ScheduledNotificationEntry is one fired scheduled-prompt awaiting delivery. */
export interface ScheduledNotificationEntry {
	prompt: string;
}

/** formatScheduledNotificationContent renders one or more fired scheduled
 *  prompts as a single system-authored notification body. Each prompt keeps its
 *  own delimiter so batched deliveries stay individually legible. */
export function formatScheduledNotificationContent(prompts: string[]): string {
	const header =
		prompts.length === 1
			? "A scheduled task fired. This is a system notification, not a user message; act on it now that the current step has completed."
			: `${prompts.length} scheduled tasks fired. These are system notifications, not user messages; act on them now that the current step has completed.`;
	const body = prompts.map(text => `<scheduled-task>\n${text.trim()}\n</scheduled-task>`).join("\n\n");
	return `${header}\n\n${body}`;
}

/** buildScheduledNotification batches fired scheduled prompts into one
 *  system-authored (`attribution: "agent"`) custom message delivered as a
 *  non-interrupting aside. It never synthesizes a user-role turn. Returns null
 *  when no entry carries a non-empty prompt. */
export function buildScheduledNotification(entries: ScheduledNotificationEntry[]): CustomMessage | null {
	const prompts = entries.map(entry => entry.prompt).filter(text => text.trim().length > 0);
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

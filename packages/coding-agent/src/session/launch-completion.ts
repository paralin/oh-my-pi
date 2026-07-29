import type { DaemonCompletionNotification } from "../launch/protocol";
import type { CustomMessage } from "./messages";

/** Yield-queue kind for broker-owned supervised process completions. */
export const LAUNCH_COMPLETION_MESSAGE_TYPE = "launch-completion";

/** One broker completion awaiting injection into its owning session. */
export type LaunchCompletionEntry = DaemonCompletionNotification;

/** Build one model-visible notification per terminal supervised process exit. */
export function buildLaunchCompletionBatchMessage(entries: LaunchCompletionEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: LAUNCH_COMPLETION_MESSAGE_TYPE,
		content: entries
			.map(({ daemon }) => {
				const exit = daemon.exitCode === undefined ? "without an exit code" : `with exit code ${daemon.exitCode}`;
				return `Supervised process ${daemon.name} ${daemon.state} ${exit}.`;
			})
			.join("\n"),
		display: true,
		attribution: "agent",
		details: { daemons: entries.map(entry => entry.daemon) },
		timestamp: Date.now(),
	};
}

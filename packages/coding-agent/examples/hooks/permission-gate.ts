/**
 * Permission Gate Hook
 *
 * Prompts before an IPython cell contains potentially dangerous shell commands.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: HookAPI) {
	const dangerousPatterns = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

	pi.on("tool_call", async (event, ctx) => {
		const code = event.input.code;
		if (!dangerousPatterns.some(pattern => pattern.test(code))) return;
		if (!ctx.hasUI) {
			return { block: true, reason: "Dangerous cell blocked (no UI for confirmation)" };
		}
		const choice = await ctx.ui.select(`⚠️ Dangerous IPython cell:\n\n  ${code}\n\nAllow?`, ["Yes", "No"]);
		if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
	});
}

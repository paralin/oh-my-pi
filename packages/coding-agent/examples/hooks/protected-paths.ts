/**
 * Protected Paths Hook
 *
 * Blocks IPython cells that reference protected local paths.
 */
import type { HookAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: HookAPI) {
	const protectedPaths = [".env", ".git/", "node_modules/"];

	pi.on("tool_call", (event, ctx) => {
		const path = protectedPaths.find(candidate => event.input.code.includes(candidate));
		if (!path) return;
		if (ctx.hasUI) ctx.ui.notify(`Blocked cell that references protected path: ${path}`, "warning");
		return { block: true, reason: `Path "${path}" is protected` };
	});
}

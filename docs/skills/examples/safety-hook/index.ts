// @ts-nocheck — example file; install @oh-my-pi/pi-coding-agent before running
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/** Block an IPython cell that contains the literal destructive shell command. */
export default function safetyHook(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    const code = String((event.input as { code?: unknown }).code ?? "");
    if (/\brm\s+-rf\s+\//.test(code)) {
      return {
        block: true,
        reason: "safety-hook: refusing to delete the root filesystem",
      };
    }
  });
}

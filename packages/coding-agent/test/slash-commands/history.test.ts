import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntime(slashHistory: boolean | undefined = undefined) {
	const addToHistory = vi.fn();
	const setText = vi.fn();
	const showSettingsSelector = vi.fn();
	const get = vi.fn((path: string) => (path === "tui.slashHistory" ? slashHistory : undefined));
	const submit = vi.fn(() => true);
	const showStatus = vi.fn();
	const showWarning = vi.fn();

	return {
		addToHistory,
		setText,
		showSettingsSelector,
		showStatus,
		showWarning,
		submit,
		runtime: {
			ctx: {
				editor: { addToHistory, setText },
				oauthManualInput: { hasPending: vi.fn(() => false), pendingProviderId: undefined, submit },
				settings: { get },
				showSettingsSelector,
				showStatus,
				showWarning,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("slash command history", () => {
	it("stores built-in slash commands for recall by default", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/settings", harness.runtime)).toBe(true);

		expect(harness.showSettingsSelector).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.addToHistory).toHaveBeenCalledWith("/settings");
	});

	it("respects the slash command history opt-out", async () => {
		const harness = createRuntime(false);

		expect(await executeBuiltinSlashCommand("/settings", harness.runtime)).toBe(true);

		expect(harness.addToHistory).not.toHaveBeenCalled();
	});

	it("does not store OAuth redirect URLs submitted through /login", async () => {
		const harness = createRuntime();
		const callbackUrl = "http://localhost:1455/callback?code=secret-code&state=secret-state";

		expect(await executeBuiltinSlashCommand(`/login ${callbackUrl}`, harness.runtime)).toBe(true);

		expect(harness.submit).toHaveBeenCalledWith(callbackUrl);
		expect(harness.showStatus).toHaveBeenCalledWith("OAuth callback received; completing login…");
		expect(harness.addToHistory).not.toHaveBeenCalled();
	});
});

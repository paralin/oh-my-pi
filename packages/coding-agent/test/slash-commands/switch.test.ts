import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	ACP_BUILTIN_SLASH_COMMANDS,
	executeAcpBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function createRuntime() {
	const showModelSelector = vi.fn();
	const setText = vi.fn();
	return {
		showModelSelector,
		setText,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				showModelSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

function createEffortRuntime(configured: string | undefined = "auto", available: readonly string[] = ["low", "high"]) {
	const setThinkingLevel = vi.fn();
	const configuredThinkingLevel = vi.fn(() => configured);
	const getAvailableThinkingLevels = vi.fn(() => available);
	const output = vi.fn();
	const runtime = {
		session: { configuredThinkingLevel, getAvailableThinkingLevels, setThinkingLevel },
		output,
	} as unknown as SlashCommandRuntime;
	return { configuredThinkingLevel, getAvailableThinkingLevels, setThinkingLevel, output, runtime };
}

describe("/model slash command", () => {
	it("opens the model setup picker for role and thinking assignment", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/model", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector.mock.calls).toEqual([[]]);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/switch slash command", () => {
	it("opens the temporary model selector (mirrors alt+p)", async () => {
		const harness = createRuntime();

		const handled = await executeBuiltinSlashCommand("/switch", harness.runtime);

		expect(handled).toBe(true);
		expect(harness.showModelSelector).toHaveBeenCalledWith({ temporaryOnly: true });
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/effort slash command", () => {
	it("advertises the command alias and ACP input hint", () => {
		const advertised = ACP_BUILTIN_SLASH_COMMANDS.find(command => command.name === "effort");

		expect(advertised).toMatchObject({
			name: "effort",
			description: "Set thinking effort for this session",
			input: { hint: "[off|auto|<level>] [--default]" },
		});
	});

	it("reports the configured level and model-supported choices without arguments", async () => {
		const h = createEffortRuntime("auto", ["low", "high"]);

		const result = await executeAcpBuiltinSlashCommand("/effort", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.setThinkingLevel).not.toHaveBeenCalled();
		expect(h.output).toHaveBeenCalledWith(
			"Current configured thinking level: auto.\nValid levels: off, auto, low, high.",
		);
	});

	it("accepts /thinking as a session-local alias", async () => {
		const h = createEffortRuntime("high", ["low", "high"]);

		const result = await executeAcpBuiltinSlashCommand("/thinking low", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.setThinkingLevel).toHaveBeenCalledWith("low", false);
		expect(h.output).toHaveBeenCalledWith("Thinking level set to low for this session.");
	});

	it("persists only when --default is explicit and in the expected order", async () => {
		const h = createEffortRuntime("low", ["low", "high"]);

		const result = await executeAcpBuiltinSlashCommand("/effort high --default", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.setThinkingLevel).toHaveBeenCalledWith("high", true);
		expect(h.output).toHaveBeenCalledWith("Thinking level set to high and saved as the default.");
	});

	it("rejects invalid, unsupported, extra, and non-persistable values", async () => {
		for (const invocation of ["/effort bogus", "/effort max", "/effort low extra", "/effort off --default"]) {
			const h = createEffortRuntime("low", ["low", "high"]);

			const result = await executeAcpBuiltinSlashCommand(invocation, h.runtime);

			expect(result).toEqual({ consumed: true });
			expect(h.setThinkingLevel).not.toHaveBeenCalled();
			expect(h.output).toHaveBeenCalledTimes(1);
		}
		const offDefault = createEffortRuntime("low", ["low", "high"]);
		await executeAcpBuiltinSlashCommand("/effort off --default", offDefault.runtime);
		expect(offDefault.output.mock.calls[0]?.[0]).toContain("settings do not support it");
	});
});

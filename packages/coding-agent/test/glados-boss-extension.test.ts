import { describe, expect, it } from "bun:test";
import { applyExtensionFlags, type ExtensionFlagSink } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	bossScratchHandoffFile,
	GLADOS_BOSS_FLAG,
	resolveBossScratchHandoffFile,
} from "@oh-my-pi/pi-coding-agent/glados/boss-extension";
import { loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("GLaDOS Boss extension", () => {
	it("registers --boss through the built-in extension path", async () => {
		const tempDir = await TempDir.create("@glados-boss-flags-");
		try {
			const loaded = await loadSessionExtensions(
				{},
				tempDir.path(),
				Settings.isolated({ extensions: [], disabledExtensions: [] }),
				new EventBus(),
			);
			const sink: ExtensionFlagSink = {
				getFlags: () => ExtensionRunner.aggregateFlags(loaded.extensions),
				setFlagValue: (name, value) => loaded.runtime.flagValues.set(name, value),
			};
			const parsed = applyExtensionFlags(sink, ["--boss", "start boss"]);

			expect(parsed?.unknownFlags.get(GLADOS_BOSS_FLAG)).toBe(true);
			expect(parsed?.messages).toEqual(["start boss"]);
			expect(loaded.runtime.flagValues.get(GLADOS_BOSS_FLAG)).toBe(true);
		} finally {
			await tempDir.remove();
		}
	});

	it("selects the stable same-day Boss scratch sidecar unless explicitly overridden", () => {
		const day = new Date(2026, 6, 15);
		const expected = "notes/2026/20260715.d/20260715-quorra-scratch-boss.org";

		expect(bossScratchHandoffFile(day)).toBe(expected);
		expect(resolveBossScratchHandoffFile({ bossEnabled: true, date: day })).toBe(expected);
		expect(
			resolveBossScratchHandoffFile({ bossEnabled: true, explicitScratchFile: "notes/custom.org", date: day }),
		).toBe("notes/custom.org");
		expect(resolveBossScratchHandoffFile({ bossEnabled: false, date: day })).toBeUndefined();
	});
});

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import LaunchCommand from "@oh-my-pi/pi-coding-agent/commands/launch";
import { SCRATCH_COMPACTION_METHOD_VALUES } from "@oh-my-pi/pi-coding-agent/config/scratch-compaction-method";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

interface CompactionSettings {
	remoteEnabled: boolean;
	standardEnabled: boolean;
}

async function observeCompactionSettings(
	rawArgs: string[],
	configured: CompactionSettings,
): Promise<CompactionSettings> {
	using tempDir = TempDir.createSync("@omp-compaction-method-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const settings = Settings.isolated({
		"marketplace.autoUpdate": "off",
		"compaction.remoteEnabled": configured.remoteEnabled,
		"scratchHandoff.standardCompactionEnabled": configured.standardEnabled,
	});
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noLsp = true;
	parsed.sessionDir = tempDir.path();

	try {
		await runRootCommand(parsed, rawArgs, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async () => {
				throw new Error("stop after observing settings");
			},
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== "stop after observing settings") throw error;
	} finally {
		authStorage.close();
	}

	return {
		remoteEnabled: settings.get("compaction.remoteEnabled"),
		standardEnabled: settings.get("scratchHandoff.standardCompactionEnabled"),
	};
}

describe("--compaction-method launch flag", () => {
	it("parses the method without leaking it into the prompt", () => {
		const result = parseArgs(["--compaction-method", "both", "--print", "hello"]);

		expect(result.compactionMethod).toBe("both");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("rejects an unknown method", () => {
		expect(() => parseArgs(["--compaction-method", "remote"])).toThrow(
			`Invalid --compaction-method value: "remote". Expected one of: ${SCRATCH_COMPACTION_METHOD_VALUES.join(", ")}.`,
		);
	});

	it("publishes the choices and default behavior in help metadata", () => {
		const flag = LaunchCommand.flags["compaction-method"];

		expect(flag.options).toEqual([...SCRATCH_COMPACTION_METHOD_VALUES]);
		expect(flag.description).toContain("configured keeps current settings (default)");
		expect(flag.description).toContain("scratch-only");
	});

	for (const [method, expected] of [
		["native", { remoteEnabled: true, standardEnabled: false }],
		["standard", { remoteEnabled: false, standardEnabled: true }],
		["both", { remoteEnabled: true, standardEnabled: true }],
		["scratch-only", { remoteEnabled: false, standardEnabled: false }],
	] as const) {
		it(`applies ${method} as runtime-only settings overrides`, async () => {
			await expect(
				observeCompactionSettings(["--compaction-method", method, "--print", "hello"], {
					remoteEnabled: !expected.remoteEnabled,
					standardEnabled: !expected.standardEnabled,
				}),
			).resolves.toEqual(expected);
		});
	}

	it("preserves configured settings for the configured method", async () => {
		await expect(
			observeCompactionSettings(["--compaction-method", "configured", "--print", "hello"], {
				remoteEnabled: false,
				standardEnabled: true,
			}),
		).resolves.toEqual({ remoteEnabled: false, standardEnabled: true });
	});

	it("preserves configured settings when omitted", async () => {
		await expect(
			observeCompactionSettings(["--print", "hello"], {
				remoteEnabled: true,
				standardEnabled: false,
			}),
		).resolves.toEqual({ remoteEnabled: true, standardEnabled: false });
	});
});

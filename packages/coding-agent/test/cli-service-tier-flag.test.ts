import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

async function observeOpenAIServiceTier(rawArgs: string[], configuredTier: string): Promise<string> {
	using tempDir = TempDir.createSync("@omp-service-tier-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const settings = Settings.isolated({
		"marketplace.autoUpdate": "off",
		"tier.openai": configuredTier,
	});
	const parsed = parseArgs(rawArgs);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
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

	return settings.get("tier.openai");
}

describe("--service-tier launch flag", () => {
	it("parses the OpenAI service tier without leaking it into the prompt", () => {
		const result = parseArgs(["--service-tier", "priority", "--print", "hello"]);

		expect(result.serviceTier).toBe("priority");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("temporarily overrides configured tier.openai", async () => {
		await expect(observeOpenAIServiceTier(["--service-tier", "priority", "--print", "hello"], "scale")).resolves.toBe(
			"priority",
		);
	});

	it("uses configured tier.openai when the flag is omitted", async () => {
		await expect(observeOpenAIServiceTier(["--print", "hello"], "scale")).resolves.toBe("scale");
	});
});

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import {
	applyCodexHomeAuth,
	applyCodexHomeAuthChain,
	CODEX_HOME_ENV,
	OPENAI_CODEX_OAUTH_TOKEN_ENV,
} from "@oh-my-pi/pi-coding-agent/cli/codex-home";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

let tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	tempDirs = [];
});

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-codex-home-"));
	tempDirs.push(dir);
	return dir;
}

function createCodexHome(accessToken: string, accountId = "account-id"): string {
	const codexHome = createTempDir();
	fs.writeFileSync(
		path.join(codexHome, "auth.json"),
		JSON.stringify({
			tokens: {
				access_token: accessToken,
				refresh_token: "codex-refresh-token",
				account_id: accountId,
			},
		}),
	);
	return codexHome;
}

describe("parseArgs — --codex-home flag", () => {
	it("parses --codex-home without leaking the value into messages", () => {
		const result = parseArgs(["--codex-home", "/tmp/codex-home", "--print", "hello"]);

		expect(result.codexHome).toBe("/tmp/codex-home");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --codex-home-chain without leaking the value into messages", () => {
		const result = parseArgs(["--codex-home-chain", "primary=/tmp/one,secondary=/tmp/two", "--print", "hello"]);

		expect(result.codexHomeChain).toBe("primary=/tmp/one,secondary=/tmp/two");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["hello"]);
	});

	it("sets OPENAI_CODEX_OAUTH_TOKEN from the selected Codex auth.json without exporting CODEX_HOME", () => {
		const codexHome = createCodexHome("codex-access-token");
		const env: NodeJS.ProcessEnv = {};

		const result = applyCodexHomeAuth(codexHome, env);

		expect(result.applied).toBe(true);
		expect(result.accessToken).toBe("codex-access-token");
		expect(result.codexHome).toBe(codexHome);
		expect(env[CODEX_HOME_ENV]).toBeUndefined();
		expect(env[OPENAI_CODEX_OAUTH_TOKEN_ENV]).toBe("codex-access-token");
	});

	it("builds an ordered Codex-home credential chain from named homes", () => {
		const first = createCodexHome("first-token", "acct-first");
		const second = createCodexHome("second-token", "acct-second");
		const env: NodeJS.ProcessEnv = {};

		const result = applyCodexHomeAuthChain({ codexHomeChainFlag: `primary=${first},secondary=${second}` }, env);

		expect(result.applied).toBe(true);
		expect(result.credentials.map(credential => credential.name)).toEqual(["primary", "secondary"]);
		expect(result.credentials.map(credential => credential.accessToken)).toEqual(["first-token", "second-token"]);
		expect(result.credentials.map(credential => credential.accountId)).toEqual(["acct-first", "acct-second"]);
		expect(env[OPENAI_CODEX_OAUTH_TOKEN_ENV]).toBe("first-token");
	});

	it("installs --codex-home auth as the openai-codex runtime credential", async () => {
		const codexHome = createCodexHome("codex-runtime-token");
		const authStorage = await AuthStorage.create(path.join(createTempDir(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const parsed = parseArgs(["--codex-home", codexHome, "--model", "openai-codex/gpt-5.5", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = createTempDir();

		try {
			await runRootCommand(
				parsed,
				["--codex-home", codexHome, "--model", "openai-codex/gpt-5.5", "--print", "hello"],
				{
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async () => {
						expect(await authStorage.getApiKey("openai-codex")).toBe("codex-runtime-token");
						throw new Error("stop after runtime credential");
					},
				},
			);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after runtime credential") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
	});

	it("installs configured Codex homes as the openai-codex runtime credential chain", async () => {
		const first = createCodexHome("configured-first-token", "acct-first");
		const second = createCodexHome("configured-second-token", "acct-second");
		const authStorage = await AuthStorage.create(path.join(createTempDir(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"providers.codexHomes": [
				{ name: "primary", path: first },
				{ name: "secondary", path: second },
			],
		});
		const parsed = parseArgs(["--model", "openai-codex/gpt-5.5", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = createTempDir();

		try {
			await runRootCommand(parsed, ["--model", "openai-codex/gpt-5.5", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async () => {
					const sessionId = "configured-codex-homes";
					expect(await authStorage.getApiKey("openai-codex", sessionId)).toBe("configured-first-token");
					expect(authStorage.getOAuthAccountIdentity("openai-codex", sessionId)?.accountId).toBe("acct-first");
					throw new Error("stop after configured runtime credential chain");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after configured runtime credential chain") {
				throw error;
			}
		} finally {
			authStorage.close();
		}
	});

	it("clears Codex-home auth when the flag is passed empty", () => {
		const env: NodeJS.ProcessEnv = {
			[CODEX_HOME_ENV]: "/old/codex-home",
			[OPENAI_CODEX_OAUTH_TOKEN_ENV]: "old-token",
		};

		const result = applyCodexHomeAuth("", env);

		expect(result.applied).toBe(false);
		expect(env[CODEX_HOME_ENV]).toBeUndefined();
		expect(env[OPENAI_CODEX_OAUTH_TOKEN_ENV]).toBeUndefined();
	});
});

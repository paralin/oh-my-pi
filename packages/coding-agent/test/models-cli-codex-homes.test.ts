import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CODEX_HOME_ENV, OPENAI_CODEX_OAUTH_TOKEN_ENV } from "@oh-my-pi/pi-coding-agent/cli/codex-home";
import { runModelsCommand } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getConfigRootDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalCodexHome = process.env[CODEX_HOME_ENV];
const originalCodexOAuthToken = process.env[OPENAI_CODEX_OAUTH_TOKEN_ENV];
const originalProjectDir = process.cwd();
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let workspace: TempDir | undefined;

interface ModelsJsonModel {
	provider: string;
	id: string;
}

beforeEach(async () => {
	delete process.env[CODEX_HOME_ENV];
	delete process.env[OPENAI_CODEX_OAUTH_TOKEN_ENV];
	workspace = await TempDir.create("omp-codex-homes-");
	setAgentDir(path.join(workspace.path(), "agent"));
	fs.mkdirSync(path.join(workspace.path(), "project"), { recursive: true });
	setProjectDir(path.join(workspace.path(), "project"));
	resetSettingsForTest();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (originalCodexHome === undefined) delete process.env[CODEX_HOME_ENV];
	else process.env[CODEX_HOME_ENV] = originalCodexHome;
	if (originalCodexOAuthToken === undefined) delete process.env[OPENAI_CODEX_OAUTH_TOKEN_ENV];
	else process.env[OPENAI_CODEX_OAUTH_TOKEN_ENV] = originalCodexOAuthToken;
	setProjectDir(originalProjectDir);
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (workspace) {
		try {
			await workspace.remove();
		} catch {}
		workspace = undefined;
	}
});

/** Write a Codex home holding an `auth.json` the way the `codex` CLI does. */
function writeCodexHome(root: string, accessToken: string): string {
	const home = path.join(root, "codex-home");
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(
		path.join(home, "auth.json"),
		JSON.stringify({
			tokens: {
				access_token: accessToken,
				refresh_token: "refresh-token",
				account_id: "acct-123",
				email: "codex@example.com",
			},
		}),
	);
	return home;
}

function writeConfig(root: string, codexHome: string): string {
	const configPath = path.join(root, "config.yml");
	fs.writeFileSync(configPath, `providers:\n  codexHomes:\n    - ${JSON.stringify(codexHome)}\n`);
	return configPath;
}

async function listModelsJson(configPath: string): Promise<ModelsJsonModel[]> {
	const chunks: string[] = [];
	spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
		chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
		return true;
	});
	await runModelsCommand({
		action: "ls",
		pattern: "openai-codex",
		flags: { json: true, noExtensions: true, config: [configPath] },
	});
	const parsed = JSON.parse(chunks.join("")) as { models: ModelsJsonModel[] };
	return parsed.models;
}

describe("omp models with configured Codex homes", () => {
	it("lists openai-codex models available through a Codex home credential", async () => {
		if (!workspace) throw new Error("workspace not initialized");
		const codexHome = writeCodexHome(workspace.path(), "codex-access-token");
		const configPath = writeConfig(workspace.path(), codexHome);

		const models = await listModelsJson(configPath);

		expect(models.some(model => model.provider === "openai-codex")).toBe(true);
	});

	it("omits openai-codex models when no Codex home holds a credential", async () => {
		if (!workspace) throw new Error("workspace not initialized");
		const emptyHome = path.join(workspace.path(), "empty-home");
		fs.mkdirSync(emptyHome, { recursive: true });
		const configPath = writeConfig(workspace.path(), emptyHome);

		const models = await listModelsJson(configPath);

		expect(models.some(model => model.provider === "openai-codex")).toBe(false);
	});
});

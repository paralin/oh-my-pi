import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { SecurityStore } from "../../src/security";
import { handleSecurityCommand } from "../../src/slash-commands/helpers/security";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";

const SARIF_FIXTURE = path.join(import.meta.dir, "..", "fixtures", "security", "generic-results.sarif");
let temporaryRoot = "";
let repositoryRoot = "";
let previousStateHome: string | undefined;
let settings: Settings;
let output: string[] = [];

beforeEach(async () => {
	temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-security-slash-"));
	repositoryRoot = path.join(temporaryRoot, "repo");
	await fs.mkdir(repositoryRoot);
	previousStateHome = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = path.join(temporaryRoot, "xdg-state");
	refreshDirsFromEnv();
	settings = Settings.isolated({ "security.enabled": true });
	output = [];
});

afterEach(async () => {
	settings.cancelPendingSaves();
	if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
	else process.env.XDG_STATE_HOME = previousStateHome;
	refreshDirsFromEnv();
	await fs.rm(temporaryRoot, { recursive: true, force: true });
});

function runtime(): SlashCommandRuntime {
	return {
		session: {} as SlashCommandRuntime["session"],
		sessionManager: {} as SlashCommandRuntime["sessionManager"],
		settings,
		cwd: repositoryRoot,
		output: text => {
			output.push(text);
		},
		refreshCommands: () => undefined,
		reloadPlugins: async () => undefined,
	};
}

async function command(args: string) {
	return handleSecurityCommand({ name: "security", args, text: `/security ${args}` }, runtime());
}

describe("/security", () => {
	test("imports SARIF, lists it, renders it, and records dispositions explicitly", async () => {
		await command(`import ${JSON.stringify(SARIF_FIXTURE)}`);
		const store = await SecurityStore.open(repositoryRoot);
		const scans = await store.listScans();
		expect(scans).toHaveLength(1);
		const scanId = scans[0]!.id;
		const bundle = await store.getBundle(scanId);
		expect(bundle?.findings).toHaveLength(2);
		const finding = bundle?.findings[0];
		if (!finding) throw new Error("expected imported finding");

		await command("scans");
		expect(output.at(-1)).toContain(scanId);
		await command(`show ${scanId}`);
		expect(output.at(-1)).toContain(`Security scan ${scanId}`);
		await command(`disposition ${scanId} ${finding.id} false_positive "fixture rationale"`);
		expect((await store.getFinding(scanId, finding.id))?.disposition).toMatchObject({
			status: "false_positive",
			rationale: "fixture rationale",
		});

		await command(`disposition ${scanId} ${finding.id} open`);
		expect((await store.getFinding(scanId, finding.id))?.disposition).toMatchObject({
			status: "open",
			actor: "operator",
		});
		expect((await store.getFinding(scanId, finding.id))?.disposition.rationale).toBeUndefined();
	});

	test("export preserves permissions on an existing destination directory", async () => {
		if (process.platform === "win32") return;
		await fs.chmod(repositoryRoot, 0o755);
		await command(`import ${JSON.stringify(SARIF_FIXTURE)}`);
		const [scan] = await (await SecurityStore.open(repositoryRoot)).listScans();
		if (!scan) throw new Error("expected imported scan");
		await command(`export ${scan.id} --output exported.sarif --format sarif`);
		expect((await fs.stat(repositoryRoot)).mode & 0o777).toBe(0o755);
		expect(JSON.parse(await Bun.file(path.join(repositoryRoot, "exported.sarif")).text())).toHaveProperty("version");
	});

	test("validate returns an IPython-native validation prompt", async () => {
		const result = await command("validate secscan_fixture secf_fixture");
		expect(result).toEqual({
			prompt: expect.stringContaining("security://scans/secscan_fixture/findings/secf_fixture"),
		});
		if (!result || !("prompt" in result)) throw new Error("expected validation prompt");
		expect(result.prompt).toContain("omp.security.validate");
		expect(result.prompt).not.toContain("security_scan");
	});

	test("disabled command is consumed without touching session state", async () => {
		settings.override("security.enabled", false);
		const result = await command("scans");
		expect(result).toEqual({ consumed: true });
		expect(output.at(-1)).toContain("disabled");
	});
});

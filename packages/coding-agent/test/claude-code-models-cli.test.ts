import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runModelsCommand } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getConfigRootDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProjectDir = process.cwd();
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

let workspace: TempDir | undefined;
let workspaceRoot: string | undefined;

beforeEach(async () => {
	workspace = await TempDir.create("omp-claude-code-models-");
	workspaceRoot = path.resolve(workspace.path());
	setAgentDir(path.join(workspaceRoot, "agent"));
	const project = path.join(workspaceRoot, "project");
	fs.mkdirSync(project, { recursive: true });
	setProjectDir(project);
	resetSettingsForTest();
});

afterEach(async () => {
	vi.restoreAllMocks();
	resetSettingsForTest();
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
	workspaceRoot = undefined;
});

describe("omp models with configured Claude Code task runtimes", () => {
	it("lists model-role selectors with their exact SDK efforts", async () => {
		if (!workspaceRoot) throw new Error("workspace not initialized");
		const configPath = path.join(workspaceRoot, "config.yml");
		fs.writeFileSync(
			configPath,
			"modelRoles:\n  opus: claude-code/claude-opus-5:xhigh\n  fable: claude-code/claude-fable-5:high\n",
		);
		const chunks: string[] = [];
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		await runModelsCommand({
			action: "find",
			pattern: "claude-code",
			flags: { json: true, noExtensions: true, config: [configPath] },
		});

		const output = JSON.parse(chunks.join("")) as {
			models: {
				provider: string;
				id: string;
				selector: string;
				name: string;
				contextWindow: number | null;
				maxTokens: number | null;
				reasoning: boolean;
				thinking: string[] | null;
				input: string[];
				cost: unknown;
			}[];
		};
		expect(output.models).toEqual([
			{
				provider: "claude-code",
				id: "claude-fable-5:high",
				selector: "claude-code/claude-fable-5:high",
				name: "claude-fable-5 through Claude Code",
				contextWindow: null,
				maxTokens: null,
				reasoning: true,
				thinking: ["high"],
				input: ["text"],
				cost: null,
			},
			{
				provider: "claude-code",
				id: "claude-opus-5:xhigh",
				selector: "claude-code/claude-opus-5:xhigh",
				name: "claude-opus-5 through Claude Code",
				contextWindow: null,
				maxTokens: null,
				reasoning: true,
				thinking: ["xhigh"],
				input: ["text"],
				cost: null,
			},
		]);
	});
});

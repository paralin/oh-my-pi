import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/sdk";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function createIsolatedSkillsSettings(): Settings {
	return Settings.isolated({
		"skills.enabled": true,
		"skills.enableCodexUser": false,
		"skills.enableClaudeUser": false,
		"skills.enableClaudeProject": false,
		"skills.enablePiUser": false,
		"skills.enablePiProject": true,
	});
}

function createExtensionSkill(packageDir: string, skillName: string): void {
	fs.mkdirSync(path.join(packageDir, "skills", skillName), { recursive: true });
	fs.writeFileSync(
		path.join(packageDir, "package.json"),
		JSON.stringify({ name: path.basename(packageDir), omp: { extensions: ["./extension.ts"] } }),
	);
	fs.writeFileSync(path.join(packageDir, "extension.ts"), "export default function extension() {}\n");
	fs.writeFileSync(
		path.join(packageDir, "skills", skillName, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: SDK extension package skill\n---\nbody\n`,
	);
}

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	let tempHomeDir = "";
	let originalHome: string | undefined;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests: skill
	// discovery never touches models, and building them per test would make createAgentSession call
	// modelRegistry.refreshInBackground(), whose online model discovery saturates the event loop and
	// serializes the otherwise-parallel capability scans (~340ms/call). Supplying a prebuilt registry
	// skips that refresh entirely (~24ms/call).
	let sharedDir: string;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-skills-shared-"));
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir, "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		removeSyncWithRetries(sharedDir);
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// Create skill in .omp/skills/ for native project-level discovery
		skillsDir = path.join(tempDir, ".omp", "skills", "test-skill");
		fs.mkdirSync(skillsDir, { recursive: true });
		originalHome = process.env.HOME;
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-home-"));
		process.env.HOME = tempHomeDir;
		const nativeUserSkillsDir = path.join(tempHomeDir, ".omp", "agent", "skills");
		fs.mkdirSync(nativeUserSkillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		fs.writeFileSync(
			path.join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);

		const externalSkillDir = path.join(tempDir, "external-symlinked-skill");
		fs.mkdirSync(externalSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(externalSkillDir, "SKILL.md"),
			`---
name: symlinked-skill
description: Skill loaded through a symlink.
---

# Symlinked Skill

Loaded via symbolic link.
`,
		);
		fs.symlinkSync(externalSkillDir, path.join(path.dirname(skillsDir), "symlinked-skill-link"), "dir");
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("reloads extension declarations without publishing provider registrations", async () => {
		const extensionPath = path.join(tempDir, "reload-extension.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function extension(pi) {
	pi.registerFlag("reload-mode", { type: "string", default: "admitted" });
	pi.registerIpythonMimeRenderer("application/x-before", () => pi.getFlag("reload-mode"));
}
`,
		);
		const authStorage = await AuthStorage.create(path.join(tempDir, "reload-auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "reload-models.yml"));
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
				modelRegistry,
				settings: createIsolatedSkillsSettings(),
				additionalExtensionPaths: [extensionPath],
				enableMCP: false,
				enableLsp: false,
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
			}));
			expect(session.getIpythonMimeRenderer("application/x-before")).toBeDefined();
			fs.writeFileSync(
				extensionPath,
				`export default function extension(pi) {
	pi.registerFlag("reload-mode", { type: "string", default: "candidate" });
	pi.registerIpythonMimeRenderer("application/x-after", () => pi.getFlag("reload-mode"));
	pi.registerProvider("reload-provider", {
		baseUrl: "https://reload.invalid/v1",
		apiKey: "RELOAD_PROVIDER_KEY",
		api: "openai-completions",
		models: [{
			id: "reload-model",
			name: "Reload Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		}],
	});
}
`,
			);
			await session.refreshSkills();
			expect(session.getIpythonMimeRenderer("application/x-before")).toBeUndefined();
			const reloadedRenderer = session.getIpythonMimeRenderer("application/x-after");
			expect(reloadedRenderer).toBeDefined();
			expect((reloadedRenderer as unknown as () => unknown)()).toBe("admitted");
			expect(modelRegistry.getAll().some(model => model.provider === "reload-provider")).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
		}
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		// Skills should be discovered and exposed on the session
		expect(session.skills.length).toBeGreaterThan(0);
		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("SDK invocation root scope isolates disabled discovery and merges normal discovery", async () => {
		const explicitPackage = path.join(tempDir, "sdk-explicit-extension");
		const settingsPackage = path.join(tempDir, "sdk-settings-extension");
		const installedPackage = path.join(tempHomeDir, ".omp", "plugins", "node_modules", "sdk-installed-extension");
		createExtensionSkill(explicitPackage, "sdk-explicit-skill");
		createExtensionSkill(settingsPackage, "sdk-settings-skill");
		createExtensionSkill(installedPackage, "sdk-installed-skill");
		fs.writeFileSync(path.join(tempDir, ".omp", "settings.json"), JSON.stringify({ extensions: [settingsPackage] }));
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "plugins"), { recursive: true });
		fs.writeFileSync(
			path.join(tempHomeDir, ".omp", "plugins", "package.json"),
			JSON.stringify({ name: "omp-plugins", dependencies: { "sdk-installed-extension": "1.0.0" } }),
		);

		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(tempHomeDir, ".omp", "agent"));
		const baseSessionOptions = {
			cwd: tempDir,
			agentDir: path.join(tempHomeDir, ".omp", "agent"),
			modelRegistry: sharedModelRegistry,
			additionalExtensionPaths: [explicitPackage],
			enableMCP: false,
			enableLsp: false,
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
		};
		let session: AgentSession | undefined;
		try {
			({ session } = await createAgentSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings(),
				disableExtensionDiscovery: true,
			}));

			const isolatedSkillNames = session.skills.map(skill => skill.name);
			expect(isolatedSkillNames).toContain("sdk-explicit-skill");
			expect(isolatedSkillNames).not.toEqual(expect.arrayContaining(["sdk-settings-skill", "sdk-installed-skill"]));

			await session.dispose();
			session = undefined;
			({ session } = await createAgentSession({
				...baseSessionOptions,
				sessionManager: SessionManager.inMemory(),
				settings: createIsolatedSkillsSettings(),
			}));

			const mergedSkillNames = session.skills.map(skill => skill.name);
			expect(mergedSkillNames).toEqual(expect.arrayContaining(["sdk-explicit-skill", "sdk-settings-skill"]));
		} finally {
			await session?.dispose();
			setAgentDir(previousAgentDir);
		}
	});

	it("should discover skills when skill directory is a symlink", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "symlinked-skill")).toBe(true);
	});

	it("should still discover project skills when user skills directory is missing", async () => {
		const userAgentDir = path.join(tempHomeDir, ".omp", "agent");
		removeSyncWithRetries(path.join(userAgentDir, "skills"));
		fs.writeFileSync(path.join(userAgentDir, "placeholder.txt"), "placeholder");

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "test-skill")).toBe(true);
	});

	it("refreshSkills reloads project skills on an existing session", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
			modelRegistry: sharedModelRegistry,
			settings: createIsolatedSkillsSettings(),
		});

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);

		const runtimeSkillDir = path.join(tempDir, ".omp", "skills", "runtime-added-skill");
		fs.mkdirSync(runtimeSkillDir, { recursive: true });
		fs.writeFileSync(
			path.join(runtimeSkillDir, "SKILL.md"),
			`---
name: runtime-added-skill
description: Added after the session is created.
---

# Runtime Added Skill

This skill is added after session creation.
`,
		);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(true);

		removeSyncWithRetries(runtimeSkillDir);

		await session.refreshSkills();

		expect(session.skills.some((s: Skill) => s.name === "runtime-added-skill")).toBe(false);
	});

	it("should have empty skills when options.skills is empty array (--no-skills)", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [], // Explicitly empty - like --no-skills
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should be empty
		expect(session.skills).toEqual([]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});

	it("should use provided skills when options.skills is explicitly set", async () => {
		const customSkill: Skill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			source: "custom" as const,
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			modelRegistry: sharedModelRegistry,
			skills: [customSkill],
			settings: createIsolatedSkillsSettings(),
		});

		// session.skills should contain only the provided skill
		expect(session.skills).toEqual([customSkill]);
		// No warnings since we didn't discover
		expect(session.skillWarnings).toEqual([]);
	});
});

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	buildSystemPrompt,
	loadProjectContextFiles,
	loadSystemPromptFiles,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { cleanupTempHome } from "./helpers/temp-home-cleanup";

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("SYSTEM.md prompt assembly", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-prompt-"));
		tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-system-home-"));
		originalHome = process.env.HOME;
		process.env.HOME = tempHomeDir;
	});

	afterEach(cleanupTempHome(() => ({ tempDir, tempHomeDir, originalHome })));

	it("keeps fixed ABI, stable project context, and volatile notices in order", async () => {
		const projectDir = path.join(tempDir, "project");
		const outerPath = path.join(projectDir, "AGENTS.md");
		const innerPath = path.join(projectDir, "nested", "AGENTS.md");
		const { systemPrompt } = await buildSystemPrompt({
			calendarDate: "2026-08-06",
			contextFiles: [
				{ path: innerPath, content: "Nested instruction", depth: 0 },
				{ path: outerPath, content: "Outer instruction", depth: 1 },
			],
			cwd: projectDir,
			recursiveDepth: 1,
			resolvedSystemPromptCustomization: null,
			sessionLogLocation: "/sessions/root.jsonl",
			sessionNotice: "root",
		});

		expect(systemPrompt).toHaveLength(3);
		expect(systemPrompt[0]).toContain("capable general-purpose agent");
		expect(systemPrompt[0]).toContain("exclusive `ipython`");
		expect(systemPrompt[0]).toContain("fresh subshell");
		expect(systemPrompt[0]).toContain("native environment");
		expect(systemPrompt[0]).toContain("`rlm`, `omp`, and installed Python skills are preloaded");
		expect(systemPrompt[0]).toContain("`SKILL.md`");
		expect(systemPrompt[0]).toContain("appended operator and project instructions");
		expect(systemPrompt[1].indexOf("Outer instruction")).toBeLessThan(systemPrompt[1].indexOf("Nested instruction"));
		expect(systemPrompt[2]).toContain("Today is 2026-08-06.");
		expect(systemPrompt[2]).toContain("Session log: /sessions/root.jsonl.");
		expect(systemPrompt[2]).toContain("Session: root.");
		expect(systemPrompt[2]).toContain("Recursive depth: 1.");
	});

	it("does not resolve already-loaded prompt text as a path", async () => {
		const projectDir = path.join(tempDir, "project");
		const readablePromptText = path.join(projectDir, "README.md");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(readablePromptText, "File content that must not replace the prompt.");

		const { systemPrompt } = await buildSystemPrompt({
			contextFiles: [],
			cwd: projectDir,
			resolvedAppendSystemPrompt: readablePromptText,
			resolvedCustomPrompt: readablePromptText,
			resolvedSystemPromptCustomization: null,
		});
		const promptText = systemPrompt.join("\n\n");

		expect(promptText).toContain(readablePromptText);
		expect(promptText).not.toContain("File content that must not replace the prompt.");
	});

	it("gives explicit custom and append text precedence over discovered SYSTEM.md", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.writeFileSync(path.join(projectDir, ".omp", "SYSTEM.md"), "Discovered project SYSTEM prompt");

		const { systemPrompt } = await buildSystemPrompt({
			contextFiles: [{ path: path.join(projectDir, "AGENTS.md"), content: "Project instruction", depth: 0 }],
			cwd: projectDir,
			resolvedAppendSystemPrompt: "Append instruction",
			resolvedCustomPrompt: "Custom instruction",
		});
		const promptText = systemPrompt.join("\n\n");

		expect(systemPrompt[0]).toContain("exclusive `ipython`");
		expect(promptText).toContain("Project instruction");
		expect(promptText).toContain("Custom instruction");
		expect(promptText).toContain("Append instruction");
		expect(promptText).not.toContain("Discovered project SYSTEM prompt");
		expect(promptText.indexOf("Custom instruction")).toBeLessThan(promptText.indexOf("Append instruction"));
	});

	it("prefers project SYSTEM.md over user SYSTEM.md", async () => {
		const projectDir = path.join(tempDir, "project");
		fs.mkdirSync(path.join(projectDir, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(tempHomeDir, ".omp", "agent"), { recursive: true });
		fs.writeFileSync(path.join(tempHomeDir, ".omp", "agent", "SYSTEM.md"), "User SYSTEM prompt");
		fs.writeFileSync(path.join(projectDir, ".omp", "SYSTEM.md"), "Project SYSTEM prompt");

		await expect(loadSystemPromptFiles({ cwd: projectDir })).resolves.toBe("Project SYSTEM prompt");
		const { systemPrompt } = await buildSystemPrompt({
			contextFiles: [],
			cwd: projectDir,
		});
		expect(systemPrompt.join("\n\n")).toContain("Project SYSTEM prompt");
	});

	it("deduplicates identical context and rule content while keeping the closer context", async () => {
		const farPath = path.join(tempDir, "far", "AGENTS.md");
		const nearPath = path.join(tempDir, "near", "AGENTS.md");
		const sharedContent = "Shared context instructions";
		const { systemPrompt } = await buildSystemPrompt({
			alwaysApplyRules: [{ name: "shared", path: path.join(tempDir, "rule.md"), content: sharedContent }],
			contextFiles: [
				{ path: nearPath, content: sharedContent, depth: 0 },
				{ path: farPath, content: sharedContent, depth: 2 },
			],
			cwd: tempDir,
			resolvedSystemPromptCustomization: null,
		});
		const promptText = systemPrompt.join("\n\n");
		const matches = promptText.match(new RegExp(escapeRegExp(sharedContent), "g")) ?? [];

		expect(matches).toHaveLength(1);
		expect(promptText).not.toContain(`<file path="${farPath}">`);
		expect(promptText).toContain(`<file path="${nearPath}">`);
	});

	it("deduplicates identical discovered context and keeps the closest file", async () => {
		const projectDir = path.join(tempDir, "project");
		const appDir = path.join(projectDir, "packages", "app");
		const sharedContent = "Shared context instructions";
		fs.mkdirSync(appDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), sharedContent);
		fs.writeFileSync(path.join(appDir, "AGENTS.md"), sharedContent);

		const contextFiles = await loadProjectContextFiles({ cwd: appDir });
		const discoveredFiles = contextFiles.filter(file => file.path.startsWith(projectDir));

		expect(discoveredFiles).toHaveLength(1);
		expect(discoveredFiles[0]?.path).toBe(path.join(appDir, "AGENTS.md"));
	});
});

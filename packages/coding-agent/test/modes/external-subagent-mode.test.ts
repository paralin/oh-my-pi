import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { CODEX_HOME_ENV, OPENAI_CODEX_OAUTH_TOKEN_ENV } from "@oh-my-pi/pi-coding-agent/cli/codex-home";
import {
	type ExternalSubagentProfileV1,
	encodeExternalSubagentProfile,
} from "@oh-my-pi/pi-coding-agent/coordination/external-subagent-profile";
import {
	externalTaskProgressRecord,
	externalTaskResultRecord,
	isExternalSubagentConfigured,
	loadExternalSubagentProfile,
	PARENT_TASK_PROFILE_DIGEST_ENV,
	PARENT_TASK_PROFILE_ENV,
	runExternalSubagentMode,
} from "@oh-my-pi/pi-coding-agent/modes/external-subagent-mode";
import { PARENT_SESSION_ENV, PARENT_SOCKET_ENV } from "@oh-my-pi/pi-coding-agent/parent/config";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

const roots: string[] = [];

async function fixture(): Promise<{
	profile: ExternalSubagentProfileV1;
	env: Record<string, string | undefined>;
	path: string;
}> {
	const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "omp-external-mode-"));
	roots.push(root);
	const profile: ExternalSubagentProfileV1 = {
		schemaVersion: 1,
		runtime: "native",
		isolated: false,
		peerId: "reviewer-2",
		label: "Reviewer 2",
		assignment: "Review the mailbox.",
		batchContext: null,
		parentToolCallId: "call-1",
		taskDepth: 0,
		agent: {
			name: "reviewer",
			source: "bundled",
			systemPrompt: "Review carefully.",
			tools: ["read"],
			spawns: [],
			skills: [],
			readMode: "summary",
		},
		effort: "hi",
		enableIrc: true,
		modelSelector: ["openai-codex/gpt-5.6-sol:high"],
		thinkingLevel: parseConfiguredThinkingLevel("high")!,
		maxRuntimeMs: 60_000,
		outputSchema: null,
		planReference: null,
		workspaceRoots: [root],
	};
	const encoded = encodeExternalSubagentProfile(profile);
	const profilePath = path.join(root, "adapter-config.json");
	await fs.writeFile(profilePath, encoded.bytes, { mode: 0o600 });
	return {
		profile,
		path: profilePath,
		env: {
			[PARENT_TASK_PROFILE_ENV]: profilePath,
			[PARENT_TASK_PROFILE_DIGEST_ENV]: encoded.digest,
		},
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("external subagent mode", () => {
	test("selects external mode from the parent task profile", () => {
		expect(isExternalSubagentConfigured({ [PARENT_TASK_PROFILE_ENV]: "/tmp/profile.json" })).toBe(true);
		expect(isExternalSubagentConfigured({ GLADOS_ADAPTER_CONFIG: "/tmp/profile.json" })).toBe(false);
		expect(isExternalSubagentConfigured({ [PARENT_TASK_PROFILE_ENV]: "   " })).toBe(false);
	});

	test("loads only an absolute mode-0600 canonical profile with its digest", async () => {
		const value = await fixture();
		expect(await loadExternalSubagentProfile(value.env)).toEqual(value.profile);

		await fs.chmod(value.path, 0o644);
		await expect(loadExternalSubagentProfile(value.env)).rejects.toThrow("mode-0600");
		await fs.chmod(value.path, 0o600);
		await expect(
			loadExternalSubagentProfile({
				...value.env,
				[PARENT_TASK_PROFILE_DIGEST_ENV]: "0".repeat(64),
			}),
		).rejects.toThrow("digest");
		await expect(
			loadExternalSubagentProfile({
				...value.env,
				[PARENT_TASK_PROFILE_ENV]: "relative.json",
			}),
		).rejects.toThrow("absolute");
	});

	test("rejects missing Parent identity before provider startup", async () => {
		const value = await fixture();
		await expect(runExternalSubagentMode(value.env)).rejects.toThrow("OMP_PARENT_SOCKET and OMP_PARENT_SESSION");
	});

	test("terminalizes setup failures before provider startup", async () => {
		const value = await fixture();
		value.profile.agent.skills = ["missing-frozen-skill"];
		const encoded = encodeExternalSubagentProfile(value.profile);
		await fs.writeFile(value.path, encoded.bytes, { mode: 0o600 });
		const codexHome = path.join(value.profile.workspaceRoots[0]!, "codex");
		await fs.mkdir(codexHome);
		await fs.writeFile(
			path.join(codexHome, "auth.json"),
			JSON.stringify({ tokens: { access_token: "external-mode-token" } }),
		);

		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		let result: SingleResult;
		const env: NodeJS.ProcessEnv = {
			...value.env,
			[PARENT_TASK_PROFILE_DIGEST_ENV]: encoded.digest,
			[PARENT_SOCKET_ENV]: path.join(value.profile.workspaceRoots[0]!, "parent.sock"),
			[PARENT_SESSION_ENV]: "glados/live/root/llm-session",
			[CODEX_HOME_ENV]: codexHome,
		};
		try {
			result = await runExternalSubagentMode(env);
		} finally {
			write.mockRestore();
		}

		expect(output.match(/"type":"omp_parent_task_result_v1"/g)).toHaveLength(1);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("missing-frozen-skill");
		expect(env[OPENAI_CODEX_OAUTH_TOKEN_ENV]).toBe("external-mode-token");
	});

	test("maps every bounded progress and terminal field", () => {
		const progress: AgentProgress = {
			index: 0,
			id: "reviewer-2",
			agent: "reviewer",
			agentSource: "bundled",
			status: "running",
			task: "Review the mailbox.",
			lastIntent: "inspect mailbox",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			tokens: 12,
			requests: 2,
			contextTokens: 7,
			contextWindow: 100,
			resolvedModel: "openai/model",
			durationMs: 55,
			currentTool: "read",
			cost: 0.25,
		};
		const progressRecord = externalTaskProgressRecord(progress, "provider-session-1");
		expect(progressRecord.providerSessionId).toBe("provider-session-1");
		expect(progressRecord.taskProgress).toMatchObject({
			lastIntent: "inspect mailbox",
			tokens: 12,
			requests: 2,
			contextTokens: 7,
			contextWindow: 100,
			resolvedModel: "openai/model",
			durationMs: 55,
			activeToolName: "read",
			cost: 0.25,
		});

		const result: SingleResult = {
			index: 0,
			id: "reviewer-2",
			agent: "reviewer",
			agentSource: "bundled",
			task: "Review the mailbox.",
			assignment: "Review the mailbox.",
			lastIntent: "return result",
			exitCode: 7,
			output: "done",
			stderr: "warning",
			truncated: true,
			structuredOutput: {
				source: "caller",
				mode: "strict",
				status: "valid",
				data: { ok: true },
			},
			durationMs: 89,
			tokens: 13,
			requests: 3,
			contextTokens: 8,
			contextWindow: 100,
			resolvedModel: "openai/model",
			resolvedModelIsFallback: true,
			error: "error",
			aborted: true,
			abortReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 10,
				reasoningTokens: 5,
				cost: {
					input: 0.1,
					output: 0.2,
					cacheRead: 0.3,
					cacheWrite: 0.4,
					total: 1,
				},
			},
			extractedToolData: { read: [{ path: "a" }] },
			retryFailure: { attempt: 2, errorMessage: "quota" },
		};
		const resultRecord = externalTaskResultRecord(result, "provider-session-1");
		expect(resultRecord.providerSessionId).toBe("provider-session-1");
		expect(resultRecord.taskResult).toMatchObject({
			lastIntent: "return result",
			exitCode: 7,
			output: "done",
			stderr: "warning",
			truncated: true,
			durationMs: 89,
			tokens: 13,
			requests: 3,
			contextTokens: 8,
			contextWindow: 100,
			resolvedModel: "openai/model",
			resolvedModelIsFallback: true,
			error: "error",
			aborted: true,
			abortReason: "stop",
			retryFailure: { attempt: 2, errorMessage: "quota" },
		});
	});
});

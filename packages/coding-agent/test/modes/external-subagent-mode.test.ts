import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
	type ExternalSubagentProfileV1,
	encodeExternalSubagentProfile,
} from "@oh-my-pi/pi-coding-agent/coordination/external-subagent-profile";
import {
	externalTaskProgressRecord,
	externalTaskResultRecord,
	GLADOS_ADAPTER_CONFIG_DIGEST_ENV,
	GLADOS_ADAPTER_CONFIG_ENV,
	loadExternalSubagentProfile,
	runExternalSubagentMode,
} from "@oh-my-pi/pi-coding-agent/modes/external-subagent-mode";
import type { AgentProgress, SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { WORLD_SESSION_ENV, WORLD_SOCKET_ENV } from "@oh-my-pi/pi-coding-agent/world/index";

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
			[GLADOS_ADAPTER_CONFIG_ENV]: profilePath,
			[GLADOS_ADAPTER_CONFIG_DIGEST_ENV]: encoded.digest,
		},
	};
}

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("external subagent mode", () => {
	test("loads only an absolute mode-0600 canonical profile with its digest", async () => {
		const value = await fixture();
		expect(await loadExternalSubagentProfile(value.env)).toEqual(value.profile);

		await fs.chmod(value.path, 0o644);
		await expect(loadExternalSubagentProfile(value.env)).rejects.toThrow("mode-0600");
		await fs.chmod(value.path, 0o600);
		await expect(
			loadExternalSubagentProfile({
				...value.env,
				[GLADOS_ADAPTER_CONFIG_DIGEST_ENV]: "0".repeat(64),
			}),
		).rejects.toThrow("digest");
		await expect(
			loadExternalSubagentProfile({
				...value.env,
				[GLADOS_ADAPTER_CONFIG_ENV]: "relative.json",
			}),
		).rejects.toThrow("absolute");
	});

	test("rejects missing World identity before provider startup", async () => {
		const value = await fixture();
		await expect(runExternalSubagentMode(value.env)).rejects.toThrow("OMP_WORLD_SOCKET and OMP_WORLD_SESSION");
	});

	test("terminalizes setup failures before provider startup", async () => {
		const value = await fixture();
		value.profile.agent.skills = ["missing-frozen-skill"];
		const encoded = encodeExternalSubagentProfile(value.profile);
		await fs.writeFile(value.path, encoded.bytes, { mode: 0o600 });

		let output = "";
		const write = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
			output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
			return true;
		});
		let result: SingleResult;
		try {
			result = await runExternalSubagentMode({
				...value.env,
				[GLADOS_ADAPTER_CONFIG_DIGEST_ENV]: encoded.digest,
				[WORLD_SOCKET_ENV]: path.join(value.profile.workspaceRoots[0]!, "world.sock"),
				[WORLD_SESSION_ENV]: "glados/live/root/llm-session",
			});
		} finally {
			write.mockRestore();
		}

		expect(output.match(/"type":"glados_task_result_v1"/g)).toHaveLength(1);
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("missing-frozen-skill");
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
		expect(externalTaskProgressRecord(progress).taskProgress).toMatchObject({
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
		expect(externalTaskResultRecord(result).taskResult).toMatchObject({
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

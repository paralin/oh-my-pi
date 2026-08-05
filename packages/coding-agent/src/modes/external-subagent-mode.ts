import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonStringify } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async/job-manager";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import {
	decodeExternalSubagentProfile,
	type ExternalSubagentProfileV1,
} from "../coordination/external-subagent-profile";
import { createWorldCoordinationBackend } from "../coordination/world";
import { loadSkills } from "../extensibility/skills";
import { discoverAuthStorage } from "../sdk";
import { runSubprocess } from "../task/executor";
import { renderStructuredSubagentPrompt } from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";
import { resolveWorldSessionKey, resolveWorldSocketPath } from "../world/config";

export const GLADOS_ADAPTER_CONFIG_ENV = "GLADOS_ADAPTER_CONFIG";
export const GLADOS_ADAPTER_CONFIG_DIGEST_ENV = "GLADOS_ADAPTER_CONFIG_DIGEST";

/** Versioned live progress record consumed by GLaDOS. */
export interface ExternalTaskProgressRecord {
	type: "glados_task_progress_v1";
	taskProgress: {
		lastIntent: string;
		tokens: number;
		requests: number;
		contextTokens: number;
		contextWindow: number;
		resolvedModel: string;
		durationMs: number;
		activeToolName: string;
		updatedAt: string;
		cost: number;
	};
}

/** Versioned terminal result record consumed by GLaDOS. */
export interface ExternalTaskResultRecord {
	type: "glados_task_result_v1";
	taskResult: Record<string, unknown>;
}

function requireExternalProfilePath(env: Record<string, string | undefined>): string {
	const value = env[GLADOS_ADAPTER_CONFIG_ENV]?.trim();
	if (!value || !path.isAbsolute(value)) {
		throw new Error(`${GLADOS_ADAPTER_CONFIG_ENV} must be an absolute file path`);
	}
	return value;
}

/** Reads and validates the lane-private worker profile before provider startup. */
export async function loadExternalSubagentProfile(
	env: Record<string, string | undefined> = process.env,
): Promise<ExternalSubagentProfileV1> {
	const profilePath = requireExternalProfilePath(env);
	const info = await fs.stat(profilePath);
	if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
		throw new Error(`${GLADOS_ADAPTER_CONFIG_ENV} must name a mode-0600 regular file`);
	}
	const digest = env[GLADOS_ADAPTER_CONFIG_DIGEST_ENV]?.trim() ?? "";
	const bytes = await fs.readFile(profilePath);
	return decodeExternalSubagentProfile(bytes, digest);
}

async function emitRecord(record: ExternalTaskProgressRecord | ExternalTaskResultRecord): Promise<void> {
	if (!process.stdout.write(`${JSON.stringify(record)}\n`)) await once(process.stdout, "drain");
}

/** Maps live Task state onto the versioned GLaDOS progress record. */
export function externalTaskProgressRecord(progress: AgentProgress): ExternalTaskProgressRecord {
	return {
		type: "glados_task_progress_v1",
		taskProgress: {
			lastIntent: progress.lastIntent ?? "",
			tokens: progress.tokens,
			requests: progress.requests,
			contextTokens: progress.contextTokens ?? 0,
			contextWindow: progress.contextWindow ?? 0,
			resolvedModel: progress.resolvedModel ?? "",
			durationMs: progress.durationMs,
			activeToolName: progress.currentTool ?? "",
			updatedAt: new Date().toISOString(),
			cost: progress.cost,
		},
	};
}

/** Maps the complete Task result onto the versioned GLaDOS terminal record. */
export function externalTaskResultRecord(result: SingleResult): ExternalTaskResultRecord {
	const usage = result.usage;
	const extractedToolData = Object.entries(result.extractedToolData ?? {}).map(([toolName, values]) => ({
		toolName,
		values: values.map(value => canonicalJsonStringify(value)),
	}));
	return {
		type: "glados_task_result_v1",
		taskResult: {
			lastIntent: result.lastIntent ?? "",
			exitCode: result.exitCode,
			output: result.output,
			stderr: result.stderr,
			truncated: result.truncated,
			structuredOutput: result.structuredOutput ? canonicalJsonStringify(result.structuredOutput) : "",
			durationMs: result.durationMs,
			tokens: result.tokens,
			requests: result.requests,
			contextTokens: result.contextTokens ?? 0,
			contextWindow: result.contextWindow ?? 0,
			resolvedModel: result.resolvedModel ?? "",
			resolvedModelIsFallback: result.resolvedModelIsFallback ?? false,
			error: result.error ?? "",
			aborted: result.aborted ?? false,
			abortReason: result.abortReason ?? "",
			usage: usage
				? {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
						totalTokens: usage.totalTokens,
						reasoningTokens: usage.reasoningTokens ?? 0,
						cost: usage.cost,
					}
				: null,
			extractedToolData,
			retryFailure: result.retryFailure ?? null,
			artifacts: [],
		},
	};
}

function failedResult(profile: ExternalSubagentProfileV1, error: unknown, startedAt: number): SingleResult {
	const message = error instanceof Error ? error.message : String(error);
	return {
		index: 0,
		id: profile.peerId,
		agent: profile.agent.name,
		agentSource: profile.agent.source,
		task: renderStructuredSubagentPrompt(profile.assignment),
		assignment: profile.assignment,
		description: profile.label,
		exitCode: 1,
		output: "",
		stderr: message,
		truncated: false,
		durationMs: Date.now() - startedAt,
		tokens: 0,
		requests: 0,
		error: message,
	};
}

/** Runs one daemon-started external Task worker from its frozen profile. */
export async function runExternalSubagentMode(
	env: Record<string, string | undefined> = process.env,
): Promise<SingleResult> {
	const profile = await loadExternalSubagentProfile(env);
	const socketPath = resolveWorldSocketPath({ env });
	const sessionKey = resolveWorldSessionKey({ env });
	if (!socketPath || !sessionKey)
		throw new Error("external subagent mode requires OMP_WORLD_SOCKET and OMP_WORLD_SESSION");
	const backend = createWorldCoordinationBackend({ env });
	if (!backend) throw new Error("external subagent mode could not create its World coordination backend");

	const startedAt = Date.now();
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	let progressWrites = Promise.resolve();
	let result: SingleResult;
	try {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
		});
		const loadedSkills = await loadSkills({ cwd: profile.workspaceRoots[0] });
		const selectedSkills = profile.agent.skills.map(name => {
			const skill = loadedSkills.skills.find(candidate => candidate.name === name);
			if (!skill) throw new Error(`frozen skill ${JSON.stringify(name)} is unavailable`);
			return skill;
		});
		authStorage = await discoverAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		result = await runSubprocess({
			cwd: profile.workspaceRoots[0]!,
			additionalDirectories: profile.workspaceRoots.slice(1),
			agent: {
				name: profile.agent.name,
				description: profile.label,
				systemPrompt: profile.agent.systemPrompt,
				tools: profile.agent.tools,
				spawns: profile.agent.spawns,
				autoloadSkills: profile.agent.skills,
				readSummarize: profile.agent.readMode === "summary",
				source: profile.agent.source,
			},
			task: renderStructuredSubagentPrompt(profile.assignment),
			assignment: profile.assignment,
			context: profile.batchContext ?? undefined,
			planReference: profile.planReference ?? undefined,
			description: profile.label,
			index: 0,
			id: profile.peerId,
			parentToolCallId: profile.parentToolCallId ?? undefined,
			taskDepth: profile.taskDepth,
			modelOverride: profile.modelSelector,
			thinkingLevel: profile.thinkingLevel ?? undefined,
			effort: profile.effort ?? undefined,
			maxRuntimeMs: profile.maxRuntimeMs,
			enableIrc: profile.enableIrc,
			enableLsp: profile.agent.tools.includes("lsp"),
			enableMCP: false,
			restrictToolNames: true,
			keepAlive: false,
			...(profile.outputSchema
				? {
						outputSchema: profile.outputSchema.schema,
						outputSchemaSource: profile.outputSchema.source,
						outputSchemaMode: profile.outputSchema.mode,
					}
				: {}),
			authStorage,
			modelRegistry,
			settings,
			coordinationBackend: backend,
			asyncJobManager: jobs,
			skills: selectedSkills,
			onProgress: progress => {
				progressWrites = progressWrites.then(() => emitRecord(externalTaskProgressRecord(progress)));
			},
		});
		await progressWrites;
	} catch (error) {
		await progressWrites.catch(() => undefined);
		result = failedResult(profile, error, startedAt);
	} finally {
		const cleanupResults = await Promise.allSettled([jobs.dispose({ timeoutMs: 5_000 }), backend.close()]);
		let cleanupError = cleanupResults.find(candidate => candidate.status === "rejected")?.reason;
		try {
			authStorage?.close();
		} catch (error) {
			cleanupError ??= error;
		}
		if (cleanupError !== undefined) result = failedResult(profile, cleanupError, startedAt);
	}
	await emitRecord(externalTaskResultRecord(result));
	return result;
}

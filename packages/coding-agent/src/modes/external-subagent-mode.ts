import { once } from "node:events";
import * as fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonStringify } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async/job-manager";
import { applyCodexHomeAuthToStorage } from "../cli/codex-home";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import {
	decodeExternalSubagentProfile,
	type ExternalSubagentProfileV1,
} from "../coordination/external-subagent-profile";
import { createParentCoordinationBackend } from "../coordination/parent";
import { loadSkills } from "../extensibility/skills";
import { resolveParentExtensionPath, resolveParentSessionId, resolveParentSocketPath } from "../parent/config";
import { discoverAuthStorage } from "../sdk";
import { runSubprocess } from "../task/executor";
import { renderStructuredSubagentPrompt } from "../task/structured-subagent";
import type { AgentProgress, SingleResult } from "../task/types";

export const PARENT_TASK_PROFILE_ENV = "OMP_PARENT_TASK_PROFILE";
export const PARENT_TASK_PROFILE_DIGEST_ENV = "OMP_PARENT_TASK_PROFILE_DIGEST";

/** Whether this process was launched as a parent-managed external Task. */
export function isExternalSubagentConfigured(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env[PARENT_TASK_PROFILE_ENV]?.trim());
}

/** Versioned live progress record consumed by a parent environment. */
export interface ExternalTaskProgressRecord {
	type: "omp_parent_task_progress_v1";
	providerSessionId: string;
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

/** Versioned terminal result record consumed by a parent environment. */
export interface ExternalTaskResultRecord {
	type: "omp_parent_task_result_v1";
	providerSessionId: string;
	taskResult: Record<string, unknown>;
}

function requireExternalProfilePath(env: Record<string, string | undefined>): string {
	const value = env[PARENT_TASK_PROFILE_ENV]?.trim();
	if (!value || !path.isAbsolute(value)) {
		throw new Error(`${PARENT_TASK_PROFILE_ENV} must be an absolute file path`);
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
		throw new Error(`${PARENT_TASK_PROFILE_ENV} must name a mode-0600 regular file`);
	}
	const digest = env[PARENT_TASK_PROFILE_DIGEST_ENV]?.trim() ?? "";
	const bytes = await fs.readFile(profilePath);
	return decodeExternalSubagentProfile(bytes, digest);
}

async function emitRecord(record: ExternalTaskProgressRecord | ExternalTaskResultRecord): Promise<void> {
	if (!process.stdout.write(`${JSON.stringify(record)}\n`)) await once(process.stdout, "drain");
}

/** Maps live Task state onto the versioned parent progress record. */
export function externalTaskProgressRecord(
	progress: AgentProgress,
	providerSessionId = "",
): ExternalTaskProgressRecord {
	return {
		type: "omp_parent_task_progress_v1",
		providerSessionId,
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

/** Maps the complete Task result onto the versioned parent terminal record. */
export function externalTaskResultRecord(result: SingleResult, providerSessionId = ""): ExternalTaskResultRecord {
	const usage = result.usage;
	const extractedToolData = Object.entries(result.extractedToolData ?? {}).map(([toolName, values]) => ({
		toolName,
		values: values.map(value => canonicalJsonStringify(value)),
	}));
	return {
		type: "omp_parent_task_result_v1",
		providerSessionId,
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
	const socketPath = resolveParentSocketPath({ env });
	const sessionKey = resolveParentSessionId({ env });
	if (!socketPath || !sessionKey)
		throw new Error("external subagent mode requires OMP_PARENT_SOCKET and OMP_PARENT_SESSION");
	const backend = createParentCoordinationBackend({ env });
	if (!backend) throw new Error("external subagent mode could not create its parent coordination backend");
	const parentExtension = resolveParentExtensionPath(env);

	const startedAt = Date.now();
	const jobs = new AsyncJobManager({ onJobComplete: () => {} });
	let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>> | undefined;
	let progressWrites = Promise.resolve();
	let providerSessionId = "";
	let result: SingleResult;
	try {
		const settings = Settings.isolated({
			"async.enabled": true,
			"task.isolation.mode": "none",
		});
		authStorage = await discoverAuthStorage();
		applyCodexHomeAuthToStorage(
			authStorage,
			{ configuredHomes: settings.get("providers.codexHomes") },
			env as NodeJS.ProcessEnv,
		);
		const modelRegistry = new ModelRegistry(authStorage);
		const loadedSkills = await loadSkills({ cwd: profile.workspaceRoots[0] });
		const selectedSkills = profile.agent.skills.map(name => {
			const skill = loadedSkills.skills.find(candidate => candidate.name === name);
			if (!skill) throw new Error(`frozen skill ${JSON.stringify(name)} is unavailable`);
			return skill;
		});
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
			restrictedExtensionPaths: parentExtension ? [parentExtension] : [],
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
			onSessionCreated: sessionId => {
				providerSessionId = sessionId;
			},
			onProgress: progress => {
				progressWrites = progressWrites.then(() =>
					emitRecord(externalTaskProgressRecord(progress, providerSessionId)),
				);
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
	await emitRecord(externalTaskResultRecord(result, providerSessionId));
	return result;
}

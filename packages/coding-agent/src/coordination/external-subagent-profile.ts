import { canonicalJsonStringify } from "@oh-my-pi/pi-utils";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { OverallPlanReference } from "../plan-mode/plan-handoff";
import type { EffectiveSubagentPolicy, StructuredSubagentRequest } from "../task/structured-subagent";
import type { AgentSource, StructuredSubagentSchemaMode, StructuredSubagentSchemaSource } from "../task/types";
import { type ConfiguredThinkingLevel, parseConfiguredThinkingLevel, type TaskEffort } from "../thinking";

export const EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES = 1 << 20;

/** Frozen policy for one native, non-isolated external Task worker. */
export interface ExternalSubagentProfileV1 {
	schemaVersion: 1;
	runtime: "native";
	isolated: false;
	peerId: string;
	label: string;
	assignment: string;
	batchContext: string | null;
	parentToolCallId: string | null;
	taskDepth: number;
	agent: {
		name: string;
		source: AgentSource;
		systemPrompt: string;
		tools: string[];
		spawns: string[] | "*";
		skills: string[];
		readMode: "summary" | "raw";
	};
	effort: TaskEffort | null;
	enableIrc: boolean;
	modelSelector: string[];
	thinkingLevel: ConfiguredThinkingLevel | null;
	maxRuntimeMs: number;
	outputSchema: {
		schema: unknown;
		source: Exclude<StructuredSubagentSchemaSource, "none">;
		mode: StructuredSubagentSchemaMode;
	} | null;
	planReference: { path: string; content: string } | null;
	workspaceRoots: string[];
}

export interface EncodedExternalSubagentProfile {
	bytes: Uint8Array;
	digest: string;
}

export interface BuildExternalSubagentProfileArgs {
	peerId: string;
	label: string;
	request: StructuredSubagentRequest;
	policy: EffectiveSubagentPolicy;
	planReference?: OverallPlanReference;
}

const PROFILE_KEYS = [
	"agent",
	"assignment",
	"batchContext",
	"effort",
	"enableIrc",
	"isolated",
	"label",
	"maxRuntimeMs",
	"modelSelector",
	"outputSchema",
	"parentToolCallId",
	"peerId",
	"planReference",
	"runtime",
	"schemaVersion",
	"taskDepth",
	"thinkingLevel",
	"workspaceRoots",
] as const;
const AGENT_KEYS = ["name", "readMode", "skills", "source", "spawns", "systemPrompt", "tools"] as const;
const OUTPUT_SCHEMA_KEYS = ["mode", "schema", "source"] as const;
const PLAN_REFERENCE_KEYS = ["content", "path"] as const;

function requireRecord(value: unknown, name: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[], name: string): void {
	const actual = Object.keys(record).sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw new Error(`${name} has unknown or missing fields`);
	}
}

function requireString(value: unknown, name: string, allowEmpty = false): asserts value is string {
	if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
		throw new Error(`${name} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
	}
}

function requireNullableString(value: unknown, name: string): asserts value is string | null {
	if (value !== null) requireString(value, name);
}

function requireStringArray(value: unknown, name: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
		throw new Error(`${name} must contain only nonempty strings`);
	}
}

function validateProfile(value: unknown): asserts value is ExternalSubagentProfileV1 {
	const profile = requireRecord(value, "external subagent profile");
	requireExactKeys(profile, PROFILE_KEYS, "external subagent profile");
	if (profile.schemaVersion !== 1) throw new Error("external subagent profile schemaVersion must be 1");
	if (profile.runtime !== "native" || profile.isolated !== false) {
		throw new Error("external subagent profile requires runtime=native and isolated=false");
	}
	requireString(profile.peerId, "peerId");
	requireString(profile.label, "label");
	requireString(profile.assignment, "assignment");
	requireNullableString(profile.batchContext, "batchContext");
	requireNullableString(profile.parentToolCallId, "parentToolCallId");
	if (typeof profile.taskDepth !== "number" || !Number.isSafeInteger(profile.taskDepth) || profile.taskDepth < 0) {
		throw new Error("taskDepth must be a nonnegative safe integer");
	}
	if (profile.effort !== null && profile.effort !== "lo" && profile.effort !== "med" && profile.effort !== "hi") {
		throw new Error("effort is invalid");
	}
	if (typeof profile.enableIrc !== "boolean") throw new Error("enableIrc must be a boolean");
	requireStringArray(profile.modelSelector, "modelSelector");
	if (profile.modelSelector.length === 0) throw new Error("modelSelector must not be empty");
	requireNullableString(profile.thinkingLevel, "thinkingLevel");
	if (profile.thinkingLevel !== null && parseConfiguredThinkingLevel(profile.thinkingLevel) === undefined) {
		throw new Error("thinkingLevel is invalid");
	}
	if (
		typeof profile.maxRuntimeMs !== "number" ||
		!Number.isSafeInteger(profile.maxRuntimeMs) ||
		profile.maxRuntimeMs < 0
	) {
		throw new Error("maxRuntimeMs must be a nonnegative safe integer");
	}
	requireStringArray(profile.workspaceRoots, "workspaceRoots");
	if (profile.workspaceRoots.length === 0 || profile.workspaceRoots.some(root => !root.startsWith("/"))) {
		throw new Error("workspaceRoots must contain absolute paths");
	}

	const agent = requireRecord(profile.agent, "agent");
	requireExactKeys(agent, AGENT_KEYS, "agent");
	requireString(agent.name, "agent.name");
	if (agent.source !== "bundled" && agent.source !== "user" && agent.source !== "project") {
		throw new Error("agent.source must be bundled, user, or project");
	}
	requireString(agent.systemPrompt, "agent.systemPrompt", true);
	requireStringArray(agent.tools, "agent.tools");
	if (agent.spawns !== "*") requireStringArray(agent.spawns, "agent.spawns");
	requireStringArray(agent.skills, "agent.skills");
	if (agent.readMode !== "summary" && agent.readMode !== "raw") {
		throw new Error("agent.readMode must be summary or raw");
	}

	if (profile.outputSchema !== null) {
		const outputSchema = requireRecord(profile.outputSchema, "outputSchema");
		requireExactKeys(outputSchema, OUTPUT_SCHEMA_KEYS, "outputSchema");
		if (outputSchema.source !== "caller" && outputSchema.source !== "agent" && outputSchema.source !== "session") {
			throw new Error("outputSchema.source is invalid");
		}
		if (outputSchema.mode !== "permissive" && outputSchema.mode !== "strict") {
			throw new Error("outputSchema.mode is invalid");
		}
	}
	if (profile.planReference !== null) {
		const planReference = requireRecord(profile.planReference, "planReference");
		requireExactKeys(planReference, PLAN_REFERENCE_KEYS, "planReference");
		requireString(planReference.path, "planReference.path");
		requireString(planReference.content, "planReference.content");
	}
}

function profileDigest(bytes: Uint8Array): string {
	return Bun.SHA256.hash(bytes, "hex");
}

/** Builds the complete frozen profile from one already-resolved Task policy. */
export function buildExternalSubagentProfile(args: BuildExternalSubagentProfileArgs): ExternalSubagentProfileV1 {
	const { request, policy } = args;
	if (policy.claudeCode || policy.isIsolated) {
		throw new Error("unsupported_world_runtime: external Task requires a native, non-isolated policy");
	}
	const rawSelector = policy.modelOverride ?? policy.parentActiveModelPattern;
	const modelSelector = resolveConfiguredModelPatterns(rawSelector, request.session.settings);
	if (modelSelector.length === 0) throw new Error("external Task policy has no resolved model selector");
	const tools = policy.effectiveAgent.tools ?? [...(request.session.toolRegistry?.keys() ?? [])];
	if (tools.length === 0) throw new Error("external Task policy has no resolved tool list");
	const schema =
		policy.schema.source === "none"
			? null
			: {
					schema: policy.schema.schema,
					source: policy.schema.source,
					mode: policy.schema.mode,
				};
	return {
		schemaVersion: 1,
		runtime: "native",
		isolated: false,
		peerId: args.peerId,
		label: args.label,
		assignment: request.assignment.trim(),
		batchContext: request.context?.trim() || null,
		parentToolCallId: request.parentToolCallId ?? null,
		taskDepth: request.session.taskDepth ?? 0,
		agent: {
			name: policy.effectiveAgent.name,
			source: policy.effectiveAgent.source,
			systemPrompt: policy.effectiveAgent.systemPrompt,
			tools: [...tools],
			spawns: policy.effectiveAgent.spawns === "*" ? "*" : [...(policy.effectiveAgent.spawns ?? [])],
			skills: [...(policy.effectiveAgent.autoloadSkills ?? [])],
			readMode: policy.effectiveAgent.readSummarize === false ? "raw" : "summary",
		},
		effort: request.effort ?? null,
		enableIrc: policy.enableIrc,
		modelSelector,
		thinkingLevel: policy.effectiveAgent.thinkingLevel ?? null,
		maxRuntimeMs: request.maxRuntimeMs ?? request.session.settings.get("task.maxRuntimeMs"),
		outputSchema: schema,
		planReference: args.planReference ?? null,
		workspaceRoots: [request.session.cwd, ...(request.session.additionalDirectories ?? [])],
	};
}

/** Encodes and hashes one canonical external worker profile. */
export function encodeExternalSubagentProfile(profile: ExternalSubagentProfileV1): EncodedExternalSubagentProfile {
	validateProfile(profile);
	const bytes = new TextEncoder().encode(canonicalJsonStringify(profile));
	if (bytes.byteLength > EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES) {
		throw new Error(`external subagent profile exceeds ${EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES} bytes`);
	}
	return { bytes, digest: profileDigest(bytes) };
}

/** Validates canonical bytes and their lowercase SHA-256 receipt. */
export function decodeExternalSubagentProfile(bytes: Uint8Array, digest: string): ExternalSubagentProfileV1 {
	if (bytes.byteLength === 0 || bytes.byteLength > EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES) {
		throw new Error(`external subagent profile must contain 1-${EXTERNAL_SUBAGENT_PROFILE_MAX_BYTES} bytes`);
	}
	if (!/^[0-9a-f]{64}$/.test(digest) || profileDigest(bytes) !== digest) {
		throw new Error("external subagent profile digest does not match its bytes");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error("external subagent profile must be UTF-8", {
			cause: error,
		});
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error("external subagent profile must be JSON", { cause: error });
	}
	validateProfile(value);
	if (canonicalJsonStringify(value) !== text) {
		throw new Error("external subagent profile JSON is not canonical");
	}
	return value;
}

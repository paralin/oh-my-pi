/** Final provider request profiles and their captured conformance boundary. */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Message,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

export type RequestProfileKind = "primary-ipython" | "act" | "compression" | "no-tools";

interface RequestProfileBase {
	systemPrompt: string[];
}

export type RequestProfile =
	| (RequestProfileBase & { kind: "primary-ipython" | "act"; tools: [AgentTool] })
	| (RequestProfileBase & { kind: "compression"; tools: [AgentTool, AgentTool] })
	| (RequestProfileBase & { kind: "no-tools"; tools: [] });

export interface EffectiveProviderRequest {
	profile: RequestProfileKind;
	provider: string;
	systemPrompt: string[];
	tools: Array<{ name: string; parameters: unknown }>;
	payload: unknown;
	unsupportedTransport?: { transport: string; reason: string };
}

const REDACTED = "[redacted]";
const CREDENTIAL_KEY = /(?:authorization|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)/i;
const MESSAGE_KEYS = new Set(["messages", "input", "contents"]);

function redactProviderPayload(value: unknown, key?: string): unknown {
	if (key && (MESSAGE_KEYS.has(key) || CREDENTIAL_KEY.test(key))) return REDACTED;
	if (Array.isArray(value)) return value.map(item => redactProviderPayload(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value).map(([childKey, child]) => [childKey, redactProviderPayload(child, childKey)]),
	);
}

function hasExactCodeSchema(tool: AgentTool): boolean {
	const schema = toolWireSchema(tool);
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return false;
	const record = schema as Record<string, unknown>;
	if (record.type !== "object" || record.additionalProperties !== false) return false;
	if (Object.keys(record).some(key => !["type", "properties", "required", "additionalProperties"].includes(key))) {
		return false;
	}
	const properties = record.properties;
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return false;
	if (Object.keys(properties).length !== 1 || !("code" in properties)) return false;
	const code = (properties as Record<string, unknown>).code;
	if (typeof code !== "object" || code === null || Array.isArray(code)) return false;
	const codeRecord = code as Record<string, unknown>;
	if (Object.keys(codeRecord).length !== 1 || codeRecord.type !== "string") return false;
	return Array.isArray(record.required) && record.required.length === 1 && record.required[0] === "code";
}

function assertSingleCodeTool(profile: RequestProfile, name: "ipython" | "shared_ipython"): void {
	const [tool] = profile.tools;
	const hasRequiredConcurrency = profile.kind !== "primary-ipython" || tool?.concurrency === "exclusive";
	if (profile.tools.length !== 1 || tool?.name !== name || !hasRequiredConcurrency || !hasExactCodeSchema(tool)) {
		throw new Error(
			profile.kind === "primary-ipython"
				? "primary-ipython must expose only exclusive ipython with the exact required {code: string} schema"
				: "act must expose only shared_ipython with the exact required {code: string} schema",
		);
	}
}

function assertProfile(profile: RequestProfile): void {
	if (profile.kind === "primary-ipython") {
		assertSingleCodeTool(profile, "ipython");
		return;
	}
	if (profile.kind === "act") {
		assertSingleCodeTool(profile, "shared_ipython");
		return;
	}
	const names = profile.tools.map(tool => tool.name);
	if (profile.kind === "compression" && (names.length !== 2 || names[0] !== "rewrite" || names[1] !== "approve")) {
		throw new Error("compression must expose the fixed rewrite and approve tools");
	}
	if (profile.kind === "no-tools" && names.length !== 0) throw new Error("no-tools must not expose tools");
}

interface WireProfile {
	systemPrompt: string[];
	tools: Array<{ name: string; parameters: unknown }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function textParts(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item === "string") return [item];
		const record = asRecord(item);
		return typeof record?.text === "string" ? [record.text] : [];
	});
}

function extractSystemPrompt(body: Record<string, unknown>): string[] {
	if (body.instructions !== undefined) return textParts(body.instructions);
	if (body.system !== undefined) return textParts(body.system);

	const systemInstruction = asRecord(body.systemInstruction ?? body.system_instruction);
	if (systemInstruction) return textParts(systemInstruction.parts);

	if (Array.isArray(body.messages)) {
		return body.messages.flatMap(message => {
			const record = asRecord(message);
			return record?.role === "system" || record?.role === "developer" ? textParts(record.content) : [];
		});
	}
	return [];
}

function extractTools(body: Record<string, unknown>): Array<{ name: string; parameters: unknown }> {
	const result: Array<{ name: string; parameters: unknown }> = [];
	if (Array.isArray(body.tools)) {
		for (const item of body.tools) {
			const record = asRecord(item);
			if (!record) continue;
			const fn = asRecord(record.function);
			const declaration = fn ?? record;
			if (typeof declaration.name === "string") {
				result.push({
					name: declaration.name,
					parameters: structuredClone(
						declaration.parameters ?? declaration.input_schema ?? declaration.inputSchema ?? {},
					),
				});
			}
			const declarations = record.functionDeclarations ?? record.function_declarations;
			if (Array.isArray(declarations)) {
				for (const entry of declarations) {
					const candidate = asRecord(entry);
					if (typeof candidate?.name !== "string") continue;
					result.push({
						name: candidate.name,
						parameters: structuredClone(candidate.parameters ?? candidate.parametersJsonSchema ?? {}),
					});
				}
			}
		}
	}

	const toolConfig = asRecord(body.toolConfig ?? body.tool_config);
	if (Array.isArray(toolConfig?.tools)) {
		for (const item of toolConfig.tools) {
			const toolSpec = asRecord(asRecord(item)?.toolSpec ?? asRecord(item)?.tool_spec);
			if (typeof toolSpec?.name !== "string") continue;
			const inputSchema = asRecord(toolSpec.inputSchema ?? toolSpec.input_schema);
			result.push({ name: toolSpec.name, parameters: structuredClone(inputSchema?.json ?? inputSchema ?? {}) });
		}
	}
	return result;
}

function extractWireProfile(payload: unknown): WireProfile {
	const body = asRecord(payload);
	if (!body) throw new Error("provider request body must be an object");
	return { systemPrompt: extractSystemPrompt(body), tools: extractTools(body) };
}

/** Owns one prompt and concrete tool list and records the request after provider hooks. */
export class RequestProfileOwner {
	readonly #request: RequestProfile;
	#lastEffectiveRequest: EffectiveProviderRequest | undefined;

	constructor(profile: RequestProfile) {
		assertProfile(profile);
		this.#request = profile;
	}

	static primary(systemPrompt: string[], tool: AgentTool): RequestProfileOwner {
		return new RequestProfileOwner({ kind: "primary-ipython", systemPrompt, tools: [tool] });
	}

	static act(systemPrompt: string[], tool: AgentTool): RequestProfileOwner {
		return new RequestProfileOwner({ kind: "act", systemPrompt, tools: [tool] });
	}

	static compression(systemPrompt: string[], tools: [AgentTool, AgentTool]): RequestProfileOwner {
		return new RequestProfileOwner({ kind: "compression", systemPrompt, tools });
	}

	static noTools(systemPrompt: string[]): RequestProfileOwner {
		return new RequestProfileOwner({ kind: "no-tools", systemPrompt, tools: [] });
	}

	get request(): RequestProfile {
		return this.#request;
	}

	get lastEffectiveRequest(): EffectiveProviderRequest | undefined {
		return this.#lastEffectiveRequest;
	}

	/** Record the literal prompt and tools from the final provider body. */
	captureEffectiveRequest(input: { provider: string; payload: unknown }): void {
		const payload = asRecord(input.payload);
		const unsupported =
			payload?.kind === "unsupported" && typeof payload.transport === "string" && typeof payload.reason === "string"
				? { transport: payload.transport, reason: payload.reason }
				: undefined;
		const wireProfile = unsupported ? { systemPrompt: [], tools: [] } : extractWireProfile(input.payload);
		this.#lastEffectiveRequest = {
			profile: this.#request.kind,
			provider: input.provider,
			systemPrompt: wireProfile.systemPrompt,
			tools: wireProfile.tools,
			payload: structuredClone(input.payload),
			...(unsupported ? { unsupportedTransport: unsupported } : {}),
		};
	}

	/** Complete one no-tools request through the provider's final payload hook. */
	async complete(model: Model<Api>, messages: Message[], options: SimpleStreamOptions): Promise<AssistantMessage> {
		if (this.#request.kind !== "no-tools") throw new Error("complete is available only for no-tools profiles");
		const context: Context = {
			systemPrompt: this.#request.systemPrompt,
			tools: this.#request.tools,
			messages,
		};
		const priorOnFinalPayload = options.onFinalPayload;
		return completeSimple(model, context, {
			...options,
			onFinalPayload: async (payload, requestModel) => {
				await priorOnFinalPayload?.(payload, requestModel);
				this.captureEffectiveRequest({
					provider: requestModel?.provider ?? model.provider,
					payload,
				});
			},
		});
	}

	/** Operator-safe view of the same captured request; messages and credentials are removed. */
	lastEffectiveRequestDiagnostic(): EffectiveProviderRequest | undefined {
		const captured = this.#lastEffectiveRequest;
		if (!captured) return undefined;
		return { ...captured, payload: redactProviderPayload(captured.payload) };
	}
}

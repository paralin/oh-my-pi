import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, FetchImpl, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	measurePromptJson,
	measurePromptText,
	type PromptPayloadSize,
	promptPayloadDelta,
} from "@oh-my-pi/pi-coding-agent/ipython/prompt-measurement";
import { createIpythonProviderTool } from "@oh-my-pi/pi-coding-agent/ipython/provider-tool";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";

const WORKSPACE = "/workspace/omp-prompt-baseline";
const PROJECT_CONTEXT = "# Project instructions\n\nPreserve observable behavior and verify the changed path.\n";

export interface IpythonProviderRequestCapture {
	readonly fixtureVersion: 1;
	readonly provider: "anthropic-messages";
	readonly categories: {
		readonly fixedOmp: PromptPayloadSize;
		readonly generatedOmp: PromptPayloadSize;
		readonly projectAuthored: PromptPayloadSize;
		readonly projectContextEnvelope: PromptPayloadSize;
		readonly providerWrapper: PromptPayloadSize;
		readonly toolSchemas: PromptPayloadSize;
	};
	readonly totalFirstRequest: PromptPayloadSize;
	readonly bodySha256: string;
	readonly systemPromptParts: number;
	readonly toolNames: readonly string[];
	readonly toolSchema: Record<string, unknown>;
	readonly toolConcurrency: string;
	readonly projectContextIndex: number;
	readonly runtimeInstructionIndex: number;
	readonly volatileNoticeIndex: number;
}

function promptOptions(contextFiles: BuildSystemPromptOptions["contextFiles"]): BuildSystemPromptOptions {
	return {
		calendarDate: "2026-08-06",
		contextFiles,
		cwd: WORKSPACE,
		recursiveDepth: 0,
		resolvedAppendSystemPrompt: "",
		resolvedSystemPromptCustomization: null,
		sessionLogLocation: `${WORKSPACE}/session.jsonl`,
		sessionNotice: "baseline",
	};
}

function baselineModelSpec(): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		baseUrl: "https://baseline.invalid",
		contextWindow: 200_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		id: "claude-sonnet-4-6",
		input: ["text"],
		maxTokens: 64_000,
		name: "Baseline Claude",
		provider: "anthropic",
		reasoning: true,
	};
}

function sha256(value: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

/** Capture the one-tool first request through a mock transport; no provider or optional extension is loaded. */
export async function captureIpythonProviderRequest(): Promise<IpythonProviderRequestCapture> {
	const ipython = createIpythonProviderTool(async () => {
		throw new Error("fixture tool is not executable");
	});
	const tools: AgentTool<any, any, any>[] = [ipython as AgentTool<any, any, any>];
	const fixed = await buildSystemPrompt(promptOptions([]));
	const full = await buildSystemPrompt(
		promptOptions([{ path: `${WORKSPACE}/AGENTS.md`, content: PROJECT_CONTEXT, depth: 0 }]),
	);

	const context: Context = {
		systemPrompt: full.systemPrompt,
		messages: [
			{ role: "user", content: "Capture the first request.", timestamp: Date.parse("2026-08-06T00:00:00Z") },
		],
		tools,
	};
	let body: Record<string, unknown> | undefined;
	const fetch: FetchImpl = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response('{"error":{"message":"captured"}}', { status: 400 });
	};
	try {
		await streamAnthropic(buildModel(baselineModelSpec()), context, {
			apiKey: "fixture-key-never-sent",
			fetch,
		}).result();
	} catch {
		// The mock response stops immediately after the request body is captured.
	}
	if (!body) throw new Error("Anthropic request fixture did not reach the mock transport");

	const fixedSize = measurePromptText([fixed.systemPrompt[0] ?? ""]);
	const generatedSize = measurePromptText(fixed.systemPrompt);
	const fullSize = measurePromptText(full.systemPrompt);
	const wrapper = { ...body, system: [], messages: [], tools: [] };
	const serializedBody = JSON.stringify(body);
	const wireTools = Array.isArray(body.tools) ? body.tools : [];
	const toolNames = wireTools.map(tool => {
		if (!tool || typeof tool !== "object" || !("name" in tool) || typeof tool.name !== "string") {
			throw new TypeError("Provider tool fixture is missing a string name");
		}
		return tool.name;
	});

	return {
		fixtureVersion: 1,
		provider: "anthropic-messages",
		categories: {
			fixedOmp: fixedSize,
			generatedOmp: promptPayloadDelta(generatedSize, fixedSize),
			projectAuthored: measurePromptText([PROJECT_CONTEXT]),
			projectContextEnvelope: promptPayloadDelta(fullSize, generatedSize),
			providerWrapper: measurePromptJson(wrapper),
			toolSchemas: measurePromptJson(wireTools),
		},
		totalFirstRequest: measurePromptJson(body),
		bodySha256: sha256(serializedBody),
		systemPromptParts: full.systemPrompt.length,
		toolNames,
		toolSchema: (wireTools[0] as { input_schema?: Record<string, unknown> })?.input_schema ?? {},
		toolConcurrency: ipython.concurrency === "exclusive" ? "exclusive" : "other",
		projectContextIndex: full.systemPrompt.findIndex(part => part.includes(PROJECT_CONTEXT.trim())),
		runtimeInstructionIndex: full.systemPrompt.findIndex(part => part.includes("Persistent IPython")),
		volatileNoticeIndex: full.systemPrompt.findIndex(part => part.includes("Today is 2026-08-06.")),
	};
}

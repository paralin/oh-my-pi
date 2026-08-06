import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, FetchImpl, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	measurePromptJson,
	measurePromptText,
	type PromptPayloadSize,
	promptPayloadDelta,
} from "@oh-my-pi/pi-coding-agent/ipython/prompt-measurement";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	buildSystemPromptToolMetadata,
} from "@oh-my-pi/pi-coding-agent/system-prompt";
import { createTools, type Tool, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const WORKSPACE = "/workspace/omp-prompt-baseline";
const PROJECT_CONTEXT = "# Project instructions\n\nPreserve observable behavior and verify the changed path.\n";
const BASELINE_SOURCE_REVISION = "6c079d5149b177258e20adb12c00399cda5ce548";

export interface PreIpythonPromptBaseline {
	readonly fixtureVersion: 1;
	readonly sourceRevision: string;
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
}

function baselineSettings(): Settings {
	return Settings.isolated({
		"autolearn.enabled": false,
		"checkpoint.enabled": false,
		"goal.enabled": false,
		"memory.backend": "disabled",
	});
}

function toolSession(settings: Settings): ToolSession {
	return {
		cwd: WORKSPACE,
		enableIrc: false,
		enableLsp: false,
		enableMCP: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		hasUI: false,
		settings,
		skipPythonPreflight: true,
	};
}

function promptOptions(
	tools: Map<string, Tool>,
	contextFiles: BuildSystemPromptOptions["contextFiles"],
): BuildSystemPromptOptions {
	const contextPath = `${WORKSPACE}/AGENTS.md`;
	return {
		activeRepoContext: null,
		calendarDate: "2026-08-06",
		contextFiles,
		cwd: WORKSPACE,
		environmentInfo: [
			{ label: "OS", value: "baseline-os 1" },
			{ label: "Arch", value: "baseline-arch" },
		],
		includeModelInPrompt: true,
		includeWorkspaceTree: false,
		model: "anthropic/claude-sonnet-4-6",
		obsidianAvailable: false,
		resolvedAppendSystemPrompt: "",
		resolvedSystemPromptCustomization: null,
		rules: [],
		skills: [],
		toolNames: Array.from(tools.keys()),
		tools: buildSystemPromptToolMetadata(tools),
		workspaceTree: {
			rootPath: WORKSPACE,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: contextFiles?.length ? [contextPath] : [],
		},
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

/** Capture the pre-cutover first request through a mock transport; no provider or optional extension is loaded. */
export async function capturePreIpythonPromptBaseline(): Promise<PreIpythonPromptBaseline> {
	const tools = await createTools(toolSession(baselineSettings()));
	const toolMap = new Map<string, Tool>(tools.map(tool => [tool.name, tool]));
	const emptyTools = new Map<string, Tool>();
	const fixed = await buildSystemPrompt(promptOptions(emptyTools, []));
	const generated = await buildSystemPrompt(promptOptions(toolMap, []));
	const full = await buildSystemPrompt(
		promptOptions(toolMap, [{ path: `${WORKSPACE}/AGENTS.md`, content: PROJECT_CONTEXT, depth: 0 }]),
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

	const fixedSize = measurePromptText(fixed.systemPrompt);
	const generatedSize = measurePromptText(generated.systemPrompt);
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
		sourceRevision: BASELINE_SOURCE_REVISION,
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
	};
}

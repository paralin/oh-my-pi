import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { generateConventionalAnalysis } from "../../src/commit/analysis/conventional";
import { generateSummary } from "../../src/commit/analysis/summary";
import { generateChangelogEntries } from "../../src/commit/changelog/generate";
import { runMapPhase } from "../../src/commit/map-reduce/map-phase";
import { runReducePhase } from "../../src/commit/map-reduce/reduce-phase";
import { CompressProtocol } from "../../src/compress/protocol";
import { createCompressSession } from "../../src/compress/session";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionFactory } from "../../src/extensibility/extensions/types";
import * as sdkModule from "../../src/sdk";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { type EffectiveProviderRequest, RequestProfileOwner } from "../../src/session/request-profile";
import { SessionManager } from "../../src/session/session-manager";
import { runSubprocess } from "../../src/task/executor";
import { generateCommitMessage } from "../../src/utils/commit-message-generator";
import { asGlobalFetch } from "../helpers/fetch-mock";

interface Capture {
	declaredPrompt: string[];
	effective: EffectiveProviderRequest;
}

const captures: Capture[] = [];

function openAiResponse(text: string, model: Model): Response {
	const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
		id: "request-profile-test",
		object: "chat.completion.chunk",
		created: 0,
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
	return new Response(
		`data: ${JSON.stringify(chunk({ role: "assistant", content: text }, null))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } },
	);
}

afterEach(() => {
	captures.length = 0;
	vi.restoreAllMocks();
});

describe("production no-tools request profiles", () => {
	it("routes generateCommitMessage and every one-shot commit surface through the real adapter boundary", async () => {
		const bundled = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("openai/gpt-4o-mini unavailable");
		const model = { ...bundled, api: "openai-completions" as const };
		const originalCapture = RequestProfileOwner.prototype.captureEffectiveRequest;
		vi.spyOn(RequestProfileOwner.prototype, "captureEffectiveRequest").mockImplementation(function (
			this: RequestProfileOwner,
			input,
		) {
			originalCapture.call(this, input);
			const effective = this.lastEffectiveRequest;
			if (!effective) throw new Error("capture did not record an effective request");
			captures.push({ declaredPrompt: [...this.request.systemPrompt], effective });
		});

		const responses = [
			"fix: preserve request profile",
			JSON.stringify({ type: "fix", scope: null, details: [], issue_refs: [] }),
			"preserve request profile",
			JSON.stringify({ entries: { Fixed: ["Preserve request profile"] } }),
			"- observes the request profile",
			JSON.stringify({ type: "fix", scope: null, details: [], issue_refs: [] }),
		];
		let responseIndex = 0;
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				const response = responses[responseIndex++];
				if (response === undefined) throw new Error("unexpected provider request");
				expect(body.profileMarker).toBe("post-extension");
				return openAiResponse(response, model);
			}),
		);
		const appendMarker = async (payload: unknown) => ({
			...(payload as Record<string, unknown>),
			profileMarker: "post-extension",
		});
		// One-shot callers have no extension runner, so install the same final payload
		// replacement seam they pass to RequestProfileOwner.complete.
		const complete = RequestProfileOwner.prototype.complete;
		vi.spyOn(RequestProfileOwner.prototype, "complete").mockImplementation(function (
			this: RequestProfileOwner,
			m,
			messages,
			options,
		) {
			return complete.call(this, m, messages, { ...options, onPayload: appendMarker });
		});

		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => "test-key",
		} as never;
		const settings = Settings.isolated();
		await generateCommitMessage("diff --git a/a b/a\n+change", registry, settings);
		await generateConventionalAnalysis({
			model,
			apiKey: "test-key",
			scopeCandidates: "core",
			stat: "1 file",
			diff: "+change",
		});
		await generateSummary({
			model,
			apiKey: "test-key",
			commitType: "fix",
			scope: null,
			details: ["change"],
			stat: "1 file",
			maxChars: 72,
		});
		await generateChangelogEntries({
			model,
			apiKey: "test-key",
			changelogPath: "CHANGELOG.md",
			isPackageChangelog: false,
			stat: "1 file",
			diff: "+change",
		});
		const observations = await runMapPhase({
			model,
			apiKey: "test-key",
			files: [{ filename: "a.ts", content: "+change", additions: 1, deletions: 0, isBinary: false }],
			config: { maxRetries: 1 },
		});
		await runReducePhase({
			model,
			apiKey: "test-key",
			observations,
			stat: "1 file",
			scopeCandidates: "core",
		});

		expect(responseIndex).toBe(6);
		expect(captures).toHaveLength(6);
		for (const capture of captures) {
			expect(capture.effective.profile).toBe("no-tools");
			expect(capture.effective.systemPrompt).toEqual([capture.declaredPrompt.join("\n\n")]);
			expect(capture.effective.tools).toEqual([]);
			expect(capture.effective.payload).toHaveProperty("profileMarker", "post-extension");
		}
	});
});

describe("production session request profile", () => {
	it("captures createAgentSession root and its genuine continuation after extension replacement", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-request-profile-root-"));
		const auth = await AuthStorage.create(path.join(temp, "auth.db"));
		const bundled = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("openai/gpt-4o-mini unavailable");
		const model = { ...bundled, api: "openai-completions" as const };
		auth.setRuntimeApiKey("openai", "test-key");
		const registry = new ModelRegistry(auth, path.join(temp, "models.yml"));
		const originalCapture = RequestProfileOwner.prototype.captureEffectiveRequest;
		vi.spyOn(RequestProfileOwner.prototype, "captureEffectiveRequest").mockImplementation(function (
			this: RequestProfileOwner,
			input,
		) {
			originalCapture.call(this, input);
			const effective = this.lastEffectiveRequest;
			if (!effective) throw new Error("capture did not record an effective request");
			captures.push({ declaredPrompt: [...this.request.systemPrompt], effective });
		});
		const wireBodies: Record<string, unknown>[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				wireBodies.push(body);
				return openAiResponse("completed", model);
			}),
		);
		const extension: ExtensionFactory = pi => {
			pi.on("before_provider_request", event => ({
				...(event.payload as Record<string, unknown>),
				profileMarker: "post-extension",
			}));
		};
		const { session } = await createAgentSession({
			cwd: temp,
			agentDir: temp,
			authStorage: auth,
			modelRegistry: registry,
			settings: Settings.isolated({ "advisor.enabled": false, "todo.enabled": false }),
			model,
			sessionManager: SessionManager.inMemory(temp),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			await session.prompt("first production turn");
			await session.prompt("genuine second continuation");
			expect(captures).toHaveLength(2);
			for (const capture of captures) {
				expect(capture.effective.profile).toBe("primary-ipython");
				expect(capture.effective.systemPrompt).toEqual([capture.declaredPrompt.join("\n\n")]);
				expect(capture.effective.tools).toEqual([
					{
						name: "ipython",
						parameters: {
							type: "object",
							properties: { code: { type: "string" } },
							required: ["code"],
							additionalProperties: false,
						},
					},
				]);
				expect(capture.effective.payload).toHaveProperty("profileMarker", "post-extension");
			}
			const secondMessages = wireBodies[1]?.messages as Array<{ role?: string }>;
			expect(secondMessages.some(message => message.role === "assistant")).toBe(true);
			expect(secondMessages.at(-1)?.role).toBe("user");
		} finally {
			await session.dispose();
			auth.close();
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("production child request profiles", () => {
	it("joins Task, compression, and advisor constructors to the final OpenAI wire", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-request-profile-children-"));
		const auth = await AuthStorage.create(path.join(temp, "auth.db"));
		const bundled = getBundledModel("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("openai/gpt-4o-mini unavailable");
		const model = { ...bundled, api: "openai-completions" as const };
		auth.setRuntimeApiKey("openai", "test-key");
		const registry = new ModelRegistry(auth, path.join(temp, "models.yml"));

		const originalCapture = RequestProfileOwner.prototype.captureEffectiveRequest;
		vi.spyOn(RequestProfileOwner.prototype, "captureEffectiveRequest").mockImplementation(function (
			this: RequestProfileOwner,
			input,
		) {
			originalCapture.call(this, input);
			const effective = this.lastEffectiveRequest;
			if (!effective) throw new Error("capture did not record an effective request");
			captures.push({ declaredPrompt: [...this.request.systemPrompt], effective });
		});
		vi.spyOn(ModelRegistry.prototype, "getAvailable").mockReturnValue([model]);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue();
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(auth);
		const emitBeforeProviderRequest = ExtensionRunner.prototype.emitBeforeProviderRequest;
		vi.spyOn(ExtensionRunner.prototype, "emitBeforeProviderRequest").mockImplementation(async function (
			this: ExtensionRunner,
			payload,
			requestModel,
		) {
			const replaced = await emitBeforeProviderRequest.call(this, payload, requestModel);
			return { ...(replaced as Record<string, unknown>), profileMarker: "before-provider-request" };
		});
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async (_input, init) => {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				expect(body.profileMarker).toBe("before-provider-request");
				const tools = body.tools as Array<{ name?: string; function?: { name?: string } }> | undefined;
				if (tools?.some(tool => tool.name === "rewrite")) {
					return new Response(JSON.stringify({ error: { message: "intentional final-wire stop" } }), {
						status: 400,
						headers: { "Content-Type": "application/json" },
					});
				}
				return openAiResponse("completed", model);
			}),
		);

		try {
			const taskResult = await runSubprocess({
				cwd: temp,
				agent: {
					name: "task",
					description: "Production request-profile proof",
					systemPrompt: "Complete the assigned task.",
					source: "bundled",
				},
				task: "Return a final answer.",
				description: "Production child",
				index: 0,
				id: "request-profile-production-child",
				modelOverride: "openai/gpt-4o-mini",
				modelRegistry: registry,
				settings: Settings.isolated({
					"advisor.enabled": false,
					"todo.enabled": false,
					"task.agentIdleTtlMs": 1,
				}),
				enableLsp: false,
				enableIrc: false,
				enableMCP: false,
			});
			expect(taskResult.exitCode).toBe(0);

			const protocol = new CompressProtocol("source text");
			const compressed = await createCompressSession({
				cwd: temp,
				model: "openai/gpt-4o-mini",
				protocol,
				agentId: "RequestProfileCompress",
			});
			try {
				await compressed.session.prompt("Compress the source text.").catch(() => {});
			} finally {
				await compressed.session.dispose();
			}

			const { session: advisorHost } = await createAgentSession({
				cwd: temp,
				agentDir: temp,
				authStorage: auth,
				modelRegistry: registry,
				settings: Settings.isolated({ "advisor.enabled": false, "todo.enabled": false }),
				model,
				sessionManager: SessionManager.inMemory(temp),
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			try {
				advisorHost.settings.setModelRole("advisor", "openai/gpt-4o-mini");
				expect(advisorHost.setAdvisorEnabled(true)).toBe(true);
				const advisor = advisorHost.getAdvisorAgent();
				if (!advisor) throw new Error("production advisor did not start");
				await advisor.prompt("Literal production advisor request.");
			} finally {
				await advisorHost.dispose();
			}

			expect(captures).toHaveLength(3);
			const [task, compression, advisor] = captures;
			if (!task || !compression || !advisor) throw new Error("missing production profile capture");
			const codeSchema = {
				type: "object",
				properties: { code: { type: "string" } },
				required: ["code"],
				additionalProperties: false,
			};
			expect(task.effective).toMatchObject({
				profile: "primary-ipython",
				systemPrompt: [task.declaredPrompt.join("\n\n")],
				tools: [{ name: "ipython", parameters: codeSchema }],
				payload: { profileMarker: "before-provider-request" },
			});
			expect(compression.effective.profile).toBe("compression");
			expect(compression.effective.systemPrompt).toEqual([compression.declaredPrompt.join("\n\n")]);
			expect(compression.effective.tools.map(tool => tool.name)).toEqual(["rewrite", "approve"]);
			expect(compression.effective.tools.map(tool => tool.parameters)).toEqual([
				{
					type: "object",
					properties: {
						text: {
							type: "string",
							description: "the complete compressed text, ready to ship verbatim",
						},
						losses: {
							type: "array",
							items: {
								type: "object",
								properties: {
									content: {
										type: "string",
										description: "the dropped source content, quoted or described precisely",
									},
									reason: {
										type: "string",
										description: "why the compressed text is still correct without it",
									},
								},
								required: ["content", "reason"],
								additionalProperties: false,
							},
							description:
								"every claim, qualifier, example, default, or exact string deliberately dropped; empty array only when the draft loses nothing",
						},
					},
					required: ["text", "losses"],
					additionalProperties: false,
					description: "submit a compressed draft together with everything it drops",
				},
				{
					type: "object",
					properties: {
						verdict: {
							type: "string",
							description: "why the newest draft is acceptable as the final output",
						},
					},
					required: ["verdict"],
					additionalProperties: false,
					description: "accept the newest draft as the final output",
				},
			]);
			expect(compression.effective.payload).toHaveProperty("profileMarker", "before-provider-request");
			expect(advisor.effective).toMatchObject({
				profile: "no-tools",
				systemPrompt: [advisor.declaredPrompt.join("\n\n")],
				tools: [],
				payload: { profileMarker: "before-provider-request" },
			});
		} finally {
			auth.close();
			fs.rmSync(temp, { recursive: true, force: true });
		}
	}, 20_000);
});

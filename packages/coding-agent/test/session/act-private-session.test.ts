import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { IpythonCellProvisioner } from "../../src/ipython/cell";
import { IpythonCellService } from "../../src/ipython/cell";
import type {
	IpythonExecuteOptions,
	IpythonExecutionResult,
	IpythonHostRequestChannel,
} from "../../src/ipython/controller";
import { ActLane, type ActPrivateSession, actUsageFromSessionManager } from "../../src/session/act-lane";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import type { IpythonSessionGeneration, IpythonSessionGenerationOptions } from "../../src/session/ipython-session";
import { convertToLlm } from "../../src/session/messages";
import { type EffectiveProviderRequest, RequestProfileOwner } from "../../src/session/request-profile";
import { SessionManager } from "../../src/session/session-manager";

function channel(): IpythonHostRequestChannel {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		async send() {},
		async receive(signal) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			return { type: "cell_result", stdout: "", stderr: "" };
		},
	};
}

function session(_tool: AgentTool, dispose: () => Promise<void>): ActPrivateSession {
	return {
		model: { provider: "test", id: "model" },
		thinkingLevel: "medium",
		messages: [],
		sessionManager: SessionManager.inMemory("/tmp"),
		async prompt() {},
		subscribe() {
			return () => {};
		},
		abort() {},
		dispose,
		getLastAssistantText() {
			return "";
		},
	};
}

type ToolObservation = { tools: string[]; messages: number };

function openAiResponse(model: Model): Response {
	const chunks = [
		{
			id: "act-final-wire",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: { role: "assistant", content: "provider text" }, finish_reason: null }],
		},
		{
			id: "act-final-wire",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
	];
	return new Response(`${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

function hostChannel(): IpythonHostRequestChannel {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		async send() {},
		async receive(signal) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			return { type: "done" };
		},
	};
}

class ProductionActGeneration implements IpythonSessionGeneration {
	readonly service: IpythonCellService;
	readonly processIds = undefined;

	constructor(options: IpythonSessionGenerationOptions) {
		const provisioner: IpythonCellProvisioner = {
			async ensure() {},
			async execute(_code: string, executeOptions?: IpythonExecuteOptions): Promise<IpythonExecutionResult> {
				const context = executeOptions?.hostContext;
				if (!context) throw new Error("missing host context");
				const handler = options.hostHandlers["rlm.act"];
				if (!handler) throw new Error("production Act handler was not installed");
				const signal = new AbortController().signal;
				for (const index of [1, 2]) {
					const response = await handler({
						requestId: `act-test-request-${index}`,
						executionId: "act-test-execution",
						commId: `act-test-comm-${index}`,
						targetName: "host.request",
						data: { type: "rlm.act", prompt: `provider turn ${index}` },
						signal,
						sessionId: context.sessionId,
						cwd: context.cwd,
						cellId: context.cellId,
						sequence: context.sequence,
						origin: context.origin,
						authority: context.authority,
						channel: hostChannel(),
						publishProgress: async () => {},
						publishDisplay: async () => {},
						allocateArtifact: async () => {
							throw new Error("artifact not used");
						},
					});
					if (response.outcome !== "text") throw new Error(`unexpected Act outcome: ${String(response.outcome)}`);
				}
				return {
					id: "act-test-execution",
					status: "ok",
					stdout: "",
					stderr: "",
					result: undefined,
					events: [],
					errors: [],
					hostArtifacts: [],
				};
			},
			async dispose() {},
		};
		this.service = new IpythonCellService(provisioner, {
			sessionId: options.identity.sessionId,
			cwd: options.identity.cwd,
		});
	}

	prewarm(): void {}
	ready(): Promise<void> {
		return Promise.resolve();
	}
	flushSnapshot(): Promise<undefined> {
		return Promise.resolve(undefined);
	}
	dispose(): Promise<void> {
		return this.service.dispose();
	}
}

describe("production Act factory", () => {
	it("uses the real handler, shared_ipython only, and retains provider transcript", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-act-factory-"));
		const auth = await AuthStorage.create(path.join(temp, "auth.db"));
		auth.setRuntimeApiKey("openai", "test-key");
		const registry = new ModelRegistry(auth, path.join(temp, "models.yml"));
		const bundled = getBundledModel<"openai-completions">("openai", "gpt-4o-mini");
		if (!bundled) throw new Error("test model unavailable");
		const model = { ...bundled, api: "openai-completions" as const };
		const rootManager = SessionManager.create(temp, temp);
		const observations: ToolObservation[] = [];
		const captures: Array<{ declaredPrompt: string[]; effective: EffectiveProviderRequest }> = [];
		const originalCapture = RequestProfileOwner.prototype.captureEffectiveRequest;
		vi.spyOn(RequestProfileOwner.prototype, "captureEffectiveRequest").mockImplementation(function (
			this: RequestProfileOwner,
			input,
		) {
			originalCapture.call(this, input);
			const effective = this.lastEffectiveRequest;
			if (!effective) throw new Error("Act final observer did not capture the request");
			captures.push({ declaredPrompt: [...this.request.systemPrompt], effective });
		});
		const wireBodies: Record<string, unknown>[] = [];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (typeof init?.body !== "string") throw new Error("expected Act JSON request body");
			wireBodies.push(JSON.parse(init.body) as Record<string, unknown>);
			return openAiResponse(model);
		};
		const createRootAgent = () =>
			new Agent({
				initialState: { model, systemPrompt: ["root"], tools: [], messages: [] },
				convertToLlm,
				getApiKey: () => "test-key",
				streamFn: (_selectedModel, context, options) => {
					observations.push({
						tools: (context.tools ?? []).map(tool => tool.name),
						messages: context.messages.length,
					});
					return streamOpenAICompletions(model, context, {
						...options,
						apiKey: "test-key",
						fetch: fetchMock,
					});
				},
			});
		let generationCount = 0;
		const createRootSession = (manager: SessionManager, configureDefault = true) =>
			new AgentSession({
				agent: createRootAgent(),
				sessionManager: manager,
				settings: Settings.isolated({
					"todo.enabled": false,
					...(configureDefault ? { rlmActDefaultModel: `${model.provider}/${model.id}` } : {}),
				}),
				modelRegistry: registry,
				onPayload: async payload => ({ ...(payload as Record<string, unknown>), extensionMarker: "after" }),
				createIpythonSessionGeneration: options => {
					generationCount++;
					return new ProductionActGeneration(options);
				},
			});
		const rootFile = rootManager.getSessionFile();
		if (!rootFile) throw new Error("persistent root session has no session file");
		let session: AgentSession | undefined = createRootSession(rootManager);
		try {
			const outer = await session.executeIpythonCell({
				origin: "direct",
				code: "import rlm\nfirst = await rlm.act('one')\nsecond = await rlm.act('two')\n(first, second)",
			});
			expect(outer.errors).toEqual([]);
			expect(generationCount).toBe(1);
			expect(observations).toHaveLength(2);
			expect(observations.map(observation => observation.tools)).toEqual([["shared_ipython"], ["shared_ipython"]]);
			expect(observations[1]?.messages ?? 0).toBeGreaterThan(observations[0]?.messages ?? 0);
			expect(captures).toHaveLength(2);
			const codeSchema = {
				type: "object",
				properties: { code: { type: "string" } },
				required: ["code"],
				additionalProperties: false,
			};
			for (const [index, capture] of captures.entries()) {
				expect(capture.effective.profile).toBe("act");
				expect(capture.effective.systemPrompt).toEqual([capture.declaredPrompt.join("\n\n")]);
				expect(capture.effective.tools).toEqual([{ name: "shared_ipython", parameters: codeSchema }]);
				expect(capture.effective.payload).toEqual(wireBodies[index]);
				expect(capture.effective.payload).toHaveProperty("extensionMarker", "after");
			}
			const artifactsDir = rootManager.getArtifactsDir();
			if (!artifactsDir) throw new Error("persistent root session has no artifact directory");
			const actDirs = fs.readdirSync(artifactsDir).filter(name => name.startsWith("act-model-"));
			expect(actDirs).toHaveLength(1);
			const transcriptPath = path.join(artifactsDir, actDirs[0] ?? "", "session.jsonl");
			expect(fs.readFileSync(transcriptPath, "utf8").match(/provider text/g)).toHaveLength(2);

			await session.dispose();
			session = undefined;
			const resumedManager = await SessionManager.open(rootFile, temp);
			session = createRootSession(resumedManager);
			const resumed = await session.executeIpythonCell({ origin: "direct", code: "resume Act sidecar" });
			expect(resumed.errors).toEqual([]);
			expect(generationCount).toBe(2);
			expect(observations).toHaveLength(4);
			expect(observations[2]?.messages ?? 0).toBeGreaterThan(observations[1]?.messages ?? 0);
			expect(fs.readFileSync(transcriptPath, "utf8").match(/provider text/g)).toHaveLength(4);

			expect(await session.fork()).toBe(true);
			const forked = await session.executeIpythonCell({ origin: "direct", code: "forked Act sidecar" });
			expect(forked.errors).toEqual([]);
			expect(observations).toHaveLength(6);
			expect(observations[4]?.messages ?? 0).toBeGreaterThan(observations[3]?.messages ?? 0);
			const forkArtifacts = resumedManager.getArtifactsDir();
			if (!forkArtifacts) throw new Error("forked root session has no artifact directory");
			const forkActDir = fs.readdirSync(forkArtifacts).find(name => name.startsWith("act-model-"));
			expect(
				fs
					.readFileSync(path.join(forkArtifacts, forkActDir ?? "", "session.jsonl"), "utf8")
					.match(/provider text/g),
			).toHaveLength(6);

			const forkRootFile = resumedManager.getSessionFile();
			if (!forkRootFile) throw new Error("forked root session has no session file");
			await session.dispose();
			session = undefined;
			fs.writeFileSync(path.join(forkArtifacts, forkActDir ?? "", ".model-key"), "other/model\n");
			const collisionManager = await SessionManager.open(forkRootFile, temp);
			session = createRootSession(collisionManager);
			const collision = await session.executeIpythonCell({ origin: "direct", code: "collision check" });
			expect(collision.errors[0]?.evalue).toContain("Act model session key collision");

			await session.dispose();
			session = undefined;
			const noDefaultManager = await SessionManager.open(forkRootFile, temp);
			session = createRootSession(noDefaultManager, false);
			const noDefault = await session.executeIpythonCell({ origin: "direct", code: "default check" });
			expect(noDefault.errors[0]?.evalue).toContain("No Act model configured");
		} finally {
			await session?.dispose();
			vi.restoreAllMocks();
			auth.close();
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
	it("closes an unmatched durable Act interval on cold root resume", async () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-act-recovery-"));
		const auth = await AuthStorage.create(path.join(temp, "auth.db"));
		const registry = new ModelRegistry(auth, path.join(temp, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model unavailable");
		const initial = SessionManager.create(temp, temp);
		initial.appendActStart(
			"act-interrupted",
			{
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			`${model.provider}/${model.id}`,
		);
		const file = initial.getSessionFile();
		if (!file) throw new Error("persistent session file unavailable");
		await initial.close();
		const resumed = await SessionManager.open(file, temp);
		expect(resumed.getUnmatchedActStarts()).toHaveLength(1);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["root"], tools: [], messages: [] } }),
			sessionManager: resumed,
			settings: Settings.isolated({}),
			modelRegistry: registry,
		});
		try {
			await session.dispose();
			const verified = await SessionManager.open(file, temp);
			try {
				const terminal = verified
					.getEntries()
					.find(entry => entry.type === "act_terminal" && entry.actId === "act-interrupted");
				expect(terminal).toMatchObject({
					type: "act_terminal",
					status: "interrupted",
					error: expect.stringContaining("interrupted"),
				});
			} finally {
				await verified.close();
			}
		} finally {
			auth.close();
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});

describe("production Act lane lifecycle", () => {
	it("awaits retained private-session disposal and can reopen after reset", async () => {
		const lane = new ActLane();
		let creates = 0;
		const disposeRelease = Promise.withResolvers<void>();
		const target = {
			sessionKey: "test/model",
			createSession: async (tool: AgentTool) => {
				creates++;
				return session(tool, async () => disposeRelease.promise);
			},
		};
		await lane.run("first", channel(), target);
		const reset = lane.reset();
		await Promise.resolve();
		expect(creates).toBe(1);
		disposeRelease.resolve();
		await reset;
		await lane.run("second", channel(), target);
		expect(creates).toBe(2);
		await lane.dispose();
	});

	it("sums the retained sidecar transcript usage for cold recovery", () => {
		const manager = SessionManager.inMemory("/tmp");
		const usage: Usage = {
			input: 3,
			output: 5,
			cacheRead: 7,
			cacheWrite: 11,
			totalTokens: 26,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "retained" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage,
			stopReason: "stop",
			timestamp: 1,
		} satisfies AssistantMessage;
		const rootId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "root" }], timestamp: 0 });
		manager.appendMessage(message);
		manager.branch(rootId);
		manager.appendMessage({ ...message, timestamp: 2 });
		expect(actUsageFromSessionManager(manager)).toEqual({
			input: 6,
			output: 10,
			cacheRead: 14,
			cacheWrite: 22,
			totalTokens: 52,
			cost: { input: 2, output: 4, cacheRead: 6, cacheWrite: 8, total: 20 },
		});
	});

	it("dispose waits for a private session that is still closing", async () => {
		const lane = new ActLane();
		const release = Promise.withResolvers<void>();
		await lane.run("first", channel(), {
			sessionKey: "test/model",
			createSession: async tool => session(tool, async () => release.promise),
		});
		const disposing = lane.dispose();
		let settled = false;
		void disposing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release.resolve();
		await disposing;
		expect(settled).toBe(true);
	});
});

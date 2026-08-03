import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import {
	Agent,
	type AgentMessage,
	type CompactionSummaryMessage,
	countTokens,
	getTokenizerMode,
} from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { calculateContextTokens, estimateTokens, resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { estimateToolSchemaTokens } from "@oh-my-pi/pi-coding-agent/modes/utils/context-usage";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const CONTEXT_WINDOW = 372_000;
const CACHE_READ_TOKENS = 371_200;
const INPUT_TOKENS = 200;
const OUTPUT_TOKENS = 150;

// Threshold-metadata fixtures. The three windows are deliberately distinct so an
// 80% threshold maps each to its own `profile.t` (160k / 320k / 800k) and the
// recorded value alone identifies which model it was derived from.
const ACTIVE_ADVISOR_CONTEXT_WINDOW = 200_000;
const PROMOTED_ADVISOR_CONTEXT_WINDOW = 400_000;
const SUMMARIZER_CONTEXT_WINDOW = 1_000_000;

interface MaintenanceHarness {
	advisor: Agent;
	advisorMock: MockModel;
	modelRegistry: ModelRegistry;
	settings: Settings;
}

interface AdvisorCompactionSummaryFixture extends CompactionSummaryMessage {
	advisorUsageAnchorStartIndex?: number;
}

describe("AgentSession advisor context maintenance", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-context-maintenance-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createHarness(contextPromotionTarget?: string, contextPromotionEnabled = false): MaintenanceHarness {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			responses: [{ content: ["advisor reviewed current update"] }],
		});
		Object.assign(advisorMock, { contextPromotionTarget });
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"contextPromotion.enabled": contextPromotionEnabled,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(advisorMock);

		// Keep maintenance on the no-summary recovery branch without blocking the
		// primary prompt's own credential preflight.
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model =>
			model === primaryMock ? "test-key" : undefined,
		);
		return { advisor, advisorMock, modelRegistry, settings };
	}

	function usageAnchor(advisorMock: MockModel, timestamp: number, cost = 0): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "prior advisor output" }],
			api: advisorMock.api,
			provider: advisorMock.provider,
			model: advisorMock.id,
			usage: {
				input: INPUT_TOKENS,
				output: OUTPUT_TOKENS,
				cacheRead: CACHE_READ_TOKENS,
				cacheWrite: 0,
				totalTokens: CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS,
				cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost },
			},
			stopReason: "stop",
			timestamp,
		};
	}

	function compactionSummary(timestamp: number): AdvisorCompactionSummaryFixture {
		return {
			role: "compactionSummary",
			summary: "bounded advisor summary",
			tokensBefore: CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS,
			timestamp,
			// `[summary, retained]` is the compacted array; index 2 is the first
			// position eligible for a newly appended provider-usage anchor.
			advisorUsageAnchorStartIndex: 2,
		};
	}

	function createAdvisorFallbackHarness(options?: { sameProviderNativeEnabled?: boolean }) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "openai",
			responses: [{ content: ["advisor reviewed current update"] }],
		});
		const nativeModel = getBundledModel("openai", "gpt-5");
		const sameProviderBase = getBundledModel("openai", "gpt-5-mini");
		const sameProviderModel =
			sameProviderBase && options?.sameProviderNativeEnabled === false
				? { ...sameProviderBase, remoteCompaction: { ...sameProviderBase.remoteCompaction, enabled: false } }
				: sameProviderBase;
		const crossProviderModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!nativeModel || !sameProviderModel || !crossProviderModel) {
			throw new Error("Expected bundled compaction models");
		}

		authStorage.setRuntimeApiKey(nativeModel.provider, "openai-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"contextPromotion.enabled": false,
		});
		settings.setModelRole("advisor", `${nativeModel.provider}/${nativeModel.id}`);
		settings.setModelRole("smol", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		settings.setModelRole("slow", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		advisor.setModel(nativeModel);
		const apiKeySpy = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([nativeModel, sameProviderModel, crossProviderModel]);
		advisor.state.messages.push(
			usageAnchor(advisorMock, Date.now() - 2_000),
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		return { advisor, apiKeySpy, crossProviderModel, nativeModel, sameProviderModel, settings };
	}

	/**
	 * Advisor whose own window is far smaller than the largest-context fallback
	 * `resolveCompactionModelCandidates` appends, so the threshold that arms
	 * compaction and the summarizing candidate's threshold cannot be confused.
	 * Passing `promotionContextWindow` additionally arms context promotion onto a
	 * middle window, which re-arms the gate before compaction runs.
	 */
	function createAdvisorThresholdMetadataHarness(promotionContextWindow?: number) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			id: "advisor-active",
			provider: "anthropic",
			contextWindow: ACTIVE_ADVISOR_CONTEXT_WINDOW,
			responses: [{ content: ["advisor reviewed current update"] }],
		});
		// Never the active advisor model: it only summarizes, so its window gates
		// nothing and must not reach `profile.t`.
		const summarizerMock = createMockModel({
			id: "advisor-compaction-summarizer",
			provider: "anthropic",
			contextWindow: SUMMARIZER_CONTEXT_WINDOW,
			responses: [{ content: ["summarizer summary"] }],
		});
		const promotionMock =
			promotionContextWindow === undefined
				? undefined
				: createMockModel({
						id: "advisor-promotion-target",
						provider: "anthropic",
						contextWindow: promotionContextWindow,
						responses: [{ content: ["promoted advisor output"] }],
					});
		if (promotionMock) {
			Object.assign(advisorMock, { contextPromotionTarget: `${promotionMock.provider}/${promotionMock.id}` });
		}

		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			// Percentage thresholds scale with the window, unlike a fixed token count
			// that would collapse to the same value for every candidate.
			"compaction.thresholdTokens": -1,
			"compaction.thresholdPercent": 80,
			"contextPromotion.enabled": promotionMock !== undefined,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");
		advisor.setModel(advisorMock);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue(
			promotionMock ? [advisorMock, promotionMock, summarizerMock] : [advisorMock, summarizerMock],
		);
		// Two accumulated turns so compaction has older history to summarize, and
		// enough provider usage (371,550 tokens) to clear every threshold below.
		advisor.state.messages.push(
			usageAnchor(advisorMock, Date.now() - 2_000),
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		return { advisor, advisorMock, promotionMock, settings, summarizerMock };
	}

	/** The `profile` block a summarization request carries in `metadata.user_id`. */
	function compactionProfile(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
		const userId = metadata?.user_id;
		if (typeof userId !== "string") throw new Error("Expected advisor compaction metadata.user_id");
		const { profile } = JSON.parse(userId) as { profile?: Record<string, unknown> };
		if (!profile) throw new Error("Expected advisor compaction metadata profile");
		return profile;
	}

	/** Fails every candidate but the summarizer, forcing the fallback to run. */
	function summarizeOnFallback(activeAdvisorModelId: string) {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.id === activeAdvisorModelId) {
				throw new Error("advisor-model summarization unavailable");
			}
			return {
				summary: "summarizer summary",
				shortSummary: "summarizer",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});
	}

	it("maintains a 371,200-token cached advisor context before the 372,000-token window", async () => {
		const { advisor, advisorMock, settings } = createHarness();
		const anchor = usageAnchor(advisorMock, Date.now() - 1_000, 0.5);
		advisor.emitExternalEvent({ type: "message_end", message: anchor });
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);

		await session.prompt("small current update");

		expect(advisorMock.calls).toHaveLength(1);
		const advisorCall = advisorMock.calls[0];
		const update = advisorCall.context.messages.find(message => message.role === "user");
		if (!update) throw new Error("Expected the advisor's incremental update");
		const threshold = resolveThresholdTokens(CONTEXT_WINDOW, settings.getGroup("compaction"));
		const providerAndUpdateTokens = calculateContextTokens(anchor.usage) + estimateTokens(update as AgentMessage);
		expect(calculateContextTokens(anchor.usage)).toBe(CACHE_READ_TOKENS + INPUT_TOKENS + OUTPUT_TOKENS);
		expect(providerAndUpdateTokens).toBeGreaterThan(threshold);

		// Provider usage triggers maintenance, but recovery sends only the bounded
		// current update into the reset advisor context.
		expect(JSON.stringify(advisorCall.context.messages)).toContain("small current update");
		expect(JSON.stringify(advisor.state.messages)).not.toContain("prior advisor output");
		expect(session.getAdvisorCost()).toBeCloseTo(0.5, 8);
	});

	it("ignores late context-promotion credentials after a session transition", async () => {
		const promotion = createMockModel({
			id: "advisor-promotion-target",
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW + 1,
		});
		const { advisor, advisorMock, modelRegistry } = createHarness(`${promotion.provider}/${promotion.id}`, true);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisor.state.model, promotion]);
		const credentialStarted = Promise.withResolvers<void>();
		const releaseCredential = Promise.withResolvers<void>();
		const credentialReturned = Promise.withResolvers<void>();
		let credentialSignal: AbortSignal | undefined;
		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, _sessionId, options) => {
			if (model === promotion) {
				credentialSignal = options?.signal;
				credentialStarted.resolve();
				await releaseCredential.promise;
				credentialReturned.resolve();
			}
			return "test-key";
		});
		advisor.emitExternalEvent({
			type: "message_end",
			message: usageAnchor(advisorMock, Date.now() - 1_000),
		});

		const prompt = session.prompt("trigger advisor context promotion");
		await credentialStarted.promise;
		await session.newSession();
		releaseCredential.resolve();
		await credentialReturned.promise;
		await prompt;
		expect(credentialSignal?.aborted).toBe(true);
		expect(session.getAdvisorAgent()?.state.model).toBe(advisorMock);
	});

	it("includes advisor system prompt and tool schemas in the local maintenance floor", async () => {
		const { advisor, advisorMock, settings } = createHarness();
		const seed: AgentMessage = { role: "user", content: "small stored advisor message", timestamp: 1 };
		advisor.state.messages.push(seed);
		const storedTokens = estimateTokens(seed, { excludeEncryptedReasoning: true });
		const fixedPrefixTokens = countTokens(advisor.state.systemPrompt) + estimateToolSchemaTokens(advisor.state.tools);
		const threshold = storedTokens + Math.floor(fixedPrefixTokens / 2);
		settings.set("compaction.thresholdTokens", threshold);

		await session.prompt("tiny local-floor update");

		const advisorCall = advisorMock.calls[0];
		const update = advisorCall.context.messages.find(message => message.role === "user");
		if (!update) throw new Error("Expected the advisor's incremental update");
		const messagesOnlyTokens = storedTokens + estimateTokens(update as AgentMessage);
		expect(messagesOnlyTokens).toBeLessThan(threshold);
		expect(messagesOnlyTokens + fixedPrefixTokens).toBeGreaterThan(threshold);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("small stored advisor message");
	});

	it("ignores retained provider usage that predates the latest advisor compaction", async () => {
		const { advisor, advisorMock } = createHarness();
		const compactedAt = Date.now();
		const summary = compactionSummary(compactedAt);
		const retained = usageAnchor(advisorMock, compactedAt);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		advisor.state.messages.push(summary, retained);

		await session.prompt("post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("retained pre-compaction output");
		expect(sentContext).toContain("post-compaction update");
	});

	it("accepts equal-timestamp usage appended after the explicit compaction boundary", async () => {
		const { advisor, advisorMock } = createHarness();
		const compactedAt = Date.now();
		const summary = compactionSummary(compactedAt);
		const retained = usageAnchor(advisorMock, compactedAt);
		retained.content = [{ type: "text", text: "retained pre-compaction output" }];
		const fresh = usageAnchor(advisorMock, compactedAt);
		fresh.content = [{ type: "text", text: "fresh post-compaction output" }];
		advisor.state.messages.push(summary, retained, fresh);

		await session.prompt("equal-timestamp post-compaction update");

		expect(advisorMock.calls).toHaveLength(1);
		const sentContext = JSON.stringify(advisorMock.calls[0].context.messages);
		expect(sentContext).toContain("equal-timestamp post-compaction update");
		expect(sentContext).not.toContain("retained pre-compaction output");
		expect(sentContext).not.toContain("fresh post-compaction output");
	});

	it("forwards compaction metadata and aborts transitions without fallback or re-prime", async () => {
		// Regression for #6625 review: advisor overflow compaction issues a direct
		// `compact(...)` request that bypasses the advisor `Agent`, so the metadata
		// resolver installed on the agent never runs for it. The direct call must
		// still emit the advisor's `metadata.user_id` session identity.
		// The advisor model is the first compaction candidate; registering the mock
		// API lets the compaction one-shot's `completeSimple` route to it so the
		// summarization request actually reaches the mock (and its recorded calls).
		registerMockApi();
		const compactionStarted = Promise.withResolvers<void>();
		const releaseCompaction = Promise.withResolvers<void>();
		let fallbackCalls = 0;
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: [{ content: ["primary complete"] }],
		});
		const advisorMock = createMockModel({
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			handler: async (context, options) => {
				if (!JSON.stringify(context.messages).includes("<conversation>")) {
					return { content: ["advisor reviewed current update"] };
				}
				compactionStarted.resolve();
				const signal = options?.signal;
				if (!signal) throw new Error("Expected compaction abort signal");
				const compactionAborted = Promise.withResolvers<void>();
				signal.addEventListener("abort", () => compactionAborted.resolve(), { once: true });
				await Promise.race([releaseCompaction.promise, compactionAborted.promise]);
				signal.throwIfAborted();
				return { content: ["bounded advisor summary"] };
			},
		});
		const fallbackMock = createMockModel({
			id: "advisor-compaction-fallback",
			provider: "anthropic",
			contextWindow: CONTEXT_WINDOW,
			handler: () => {
				fallbackCalls++;
				return { content: ["unexpected fallback"] };
			},
		});
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"contextPromotion.enabled": false,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor?.sessionId) throw new Error("Expected advisor agent with a provider session id");
		advisor.setModel(advisorMock);
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([advisorMock, fallbackMock]);
		// Unlike the recovery-branch harness, the advisor holds usable credentials
		// so maintenance runs the LLM summarization compaction path.
		const getApiKey = vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");

		// Two accumulated turns so compaction has older history to summarize while
		// retaining the most recent one (a single message would be fully retained,
		// making compaction a no-op).
		advisor.state.messages.push(
			usageAnchor(advisorMock, Date.now() - 2_000),
			usageAnchor(advisorMock, Date.now() - 1_000),
		);
		const previousAdvisorMessages = [...advisor.state.messages];

		const prompt = session.prompt("small current update");
		await compactionStarted.promise;
		const failure = new Error("new session failed");
		vi.spyOn(session.sessionManager, "newSession").mockRejectedValue(failure);
		const transition = session.newSession();
		try {
			await expect(transition).rejects.toThrow(failure);
			expect(fallbackCalls).toBe(0);
			expect(advisor.state.messages).toEqual(previousAdvisorMessages);
			expect(getApiKey).toHaveBeenCalledWith(advisorMock, advisor.sessionId, {
				signal: expect.any(AbortSignal),
			});
		} finally {
			releaseCompaction.resolve();
			await prompt;
		}

		// A summarization compaction one-shot actually ran (its prompt wraps the
		// conversation in <conversation> tags).
		const compactionCalls = advisorMock.calls.filter(call =>
			JSON.stringify(call.context.messages).includes("<conversation>"),
		);
		expect(compactionCalls.length).toBeGreaterThan(0);
		expect(compactionCalls.every(call => call.options?.signal instanceof AbortSignal)).toBe(true);

		// Every advisor request — the compaction one-shot and the advisor turn —
		// carries the advisor's own provider session id via metadata.user_id.
		for (const call of advisorMock.calls) {
			const userId = call.options?.metadata?.user_id;
			if (typeof userId !== "string") throw new Error("Expected advisor metadata.user_id");
			expect((JSON.parse(userId) as { session_id?: string }).session_id).toBe(advisor.sessionId);
		}
	});

	it("continues same-provider advisor candidates but stops before crossing providers on non-auth failure", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "cross-provider summary",
				shortSummary: "cross-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("prior advisor output");
	});

	it("applies a successful same-provider native advisor fallback", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "same-provider native summary",
					shortSummary: "same-provider native",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 42,
				};
			}
			throw new Error(
				`Unexpected cross-provider compaction ${crossProviderModel.provider}/${crossProviderModel.id}`,
			);
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("same-provider native summary");
	});

	it("skips unauthenticated advisor candidates before enforcing the native boundary", async () => {
		const { advisor, apiKeySpy, crossProviderModel, nativeModel, sameProviderModel, settings } =
			createAdvisorFallbackHarness();
		settings.setModelRole("smol", `${crossProviderModel.provider}/${crossProviderModel.id}`);
		settings.setModelRole("slow", `${sameProviderModel.provider}/${sameProviderModel.id}`);
		apiKeySpy.mockImplementation(async model =>
			model.provider === crossProviderModel.provider && model.id === crossProviderModel.id ? undefined : "test-key",
		);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			if (model.provider === sameProviderModel.provider && model.id === sameProviderModel.id) {
				return {
					summary: "authenticated same-provider advisor summary",
					shortSummary: "authenticated same-provider advisor",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: 42,
				};
			}
			throw new Error(`Unexpected advisor compaction model ${model.provider}/${model.id}`);
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("authenticated same-provider advisor summary");
	});

	it("stops before a same-provider advisor candidate with native compaction disabled", async () => {
		const { advisor, nativeModel, sameProviderModel } = createAdvisorFallbackHarness({
			sameProviderNativeEnabled: false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider && model.id === nativeModel.id) {
				throw new compactionModule.NativeCompactionError(new Error("V2 native compaction transport failed"));
			}
			return {
				summary: "generic same-provider summary",
				shortSummary: "generic same-provider",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).not.toContain("generic same-provider summary");
		expect(sameProviderModel.remoteCompaction?.enabled).toBe(false);
	});

	it("allows advisor compaction to cross providers after auth-classified native failures", async () => {
		const { advisor, crossProviderModel, nativeModel, sameProviderModel } = createAdvisorFallbackHarness();
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => {
			if (model.provider === nativeModel.provider || model.provider === sameProviderModel.provider) {
				throw new compactionModule.NativeCompactionError(
					Object.assign(new Error("native compaction authentication failed"), { status: 401 }),
				);
			}
			if (model.provider !== crossProviderModel.provider || model.id !== crossProviderModel.id) {
				throw new Error(`Unexpected compaction model ${model.provider}/${model.id}`);
			}
			return {
				summary: "authenticated fallback summary",
				shortSummary: "authenticated fallback",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: 42,
			};
		});

		await session.prompt("small current update");

		expect(compactSpy.mock.calls.map(([, model]) => `${model.provider}/${model.id}`)).toEqual([
			`${nativeModel.provider}/${nativeModel.id}`,
			`${sameProviderModel.provider}/${sameProviderModel.id}`,
			`${crossProviderModel.provider}/${crossProviderModel.id}`,
		]);
		expect(JSON.stringify(advisor.state.messages)).toContain("authenticated fallback summary");
	});

	it("records the active advisor's threshold when a larger fallback model summarizes", async () => {
		// `profile.t` must name the threshold that armed compaction. `shouldCompact`
		// gates on the active advisor's window, but the summarization candidate is
		// resolved separately and is often the largest-context model available.
		// Deriving `t` from that candidate reports a threshold that never fired.
		const { advisor, advisorMock, settings, summarizerMock } = createAdvisorThresholdMetadataHarness();
		const compactSpy = summarizeOnFallback(advisorMock.id);

		await session.prompt("small current update");

		const compactionSettings = settings.getGroup("compaction");
		const activeThreshold = resolveThresholdTokens(ACTIVE_ADVISOR_CONTEXT_WINDOW, compactionSettings);
		const summarizerThreshold = resolveThresholdTokens(SUMMARIZER_CONTEXT_WINDOW, compactionSettings);

		// The advisor model was tried first and the 1M fallback actually summarized,
		// so the two thresholds are genuinely in play on this one run.
		expect(compactSpy.mock.calls.map(([, model]) => model.id)).toEqual([advisorMock.id, summarizerMock.id]);
		expect(activeThreshold).toBe(160_000);
		expect(summarizerThreshold).toBe(800_000);
		expect(compactSpy.mock.calls.length).toBeGreaterThan(0);
		// Pinned with toBe on the exact value: every request reports the advisor's
		// own gate, including the one issued to the 1M candidate.
		for (const [, , , , , options] of compactSpy.mock.calls) {
			const profile = compactionProfile(options?.metadata);
			expect(profile.t).toBe(activeThreshold);
			expect(profile).toEqual({ t: activeThreshold, s: "context-full", z: getTokenizerMode() });
		}
		expect(JSON.stringify(advisor.state.messages)).toContain("summarizer summary");
	});

	it("records the promoted advisor's threshold when promotion still requires compaction", async () => {
		// Promotion re-runs the gate against the promoted model, so once compaction
		// proceeds anyway it is the promoted window's threshold that fired — not the
		// pre-promotion advisor's, and not the summarizing candidate's.
		const { advisor, advisorMock, promotionMock, settings, summarizerMock } = createAdvisorThresholdMetadataHarness(
			PROMOTED_ADVISOR_CONTEXT_WINDOW,
		);
		const compactSpy = summarizeOnFallback(advisorMock.id);

		await session.prompt("small current update");

		const compactionSettings = settings.getGroup("compaction");
		const prePromotionThreshold = resolveThresholdTokens(ACTIVE_ADVISOR_CONTEXT_WINDOW, compactionSettings);
		const promotedThreshold = resolveThresholdTokens(PROMOTED_ADVISOR_CONTEXT_WINDOW, compactionSettings);
		const summarizerThreshold = resolveThresholdTokens(SUMMARIZER_CONTEXT_WINDOW, compactionSettings);

		// Promotion landed and compaction still ran: 371,550 accumulated tokens clear
		// the promoted 320k threshold as well as the pre-promotion 160k one.
		expect(promotionMock).toBeDefined();
		expect(advisor.state.model.id).toBe(promotionMock!.id);
		expect(compactSpy.mock.calls.map(([, model]) => model.id)).toEqual([advisorMock.id, summarizerMock.id]);
		expect(promotedThreshold).toBe(320_000);
		// All three candidate windows yield distinct thresholds, so `t` is unambiguous.
		expect(new Set([prePromotionThreshold, promotedThreshold, summarizerThreshold]).size).toBe(3);
		for (const [, , , , , options] of compactSpy.mock.calls) {
			const profile = compactionProfile(options?.metadata);
			expect(profile.t).toBe(promotedThreshold);
			expect(profile).toEqual({ t: promotedThreshold, s: "context-full", z: getTokenizerMode() });
		}
		expect(JSON.stringify(advisor.state.messages)).toContain("summarizer summary");
	});
});

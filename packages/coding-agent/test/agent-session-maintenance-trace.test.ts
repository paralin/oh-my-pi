import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, Message, Model, ToolCall } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type CompactionStrategy = "context-full" | "handoff" | "snapcompact";

type Harness = {
	session: AgentSession;
	sessionManager: SessionManager;
	events: AgentSessionEvent[];
};

describe("AgentSession maintenance trace events", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let anthropicModel: Model;
	let sessions: AgentSession[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-maintenance-trace-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("aimlapi", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model");
		anthropicModel = model;
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) {
			await session.dispose();
		}
		authStorage.close();
		await tempDir.remove();
		vi.restoreAllMocks();
	});

	function seedMessages(model: Model): { user: Message; assistant: AssistantMessage } {
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		};
		return { user, assistant };
	}

	function createHarness(
		options: {
			strategy?: CompactionStrategy;
			model?: Model;
			extensionRunner?: ExtensionRunner;
			sideStreamFn?: StreamFn;
			stubCompaction?: boolean;
		} = {},
	): Harness {
		const model = options.model ?? anthropicModel;
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { user, assistant } = seedMessages(model);
		sessionManager.appendMessage(user);
		const firstKeptEntryId = sessionManager.appendMessage(assistant);
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [user, assistant],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": options.strategy ?? "context-full",
				"contextPromotion.enabled": false,
			}),
			modelRegistry,
			extensionRunner: options.extensionRunner,
			sideStreamFn: options.sideStreamFn,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		sessions.push(session);
		if (options.stubCompaction !== false) stubCompaction(options.strategy ?? "context-full", firstKeptEntryId);
		return { session, sessionManager, events };
	}

	function stubCompaction(strategy: CompactionStrategy, firstKeptEntryId: string): void {
		const fixedPreparation: compactionModule.CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...compactionModule.DEFAULT_COMPACTION_SETTINGS, strategy },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);
		vi.spyOn(compactionModule, "compact").mockResolvedValue({
			summary: "trace summary",
			shortSummary: undefined,
			firstKeptEntryId,
			tokensBefore: 100,
			details: {},
		});
	}

	function maintenanceStreamFactory(outputs: string[], options: { includeNonTextFrames?: boolean } = {}): StreamFn {
		let callIndex = 0;
		return requestModel => {
			const stream = new AssistantMessageEventStream();
			const text = outputs[callIndex++] ?? "";
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text }],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "stop",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				if (options.includeNonTextFrames) {
					const toolCall: ToolCall = {
						type: "toolCall",
						id: "tool-raw",
						name: "read",
						arguments: { path: "secret.txt" },
					};
					stream.push({ type: "thinking_delta", contentIndex: 0, delta: "hidden reasoning", partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 1,
						delta: JSON.stringify(toolCall),
						partial: message,
					});
				}
				stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
	}

	function maintenanceFailureStreamFactory(delta: string): StreamFn {
		return requestModel => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "text", text: delta },
						{ type: "thinking", thinking: "hidden failure reasoning" },
					],
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
					stopReason: "error",
					errorMessage: "provider frame: internal failure",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				};
				stream.push({
					type: "thinking_delta",
					contentIndex: 1,
					delta: "hidden failure reasoning",
					partial: message,
				});
				stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
				stream.push({ type: "error", reason: "error", error: message });
			});
			return stream;
		};
	}

	it("emits a UI-only trace around the legacy auto-compaction events", async () => {
		const { session, events } = createHarness({ strategy: "context-full" });

		await session.runIdleCompaction();

		const traceStartIndex = events.findIndex(event => event.type === "maintenance_trace_start");
		const legacyStartIndex = events.findIndex(event => event.type === "auto_compaction_start");
		expect(traceStartIndex).toBeGreaterThanOrEqual(0);
		expect(traceStartIndex).toBeLessThan(legacyStartIndex);
		expect(events[legacyStartIndex]).toEqual({
			type: "auto_compaction_start",
			reason: "idle",
			action: "context-full",
		});

		const traceStart = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_start" }> =>
				event.type === "maintenance_trace_start",
		);
		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);
		expect(traceStart).toMatchObject({
			type: "maintenance_trace_start",
			phase: "start",
			reason: "idle",
			action: "context-full",
			visibility: "ui-only",
			fallbackCause: "idle",
		});
		expect(traceEnd).toMatchObject({
			type: "maintenance_trace_end",
			phase: "terminal",
			traceId: traceStart?.traceId,
			reason: "idle",
			action: "context-full",
			visibility: "ui-only",
			fallbackCause: "idle",
			terminalResult: "done",
			willRetry: false,
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "auto_compaction_end",
				action: "context-full",
				aborted: false,
				willRetry: false,
			}),
		);
	});

	it("correlates handoff no-document fallback through the same trace", async () => {
		const { session, events } = createHarness({ strategy: "handoff" });
		vi.spyOn(compactionModule, "generateHandoffFromContext").mockResolvedValue("");

		await session.runIdleCompaction();

		const traceStart = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_start" }> =>
				event.type === "maintenance_trace_start",
		);
		const tracePhase = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_phase" }> =>
				event.type === "maintenance_trace_phase",
		);
		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);

		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "idle", action: "handoff" });
		expect(events).toContainEqual(
			expect.objectContaining({ type: "auto_compaction_end", action: "context-full", aborted: false }),
		);
		expect(traceStart).toMatchObject({ action: "handoff", reason: "idle", visibility: "ui-only" });
		expect(tracePhase).toMatchObject({
			type: "maintenance_trace_phase",
			traceId: traceStart?.traceId,
			phase: "action-fallback",
			action: "context-full",
			fallbackCause: "no-document-handoff-fallback",
		});
		expect(traceEnd).toMatchObject({
			traceId: traceStart?.traceId,
			action: "context-full",
			fallbackCause: "no-document-handoff-fallback",
			terminalResult: "done",
		});
	});

	it("marks snapcompact downgrades as a fallback cause without changing the selected action", async () => {
		const textOnlyModel = getBundledModel("aimlapi", "alibaba/qwen3-coder-480b-a35b-instruct");
		if (!textOnlyModel) throw new Error("Expected bundled text-only model");
		const { session, events } = createHarness({ strategy: "snapcompact", model: textOnlyModel });

		await session.runIdleCompaction();

		expect(events).toContainEqual({ type: "auto_compaction_start", reason: "idle", action: "context-full" });
		const traceStart = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_start" }> =>
				event.type === "maintenance_trace_start",
		);
		expect(traceStart).toMatchObject({
			action: "context-full",
			reason: "idle",
			fallbackCause: "snapcompact-fallback",
			visibility: "ui-only",
		});
	});

	it("maps extension-cancelled auto-compaction to a cancelled trace terminal", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_compact"),
			emit: vi.fn(async (event: { type: string }) =>
				event.type === "session_before_compact" ? { cancel: true } : undefined,
			),
		} as unknown as ExtensionRunner;
		const { session, events } = createHarness({ strategy: "context-full", extensionRunner });

		await session.runIdleCompaction();

		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "auto_compaction_end", action: "context-full", aborted: true }),
		);
		expect(traceEnd).toMatchObject({ terminalResult: "cancelled", action: "context-full", willRetry: false });
	});

	it("maps benign no-model skips to a skipped trace terminal", async () => {
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { user, assistant } = seedMessages(anthropicModel);
		sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant);
		const agent = new Agent({
			initialState: {
				model: undefined,
				systemPrompt: ["Test"],
				tools: [],
				messages: [user, assistant],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
				"compaction.strategy": "context-full",
			}),
			modelRegistry,
		});
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		sessions.push(session);

		await session.runIdleCompaction();

		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);
		expect(events).toContainEqual(
			expect.objectContaining({ type: "auto_compaction_end", action: "context-full", skipped: true }),
		);
		expect(traceEnd).toMatchObject({ action: "context-full", terminalResult: "skipped", willRetry: false });
	});

	it("emits assistant-visible context-full summary deltas without changing the compaction result", async () => {
		const { session, sessionManager, events } = createHarness({
			strategy: "context-full",
			sideStreamFn: maintenanceStreamFactory(["Visible context summary", "Visible short summary"], {
				includeNonTextFrames: true,
			}),
			stubCompaction: false,
		});
		session.settings.set("compaction.remoteEnabled", false);
		session.settings.set("compaction.keepRecentTokens", 1);

		await session.runIdleCompaction();

		const traceStart = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_start" }> =>
				event.type === "maintenance_trace_start",
		);
		const deltas = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_delta" }> =>
				event.type === "maintenance_trace_delta",
		);
		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);
		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");

		expect(deltas.map(event => event.delta)).toEqual(["Visible context summary", "Visible short summary"]);
		expect(deltas.every(event => event.traceId === traceStart?.traceId)).toBe(true);
		expect(deltas.every(event => event.visibility === "ui-only" && event.content === "assistant_text")).toBe(true);
		expect(deltas.map(event => event.delta).join("\n")).not.toContain("hidden reasoning");
		expect(deltas.map(event => event.delta).join("\n")).not.toContain("tool-raw");
		expect(compactionEntry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("Visible context summary"),
			shortSummary: "Visible short summary",
		});
		expect(session.messages[0]).toMatchObject({
			role: "compactionSummary",
			summary: expect.stringContaining("Visible context summary"),
		});
		expect(traceEnd).toMatchObject({
			traceId: traceStart?.traceId,
			action: "context-full",
			terminalResult: "done",
		});
	});

	it("keeps context-full compaction results when a trace-delta observer rejects", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "maintenance_trace_delta"),
			emit: vi.fn(async (event: { type: string }) => {
				if (event.type === "maintenance_trace_delta") throw new Error("trace delta observer failed");
			}),
		} as unknown as ExtensionRunner;
		const { session, sessionManager, events } = createHarness({
			strategy: "context-full",
			extensionRunner,
			sideStreamFn: maintenanceStreamFactory(["Visible context summary", "Visible short summary"]),
			stubCompaction: false,
		});
		session.settings.set("compaction.remoteEnabled", false);
		session.settings.set("compaction.keepRecentTokens", 1);

		await session.runIdleCompaction();

		const compactionEntry = sessionManager.getEntries().find(entry => entry.type === "compaction");
		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);

		expect(extensionRunner.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "maintenance_trace_delta",
				content: "assistant_text",
				delta: "Visible context summary",
			}),
		);
		expect(compactionEntry).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("Visible context summary"),
			shortSummary: "Visible short summary",
		});
		expect(traceEnd).toMatchObject({ action: "context-full", terminalResult: "done" });
	});

	it("keeps streamed deltas observational when context-full summary fails", async () => {
		const { session, sessionManager, events } = createHarness({
			strategy: "context-full",
			sideStreamFn: maintenanceFailureStreamFactory("Visible before failure"),
			stubCompaction: false,
		});
		session.settings.set("compaction.remoteEnabled", false);
		session.settings.set("compaction.keepRecentTokens", 1);
		session.settings.set("retry.enabled", false);

		await session.runIdleCompaction();

		const traceStart = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_start" }> =>
				event.type === "maintenance_trace_start",
		);
		const deltas = events.filter(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_delta" }> =>
				event.type === "maintenance_trace_delta",
		);
		const traceEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "maintenance_trace_end" }> =>
				event.type === "maintenance_trace_end",
		);
		const legacyEnd = events.find(
			(event): event is Extract<AgentSessionEvent, { type: "auto_compaction_end" }> =>
				event.type === "auto_compaction_end",
		);

		expect(deltas.length).toBeGreaterThanOrEqual(1);
		expect(deltas.every(event => event.delta === "Visible before failure")).toBe(true);
		expect(deltas.every(event => event.traceId === traceStart?.traceId)).toBe(true);
		expect(deltas.map(event => event.delta).join("\n")).not.toContain("hidden failure reasoning");
		expect(deltas.map(event => event.delta).join("\n")).not.toContain("provider frame");
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		expect(legacyEnd).toMatchObject({
			type: "auto_compaction_end",
			action: "context-full",
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringContaining("Auto-compaction failed"),
		});
		expect(traceEnd).toMatchObject({
			traceId: traceStart?.traceId,
			action: "context-full",
			terminalResult: "failed",
			errorMessage: legacyEnd?.errorMessage,
		});
	});
});

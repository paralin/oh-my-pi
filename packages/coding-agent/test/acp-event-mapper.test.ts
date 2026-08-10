import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentSideConnection, SessionNotification } from "@oh-my-pi/pi-utils/acp";

const arkSessionNotification = type({
	sessionId: "string",
	update: {
		sessionUpdate:
			"'agent_thought_chunk' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update' | 'plan' | 'plan_update' | 'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update' | 'usage_update'",
	},
});

import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type {
	IpythonCompletedCellPresentation,
	IpythonLiveCellPresentation,
} from "@oh-my-pi/pi-coding-agent/ipython/projection";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import {
	buildToolCallStartUpdate,
	mapAgentSessionEventToAcpSessionUpdates,
	mapHistoricalAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { expectAcpStructure, expectAcpStructureRejects } from "./helpers/acp-schema";

function makeAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-20250514",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function getChunkMessageId(event: { update: object }): string | undefined {
	const update = event.update as { messageId?: string | null };
	return typeof update.messageId === "string" ? update.messageId : undefined;
}

function expectAcpNotifications(updates: SessionNotification[]): void {
	for (const update of updates) {
		expectAcpStructure(arkSessionNotification, update);
	}
}

const TEST_MODEL: Model = buildModel({
	id: "claude-sonnet-4-20250514",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

class ReplayTestSession {
	sessionManager: SessionManager;
	sessionId: string;
	model: Model | undefined = TEST_MODEL;
	thinkingLevel: string | undefined;
	customCommands: [] = [];
	skills: [] = [];
	extensionRunner = undefined;
	settings = { get: (_key: string) => false };

	constructor(cwd: string, sessionDir?: string) {
		this.sessionManager = SessionManager.create(cwd, sessionDir);
		this.sessionId = this.sessionManager.getSessionId();
	}

	getAvailableModels(): Model[] {
		return [TEST_MODEL];
	}

	getAvailableThinkingLevels(): ReadonlyArray<string> {
		return [];
	}

	setClientBridge(_bridge: unknown): void {}

	subscribe(_listener: (event: AgentSessionEvent) => void): () => void {
		return () => {};
	}

	async refreshMCPInstructions(_tools: unknown): Promise<void> {}
}

describe("ACP event mapper", () => {
	it("attaches a stable messageId to live assistant chunks", () => {
		const assistantMessage = makeAssistantMessage("chunk");
		const getMessageId = (message: unknown): string | undefined =>
			message === assistantMessage ? "a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a" : undefined;

		const textUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "chunk" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);
		const thoughtUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "thinking_delta", delta: "plan" },
			} as AgentSessionEvent,
			"session-1",
			{ getMessageId },
		);

		expect(textUpdates).toHaveLength(1);
		expect(thoughtUpdates).toHaveLength(1);
		expectAcpNotifications([...textUpdates, ...thoughtUpdates]);
		expect(textUpdates[0] ? getChunkMessageId(textUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
		expect(thoughtUpdates[0] ? getChunkMessageId(thoughtUpdates[0]) : undefined).toBe(
			"a80f1ff7-4f0a-4e6b-9f09-c94857b62a4a",
		);
	});

	it("emits final assistant text when no text deltas were observed", () => {
		const assistantMessage = makeAssistantMessage("final response");
		const progress = { textEmitted: false, thoughtEmitted: false };

		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			{ getMessageProgress: message => (message === assistantMessage ? progress : undefined) },
		);

		expect(updates).toEqual([
			{
				sessionId: "session-1",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "final response" },
					messageId: undefined,
				},
			},
		]);
		expectAcpNotifications(updates);
		expect(progress.textEmitted).toBe(true);
	});

	it("does not duplicate final assistant text after streaming deltas", () => {
		const assistantMessage = makeAssistantMessage("streamed response");
		const progress = { textEmitted: false, thoughtEmitted: false };
		const options = {
			getMessageProgress: (message: unknown) => (message === assistantMessage ? progress : undefined),
		};

		const deltaUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
			} as AgentSessionEvent,
			"session-1",
			options,
		);
		const doneUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "message_end",
				message: assistantMessage,
			} as AgentSessionEvent,
			"session-1",
			options,
		);

		expect(deltaUpdates).toHaveLength(1);
		expectAcpNotifications(deltaUpdates);
		expect(doneUpdates).toEqual([]);
	});

	it("does not map legacy named-tool events on the live ACP stream", () => {
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "legacy-start",
				toolName: "read",
				args: { path: "README.md" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "legacy-update",
				toolName: "bash",
				args: { command: "echo hidden" },
				partialResult: { content: [{ type: "text", text: "hidden" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "legacy-end",
				toolName: "edit",
				isError: false,
				result: { content: [{ type: "text", text: "hidden" }] },
			},
		];

		expect(events.flatMap(event => mapAgentSessionEventToAcpSessionUpdates(event, "session-1"))).toEqual([]);
	});

	it("preserves command text when a new command tool is started", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start",
				toolName: "bash",
				args: { command: "npm run check" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ npm run check" } });
	});

	it("keeps internal Hub traffic off the ACP session stream", () => {
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				args: { op: "send", to: "Scout", message: "Private coordination" },
				partialResult: { content: [{ type: "text", text: "delivering" }] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-send",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "delivered" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapHistoricalAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "send", to: "Scout", message: "Private coordination" }),
			}),
		);

		expect(updates).toEqual([]);
	});

	it("keeps Hub process control visible over ACP", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-process-send",
				toolName: "hub",
				args: { op: "send", name: "server", text: "ping" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update).toEqual(
			expect.objectContaining({
				sessionUpdate: "tool_call",
				rawInput: { op: "send", name: "server", text: "ping" },
			}),
		);
	});

	it("keeps background job-wait results visible over ACP", () => {
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				args: { op: "wait", ids: ["bash_a1b2c3"] },
			},
			{
				type: "tool_execution_end",
				toolCallId: "tc-hub-job-wait",
				toolName: "hub",
				isError: false,
				result: { content: [{ type: "text", text: "job output" }] },
			},
		] satisfies AgentSessionEvent[];

		const updates = events.flatMap(event =>
			mapHistoricalAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				getToolArgs: () => ({ op: "wait", ids: ["bash_a1b2c3"] }),
			}),
		);

		expect(updates.map(update => update.update.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
	});

	it("keeps a bare Hub wait visible so job deliveries reach ACP", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-bare-wait",
				toolName: "hub",
				args: { op: "wait" },
			},
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expect(updates[0]?.update.sessionUpdate).toBe("tool_call");
	});

	it("hides a peer-scoped Hub wait from ACP", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-hub-peer-wait",
				toolName: "hub",
				args: { op: "wait", from: "Scout" },
			},
			"session-1",
		);

		expect(updates).toEqual([]);
	});

	it("uses command text for a new command tool even when intent is generic", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-command-start-generic-intent",
				toolName: "bash",
				args: { command: "echo hi" },
				intent: "Running command",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			title: string;
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};
		expect(update.title).toBe("$ echo hi");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ echo hi" } });
	});

	it("emits a diff ToolCallContent for each per-file edit result", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						diff: "--- a/foo\n+++ b/foo\n",
						perFileResults: [
							{ path: "foo.ts", diff: "...", oldText: "before\n", newText: "after\n" },
							{ path: "bar.ts", diff: "...", oldText: undefined, newText: "created\n" },
							{ path: "skipped.ts", diff: "", isError: true, errorText: "boom" },
						],
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		const diffBlocks = update.content?.filter(block => block.type === "diff") ?? [];
		expect(diffBlocks).toEqual([
			{ type: "diff", path: "foo.ts", oldText: "before\n", newText: "after\n" },
			{ type: "diff", path: "bar.ts", oldText: null, newText: "created\n" },
		]);
		expect(update.locations).toEqual([{ path: "foo.ts" }, { path: "bar.ts" }, { path: "skipped.ts" }]);
	});

	it("emits a diff ToolCallContent for single-file edit details", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-single",
				toolName: "edit",
				isError: false,
				result: {
					content: [{ type: "text", text: "applied" }],
					details: {
						path: "single.ts",
						diff: "--- a/single.ts\n+++ b/single.ts\n",
						oldText: "before\n",
						newText: "after\n",
					},
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>;
			locations?: { path: string }[];
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content?.filter(block => block.type === "diff")).toEqual([
			{ type: "diff", path: "single.ts", oldText: "before\n", newText: "after\n" },
		]);
		expect(update.locations).toEqual([{ path: "single.ts" }]);
	});

	it("resolves live image blob refs for ACP content without expanding rawOutput", () => {
		const blobRef = "blob:sha256:77467fcfe2bbdc034e0eabb4778c9d7de521c0d7c3e0d0a62566468e4d7da3a5";
		const resolvedImageData = "resolved-webp-base64";
		const events: AgentSessionEvent[] = [
			{
				type: "tool_execution_update",
				toolCallId: "tc-image-update",
				toolName: "generate_image",
				args: {},
				partialResult: {
					content: [{ type: "image", data: blobRef, mimeType: "image/webp" }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
			{
				type: "tool_execution_end",
				toolCallId: "tc-image-end",
				toolName: "generate_image",
				isError: false,
				result: {
					content: [{ type: "text", text: "Generated image saved." }],
					details: { images: [{ data: blobRef, mimeType: "image/webp" }] },
				},
			} as AgentSessionEvent,
		];

		for (const event of events) {
			const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(event, "session-1", {
				resolveImageData: data => (data === blobRef ? resolvedImageData : data),
			});
			const update = updates[0]!.update as {
				content?: Array<{
					type: string;
					content?: { type: string; data?: string; mimeType?: string; text?: string };
				}>;
				rawOutput?: unknown;
			};
			const images = update.content?.filter(item => item.type === "content" && item.content?.type === "image") ?? [];

			expect(images).toEqual([
				{ type: "content", content: { type: "image", data: resolvedImageData, mimeType: "image/webp" } },
			]);
			expect(JSON.stringify(update.content)).not.toContain("blob:sha256:");
			expect(JSON.stringify(update.rawOutput)).toContain(blobRef);
		}
	});

	it("emits locations on tool_execution_update from args", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "edit",
				args: { path: "src/foo.ts" },
				partialResult: { content: [{ type: "text", text: "in progress" }] },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.locations).toEqual([{ path: "src/foo.ts" }]);
	});

	it("preserves command text when a command tool update replaces content", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-3",
				toolName: "bash",
				args: { command: "npm run check" },
				partialResult: { details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ npm run check" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"details":{"terminalId":"term-1"}}' },
		});
	});

	it("preserves command text when tool update details accompany empty content", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-empty-content",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: { content: [], details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ echo hi" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(update.content).not.toContainEqual({
			type: "content",
			content: { type: "text", text: '{"content":[],"details":{"terminalId":"term-1"}}' },
		});
	});

	it("keeps terminal content alongside readable text", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_update",
				toolCallId: "tc-terminal-update-text",
				toolName: "bash",
				args: { command: "echo hi" },
				partialResult: {
					content: [{ type: "text", text: "running" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "running" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable end text", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-end",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "done" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("preserves command text when a command tool final update replaces content", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-final-command",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "text", text: "done" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
			{
				getToolArgs: toolCallId =>
					toolCallId === "tc-terminal-final-command" ? { command: "npm run check" } : undefined,
			},
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		expect(update.sessionUpdate).toBe("tool_call_update");
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "$ npm run check" } });
		expect(update.content).toContainEqual({ type: "content", content: { type: "text", text: "done" } });
		expect(update.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
	});

	it("keeps terminal content alongside readable error and message fields", () => {
		const errorUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-error",
				toolName: "bash",
				isError: true,
				result: { errorMessage: "command failed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);
		const messageUpdates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-message",
				toolName: "bash",
				isError: false,
				result: { message: "command completed", details: { terminalId: "term-1" } },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(errorUpdates).toHaveLength(1);
		expect(messageUpdates).toHaveLength(1);
		expectAcpNotifications([...errorUpdates, ...messageUpdates]);
		const errorUpdate = errorUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};
		const messageUpdate = messageUpdates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string; content?: { type: string; text?: string } }>;
		};

		expect(errorUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(errorUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command failed" },
		});
		expect(messageUpdate.content).toContainEqual({ type: "terminal", terminalId: "term-1" });
		expect(messageUpdate.content).toContainEqual({
			type: "content",
			content: { type: "text", text: "command completed" },
		});
	});

	it("keeps plain command output visible without terminal details", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-plain-output",
				toolName: "bash",
				isError: false,
				result: "hello from stdout",
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; content?: { type: string; text?: string } }>;
		};

		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "hello from stdout" } }]);
	});

	it("embeds only terminal content from direct terminalId", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-direct-terminal",
				toolName: "bash",
				isError: false,
				result: { terminalId: "term-1" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content).toEqual([{ type: "terminal", terminalId: "term-1" }]);
	});

	it("does not duplicate existing terminal content", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_end",
				toolCallId: "tc-terminal-dedup",
				toolName: "bash",
				isError: false,
				result: {
					content: [{ type: "terminal", terminalId: "term-1" }],
					details: { terminalId: "term-1" },
				},
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			content?: Array<{ type: string; terminalId?: string }>;
		};
		expect(update.content?.filter(item => item.type === "terminal" && item.terminalId === "term-1")).toHaveLength(1);
	});
	it("shows bash commands in visible tool call content", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_bash_1",
				toolName: "bash",
				args: { command: "npm run check", cwd: "/repo" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			toolCallId?: string;
			title?: string;
			kind?: string;
			status?: string;
			rawInput?: unknown;
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.toolCallId).toBe("toolu_bash_1");
		expect(update.title).toBe("$ npm run check");
		expect(update.kind).toBe("execute");
		expect(update.status).toBe("pending");
		expect(update.rawInput).toEqual({ command: "npm run check", cwd: "/repo" });
		expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "$ npm run check" } }]);
	});

	it("maps shell and exec tool starts as execute", () => {
		for (const toolName of ["shell", "exec"] as const) {
			const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_start",
					toolCallId: `toolu_${toolName}_1`,
					toolName,
					args: { command: "echo hi" },
				} as AgentSessionEvent,
				"session-1",
			);

			expect(updates).toHaveLength(1);
			expectAcpNotifications(updates);
			const update = updates[0]!.update as {
				sessionUpdate: string;
				kind?: string;
				content?: unknown;
			};
			expect(update.sessionUpdate).toBe("tool_call");
			expect(update.kind).toBe("execute");
			expect(update.content).toEqual([{ type: "content", content: { type: "text", text: "$ echo hi" } }]);
		}
	});

	it("replays assistant tool_use input through the ACP dispatcher without wrapping", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-acp-replay-contract-"));
		const cwd = path.join(root, "cwd");
		const sessionDir = path.join(root, "sessions");
		const initialSessionDir = path.join(root, "initial-session");
		const updates: SessionNotification[] = [];
		const sessions: ReplayTestSession[] = [];
		const abortController = new AbortController();
		try {
			await fs.promises.mkdir(cwd, { recursive: true });
			const connection = {
				sessionUpdate: async (notification: SessionNotification) => {
					updates.push(notification);
				},
				signal: abortController.signal,
				closed: Promise.resolve(),
			} as unknown as AgentSideConnection;
			const agent = new AcpAgent(
				connection,
				async (sessionCwd: string) => {
					const session = new ReplayTestSession(sessionCwd, sessionDir);
					sessions.push(session);
					return session as unknown as AgentSession;
				},
				new ReplayTestSession(cwd, initialSessionDir) as unknown as AgentSession,
			);
			const created = await agent.newSession({ cwd, mcpServers: [] });
			const session = sessions[0]!;
			session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "toolu_replay_input",
						name: "bash",
						input: { command: "echo hi" },
					},
				],
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-20250514",
				stopReason: "stop",
				timestamp: Date.now(),
			} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "toolu_replay_input",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				details: { terminalId: "term-replay" },
				isError: false,
				timestamp: Date.now(),
			});

			updates.length = 0;
			await agent.loadSession({ sessionId: created.sessionId, cwd, mcpServers: [] });

			expectAcpNotifications(updates);
			const toolCall = updates.find(update => update.update.sessionUpdate === "tool_call")?.update as
				| { rawInput?: unknown; content?: unknown }
				| undefined;
			const finalUpdate = updates.find(update => update.update.sessionUpdate === "tool_call_update")?.update as
				| { content?: unknown }
				| undefined;

			expect(toolCall?.rawInput).toEqual({ command: "echo hi" });
			expect(toolCall?.rawInput).not.toEqual({ input: { command: "echo hi" } });
			expect(toolCall?.content).toEqual([{ type: "content", content: { type: "text", text: "$ echo hi" } }]);
			expect(finalUpdate?.content).toContainEqual({ type: "content", content: { type: "text", text: "$ echo hi" } });
			expect(finalUpdate?.content).toContainEqual({ type: "content", content: { type: "text", text: "done" } });
			expect(finalUpdate?.content).toContainEqual({ type: "terminal", terminalId: "term-replay" });
		} finally {
			abortController.abort();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
	it("builds replayed bash tool calls from JSON string arguments", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ command: "npm test", cwd: "/repo" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_1",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_1",
			title: "$ npm test",
			kind: "execute",
			status: "completed",
			rawInput: { command: "npm test", cwd: "/repo" },
			content: [{ type: "content", content: { type: "text", text: "$ npm test" } }],
		});
	});

	it("builds replayed read tool-call locations against the replay cwd", () => {
		const replayArgs = normalizeReplayToolArguments(JSON.stringify({ path: "src/foo.ts" }));
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_read",
			toolName: "read",
			args: replayArgs.args,
			cwd: path.resolve("/repo"),
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_read",
			title: "read: src/foo.ts",
			kind: "read",
			status: "completed",
			rawInput: { path: "src/foo.ts" },
			locations: [{ path: path.resolve("/repo", "src/foo.ts") }],
		});
		expect("content" in update).toBe(false);
	});

	it("keeps malformed replay arguments as raw input without command content", () => {
		const replayArgs = normalizeReplayToolArguments("{not json");
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_bad",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "toolu_replay_bad",
			title: "bash",
			kind: "execute",
			status: "completed",
			rawInput: "{not json",
		});
		expect("content" in update).toBe(false);
	});

	it("keeps object replay arguments unchanged and builds command content", () => {
		const rawArgs = { command: "bun test", cwd: "/repo" };
		const replayArgs = normalizeReplayToolArguments(rawArgs);
		const update = buildToolCallStartUpdate({
			toolCallId: "toolu_replay_object",
			toolName: "bash",
			args: replayArgs.args,
			status: "completed",
		});

		expect(replayArgs.args).toBe(rawArgs);
		expectAcpStructure(arkSessionNotification, { sessionId: "session-1", update });
		expect(update).toMatchObject({
			title: "$ bun test",
			status: "completed",
			rawInput: rawArgs,
			content: [{ type: "content", content: { type: "text", text: "$ bun test" } }],
		});
	});
	it("does not add command text content to non-command tool starts", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_1",
				toolName: "read",
				args: { path: "README.md" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as {
			sessionUpdate: string;
			title?: string;
			kind?: string;
			rawInput?: unknown;
			locations?: { path: string }[];
			content?: unknown;
		};
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.title).toBe("read: README.md");
		expect(update.kind).toBe("read");
		expect(update.rawInput).toEqual({ path: "README.md" });
		expect(update.locations).toEqual([{ path: "README.md" }]);
		expect("content" in update).toBe(false);
	});
	it("resolves tool_execution_start locations against mapper cwd", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "toolu_read_cwd",
				toolName: "read",
				args: { path: "src/file.ts" },
			} as AgentSessionEvent,
			"session-1",
			{ cwd: "/repo" },
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[]; content?: unknown };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: path.resolve("/repo", "src/file.ts") }]);
		expect("content" in update).toBe(false);
	});
	it("emits distinct locations for move-style path arguments", () => {
		const updates = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-move",
				toolName: "move",
				args: { path: "src/current.ts", oldPath: "src/old.ts", newPath: "src/new.ts" },
			} as AgentSessionEvent,
			"session-1",
		);

		expect(updates).toHaveLength(1);
		expectAcpNotifications(updates);
		const update = updates[0]!.update as { sessionUpdate: string; locations?: { path: string }[] };
		expect(update.sessionUpdate).toBe("tool_call");
		expect(update.locations).toEqual([{ path: "src/current.ts" }, { path: "src/old.ts" }, { path: "src/new.ts" }]);
	});

	it("maps shared IPython cell projections to one execute call with safe rich updates", () => {
		const updates = [
			{
				kind: "startup" as const,
				cellId: "cell-1",
				origin: "model" as const,
				progress: { stage: "runtime" as const, message: "Preparing runtime..." },
			},
			{
				kind: "execution" as const,
				cellId: "cell-1",
				origin: "model" as const,
				event: { kind: "stream" as const, name: "stdout" as const, text: "safe output\n" },
			},
		];
		const events: Array<IpythonCompletedCellPresentation["events"][number]> = [
			{ kind: "stream", name: "stdout", text: "safe output\n" },
			{
				kind: "display",
				data: {
					"text/html": "<script>unsafe()</script>",
					"image/jpeg": "a".repeat(300_000),
					"application/vnd.omp.diff+json": {
						path: "src/file.ts",
						diff: `@@ -1 +1 @@\n-${"o".repeat(10_000)}\n+${"n".repeat(10_000)}`,
					},
					"application/vnd.omp.attachment+json": {
						path: "plot.png",
						mime_type: "image/png",
						data: "cG5n",
					},
				},
				metadata: {},
				transient: {},
				update: false,
				text: "[displayed MIME types]",
			},
			{ kind: "host_progress", operation: "omp.code.edit", message: "Applied edit", data: {} },
		];
		for (let index = 0; index < 100; index++) {
			events.push({
				kind: "host_progress",
				operation: `omp.generated.${index}`,
				message: `Generated progress ${index}`,
				data: {},
			});
			events.push({
				kind: "display",
				data: {
					"application/vnd.omp.diff+json": {
						path: `src/generated-${index}.ts`,
						diff: "@@ -1 +1 @@\n-old\n+new",
					},
				},
				metadata: {},
				transient: {},
				update: false,
				text: "[displayed MIME types]",
			});
		}
		const live: IpythonLiveCellPresentation = {
			kind: "cell",
			phase: "live",
			cellId: "cell-1",
			origin: "model",
			code: "x".repeat(10_000),
			status: "running",
			events,
			errors: [],
			updates,
			startupProgress: [{ stage: "runtime", message: "Preparing runtime..." }],
			safeText: {
				text: "safe output\n[displayed MIME types]\n[omp.code.edit] Applied edit\n",
				truncated: false,
				totalBytes: 72,
				outputBytes: 72,
			},
			artifacts: [],
		};
		const complete: IpythonCompletedCellPresentation = {
			...live,
			phase: "complete",
			cellId: "cell-1",
			executionId: "execute-1",
			sequence: 1,
			authority: "trusted-cell",
			status: "ok",
			requestedAt: 10,
			startedAt: 11,
			finishedAt: 20,
			durationMs: 9,
			stdout: "safe output\n",
			stderr: "",
			result: undefined,
			artifacts: Array.from({ length: 100 }, (_, index) => ({
				path: index === 0 ? "/tmp/ipython/plot.png" : `/tmp/ipython/artifact-${index}.txt`,
				mimeType: index === 0 ? "image/png" : "text/plain",
				bytes: 3,
				label: index === 0 ? "plot" : `artifact ${index}`,
			})),
		};
		const options = { cwd: "/work", resolveImageData: (data: string) => `resolved:${data}` };
		const [start] = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "ipython_cell_start", presentation: live },
			"session-1",
			options,
		);
		const [progress] = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "ipython_cell_update", presentation: live },
			"session-1",
			options,
		);
		const [end] = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "ipython_cell_end", presentation: complete },
			"session-1",
			options,
		);

		expect(start?.update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "cell-1",
			kind: "execute",
			status: "pending",
		});
		const startUpdate = start?.update as { rawInput?: { code?: string } };
		expect(startUpdate.rawInput?.code?.length).toBe(4_000);
		expect(progress?.update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "cell-1",
			status: "in_progress",
		});
		expect(end?.update).toMatchObject({
			sessionUpdate: "tool_call_update",
			toolCallId: "cell-1",
			status: "completed",
		});
		const endUpdate = end?.update as {
			content?: Array<Record<string, unknown>>;
			locations?: unknown[];
		};
		const content = endUpdate.content ?? [];
		expect(content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "diff", path: "/work/src/file.ts" }),
				expect.objectContaining({
					type: "content",
					content: expect.objectContaining({ type: "image", data: "resolved:cG5n", mimeType: "image/png" }),
				}),
				expect.objectContaining({
					type: "content",
					content: expect.objectContaining({ type: "resource_link", mimeType: "image/png", size: 3 }),
				}),
			]),
		);
		expect(progress?.update).not.toHaveProperty("rawOutput");
		expect(end?.update).not.toHaveProperty("rawOutput");
		expect(content.length).toBeLessThanOrEqual(64);
		const boundedDiff = content.find(item => item.type === "diff" && item.path === "/work/src/file.ts");
		if (!boundedDiff || typeof boundedDiff.oldText !== "string" || typeof boundedDiff.newText !== "string") {
			throw new Error("missing bounded IPython diff");
		}
		expect(boundedDiff.oldText.length).toBeLessThanOrEqual(4_000);
		expect(boundedDiff.newText.length).toBeLessThanOrEqual(4_000);
		if (!Array.isArray(endUpdate.locations)) throw new Error("missing bounded IPython locations");
		expect(endUpdate.locations.length).toBeLessThanOrEqual(64);
		expect(endUpdate.locations.some(location => (location as { path?: unknown }).path === "/work/src/file.ts")).toBe(
			true,
		);
		expect(endUpdate.locations.some(location => (location as { path?: unknown }).path === "/work/plot.png")).toBe(
			true,
		);
		const serializedNotifications = JSON.stringify([start, progress, end]);
		expect(serializedNotifications).not.toContain("<script>");
		expect(serializedNotifications).not.toContain("a".repeat(300_000));
		expect(serializedNotifications.length).toBeLessThan(800_000);
		expect(JSON.stringify(content)).toContain("Preparing runtime");
		expect(JSON.stringify(content)).toContain("Additional IPython cell content omitted");
		expect(JSON.stringify(content)).toContain("omp.code.edit");
		expect(buildToolCallStartUpdate({ toolCallId: "ip-1", toolName: "ipython", args: {} })).toMatchObject({
			kind: "execute",
		});
	});

	it("maps aborted IPython terminal projections to failed ACP status", () => {
		const presentation = {
			kind: "cell",
			phase: "complete",
			cellId: "cell-abort",
			executionId: undefined,
			sequence: 2,
			origin: "model",
			authority: "trusted-cell",
			code: "while True: pass",
			status: "aborted",
			requestedAt: 1,
			startedAt: 2,
			finishedAt: 3,
			durationMs: 1,
			stdout: "",
			stderr: "",
			result: undefined,
			events: [],
			errors: [],
			updates: [],
			startupProgress: [],
			safeText: { text: "IPython cell aborted.\n", truncated: false, totalBytes: 23, outputBytes: 23 },
			artifacts: [],
		} satisfies IpythonCompletedCellPresentation;
		const [notification] = mapAgentSessionEventToAcpSessionUpdates(
			{ type: "ipython_cell_end", presentation },
			"session-1",
		);
		expect(notification?.update).toMatchObject({ status: "failed", toolCallId: "cell-abort" });
	});

	it("rejects mutated ACP notification discriminators", () => {
		const [notification] = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				type: "tool_execution_start",
				toolCallId: "tc-schema",
				toolName: "read",
				args: { path: "package.json" },
			} as AgentSessionEvent,
			"session-1",
		);

		expectAcpStructure(arkSessionNotification, notification);
		expectAcpStructureRejects(arkSessionNotification, {
			...notification,
			update: { ...notification!.update, sessionUpdate: "tool_call_updates" },
		});
		expectAcpStructureRejects(arkSessionNotification, { ...notification, sessionId: 42 });
	});
	it("projects bounded Act progress without a private transcript or done value", () => {
		const common = { type: "act_event" as const, actId: "act-acp", outerToolCallId: "cell-root" };
		const start = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				...common,
				sequence: 1,
				event: "start",
				prompt: `<script>${"p".repeat(8_000)}</script>`,
				promptTruncated: false,
				model: { provider: "test", id: "actor" },
				cancellationCapability: "posix-managed",
			},
			"session-1",
		);
		const cell = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				...common,
				sequence: 2,
				event: "cell_terminal",
				cellId: "act-cell",
				status: "ok",
				stdout: "x".repeat(10_000),
				stdoutTruncated: false,
				stderr: "",
				stderrTruncated: false,
				result: "safe result",
				resultTruncated: false,
				errorTruncated: false,
			},
			"session-1",
		);
		const terminal = mapHistoricalAgentSessionEventToAcpSessionUpdates(
			{
				...common,
				sequence: 3,
				event: "terminal",
				status: "done",
				prompt: "private prompt",
				promptTruncated: false,
				model: { provider: "test", id: "actor" },
				cancellationCapability: "posix-managed",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				errorTruncated: false,
			},
			"session-1",
		);
		expect(start[0]?.update).toMatchObject({
			sessionUpdate: "tool_call",
			toolCallId: "omp-act-act-acp",
			kind: "execute",
		});
		expect(Buffer.byteLength(JSON.stringify(start))).toBeLessThan(8_000);
		expect(Buffer.byteLength(JSON.stringify(cell))).toBeLessThan(8_000);
		expect(JSON.stringify(cell)).toContain("safe result");
		expect(JSON.stringify(terminal)).not.toContain("private prompt");
		expect(JSON.stringify(terminal)).not.toContain("rlm.done");
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SDKMessage, Query as SdkQuery } from "@anthropic-ai/claude-agent-sdk";
import * as claudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effort } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentPeer, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { claudeTranscriptPath } from "@oh-my-pi/pi-coding-agent/session/claude-session-store";
import * as claudeCodeRuntime from "@oh-my-pi/pi-coding-agent/task/claude-code-runtime";
import {
	CLAUDE_CODE_DENIED_TOOLS,
	CLAUDE_CODE_PERMISSION_MODE,
	CLAUDE_CODE_SKIP_PERMISSIONS,
	type ClaudeCodeRuntimeEvidence,
	OMP_MCP_SERVER_NAME,
	runClaudeCodeSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/claude-code-runtime";
import {
	type ClaudeCodeEvent,
	type ClaudeCodeQuery,
	type ClaudeCodeQueryRequest,
	type ClaudeCodeToolResult,
	createClaudeCodeMcpServer,
	type StartClaudeCodeQuery,
	startClaudeCodeQuery,
} from "@oh-my-pi/pi-coding-agent/task/claude-code-sdk";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { ExecutorOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import * as isolationModule from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import {
	runStructuredSubagent,
	StructuredSubagentError,
	type StructuredSubagentRequest,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import {
	type AgentDefinition,
	type AgentProgress,
	type SingleResult,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const AGENT: AgentDefinition = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

const OK_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

const UNSUPPORTED_NOT_ARRAY_SCHEMA = {
	type: "array",
	minItems: 1,
	items: {
		type: "object",
		properties: {
			value: { type: "number" },
			forbidden: { type: "boolean" },
		},
		required: ["value"],
		not: { required: ["forbidden"] },
	},
};

/** One scripted turn of a fake Claude run: an SDK event or an MCP yield call. */
type Step = ClaudeCodeEvent | { yieldArgs: Record<string, unknown> };

interface QueryLog {
	requests: ClaudeCodeQueryRequest[];
	toolResults: ClaudeCodeToolResult[];
	closes: number;
	prompts: string[];
}

function peerStub(): AgentPeer {
	return {
		messages: [],
		deliverIrcMessage: async () => "injected",
		abort: async () => {},
		dispose: async () => {},
	};
}

function log(): QueryLog {
	return { requests: [], toolResults: [], closes: 0, prompts: [] };
}

/**
 * A deterministic {@link StartClaudeCodeQuery}: it replays `steps`, dispatching
 * yield steps through the MCP tool the runtime admitted, and never launches
 * Claude. A step after the runtime stopped the query throws, matching the SDK's
 * behavior once its abort controller fires.
 */
async function readInitialPrompt(request: ClaudeCodeQueryRequest, queryLog: QueryLog): Promise<void> {
	if (typeof request.prompt === "string") {
		queryLog.prompts.push(request.prompt);
		return;
	}
	const first = await request.prompt[Symbol.asyncIterator]().next();
	if (first.done) throw new Error("Claude input ended before the initial prompt.");
	queryLog.prompts.push(first.value);
}

function fakeQuery(
	steps: Step[],
	queryLog: QueryLog,
	failures: { start?: Error; stream?: Error } = {},
): StartClaudeCodeQuery {
	return async request => {
		await readInitialPrompt(request, queryLog);
		if (failures.start) throw failures.start;
		queryLog.requests.push(request);
		const yieldTool = request.mcpServer.tools.find(tool => tool.name === "yield");
		async function* events(): AsyncGenerator<ClaudeCodeEvent> {
			for (const step of steps) {
				if ("yieldArgs" in step) {
					if (!yieldTool) throw new Error("no yield tool was admitted");
					queryLog.toolResults.push(await yieldTool.handler(step.yieldArgs));
					if (request.abortController.signal.aborted) throw new Error("query aborted");
					continue;
				}
				yield step;
			}
			if (failures.stream) throw failures.stream;
		}
		return {
			events: events(),
			close: () => {
				queryLog.closes += 1;
			},
		};
	};
}

/** Dispatch Yield calls through the production SDK/MCP adapter over an in-memory transport. */
function productionMcpQuery(yieldArgs: Record<string, unknown>[], queryLog: QueryLog): StartClaudeCodeQuery {
	return async request => {
		await readInitialPrompt(request, queryLog);
		queryLog.requests.push(request);
		const server = createClaudeCodeMcpServer(request.mcpServer);
		async function* events(): AsyncGenerator<ClaudeCodeEvent> {
			const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
			const client = new Client({ name: "yield-retry-boundary-test", version: "1" });
			await server.instance.connect(serverTransport);
			await client.connect(clientTransport);
			try {
				for (const args of yieldArgs) {
					const result = CallToolResultSchema.parse(await client.callTool({ name: "yield", arguments: args }));
					queryLog.toolResults.push({
						content: result.content
							.filter(part => part.type === "text")
							.map(part => ({ type: "text", text: part.text })),
						isError: result.isError,
					});
				}
			} finally {
				await client.close();
				await server.instance.close();
			}
		}
		return {
			events: events(),
			close: () => {
				queryLog.closes += 1;
			},
		};
	};
}

interface LiveQueryHarness {
	startQuery: StartClaudeCodeQuery;
	inputs: string[];
	closeCount: () => number;
	emit: (event: ClaudeCodeEvent) => Promise<void>;
	waitForInputs: (count: number) => Promise<void>;
}

interface VoidResolver {
	promise: Promise<void>;
	resolve: (value?: void | PromiseLike<void>) => void;
}

/** A retained fake query with independently controlled input and result boundaries. */
function liveQueryHarness(queryLog: QueryLog): LiveQueryHarness {
	interface QueuedEvent {
		event: ClaudeCodeEvent;
		consumed: VoidResolver;
	}
	const inputs: string[] = [];
	const inputWaiters: Array<{ count: number; resolve: () => void }> = [];
	const events: QueuedEvent[] = [];
	let wakeEvents: (() => void) | undefined;
	let eventsClosed = false;
	let closes = 0;

	const recordInput = (text: string): void => {
		inputs.push(text);
		for (let index = inputWaiters.length - 1; index >= 0; index--) {
			const waiter = inputWaiters[index];
			if (waiter && inputs.length >= waiter.count) {
				inputWaiters.splice(index, 1);
				waiter.resolve();
			}
		}
	};
	const waitForInputs = (count: number): Promise<void> => {
		if (inputs.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		inputWaiters.push({ count, resolve });
		return promise;
	};
	const emit = (event: ClaudeCodeEvent): Promise<void> => {
		if (eventsClosed) throw new Error("live query is closed");
		const consumed = Promise.withResolvers<void>();
		events.push({ event, consumed });
		const wake = wakeEvents;
		wakeEvents = undefined;
		wake?.();
		return consumed.promise;
	};
	const startQuery: StartClaudeCodeQuery = async request => {
		if (typeof request.prompt === "string") throw new Error("retained query requires streaming input");
		const input = request.prompt[Symbol.asyncIterator]();
		const initial = await input.next();
		if (initial.done) throw new Error("Claude input ended before the initial prompt.");
		recordInput(initial.value);
		queryLog.prompts.push(initial.value);
		queryLog.requests.push(request);
		const yieldTool = request.mcpServer.tools.find(tool => tool.name === "yield");
		if (!yieldTool) throw new Error("no yield tool was admitted");

		void (async () => {
			for (;;) {
				const next = await input.next();
				if (next.done) return;
				recordInput(next.value);
			}
		})();
		async function* eventStream(): AsyncGenerator<ClaudeCodeEvent> {
			for (;;) {
				while (events.length === 0 && !eventsClosed) {
					const ready = Promise.withResolvers<void>();
					wakeEvents = ready.resolve;
					await ready.promise;
				}
				const queued = events.shift();
				if (!queued) return;
				yield queued.event;
				queued.consumed.resolve();
			}
		}
		queueMicrotask(() => {
			void (async () => {
				await emit({
					kind: "init",
					sessionId: "retained-session",
					model: "claude-opus-5",
					tools: ["Read", "Edit", "mcp__omp__task", "mcp__omp__hub", "mcp__omp__yield"],
					version: "2.1.220",
				});
				queryLog.toolResults.push(await yieldTool.handler({ result: { data: { ok: true } } }));
				await emit({ kind: "result", isError: false, text: "initial done", tokens: 1, requests: 1 });
			})();
		});
		return {
			events: eventStream(),
			close: () => {
				if (eventsClosed) return;
				eventsClosed = true;
				closes++;
				const wake = wakeEvents;
				wakeEvents = undefined;
				wake?.();
			},
		};
	};

	return { startQuery, inputs, closeCount: () => closes, emit, waitForInputs };
}

function executorOptions(overrides: Partial<ExecutorOptions> = {}): ExecutorOptions {
	return {
		cwd: "/tmp",
		agent: AGENT,
		task: "Inspect the target.",
		assignment: "Inspect the target.",
		index: 0,
		id: "Worker",
		settings: Settings.isolated({ "task.claudeCode.executable": "claude-min" }),
		keepAlive: false,
		...overrides,
	};
}

function session(
	settingsOverrides: Parameters<typeof Settings.isolated>[0] = {},
	probes: Record<string, unknown> = {},
): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxRecursionDepth": 2,
			"task.isolation.mode": "none",
			...settingsOverrides,
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		...probes,
	} as unknown as ToolSession;
}

function request(overrides: Partial<StructuredSubagentRequest> = {}): StructuredSubagentRequest {
	return {
		session: session(),
		invocationKind: "task",
		assignment: "Inspect the target.",
		agent: "worker",
		...overrides,
	};
}

function piResult(): SingleResult {
	return {
		index: 0,
		id: "Worker",
		agent: "worker",
		agentSource: "bundled",
		task: "Inspect the target.",
		exitCode: 0,
		output: "{}",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("claude code runtime", () => {
	it("starts the SDK with the configured executable, model suffix, denied tools, and OMP yield", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-4-5",
			startQuery: fakeQuery(
				[
					{ kind: "assistant", text: "working", tokens: 5, requests: 1 },
					{ kind: "result", isError: false, text: "done", tokens: 12, requests: 3 },
				],
				queryLog,
			),
		});

		expect(queryLog.requests).toHaveLength(1);
		const started = queryLog.requests[0];
		expect(started.executable).toBe("claude-min");
		expect(started.model).toBe("claude-opus-4-5");
		expect(started.cwd).toBe("/tmp");
		expect(queryLog.prompts).toEqual(["Inspect the target."]);
		expect(started.appendSystemPrompt).toBe(
			`${AGENT.systemPrompt}\n\nUse OMP \`task\` for delegation and OMP \`hub\` for peer messaging or task-job custody. Native Claude coordination is unavailable. You MUST terminate through the OMP \`yield\` tool.`,
		);
		expect(started.disallowedTools).toEqual(["Agent", "Task", "SendMessage"]);
		expect(CLAUDE_CODE_DENIED_TOOLS).toEqual(["Agent", "Task", "SendMessage"]);
		expect(Object.hasOwn(started, "tools")).toBe(false);
		// The ordinary Claude coding tools stay available.
		expect(started.disallowedTools).not.toContain("Edit");
		expect(started.disallowedTools).not.toContain("Bash");
		expect(started.mcpServer.name).toBe(OMP_MCP_SERVER_NAME);
		expect(started.mcpServer.tools.map(tool => tool.name)).toEqual(["task", "hub", "yield"]);
		const yieldDescription = started.mcpServer.tools.find(tool => tool.name === "yield")?.description ?? "";
		expect(yieldDescription).toContain("Use `result: { data: <your output> }` for success");
		expect(yieldDescription).toContain('`result: { error: "message" }` for failure');
		expect(yieldDescription).not.toContain("Parameters:");
		expect(result.resolvedModel).toBe("claude-opus-4-5");
		expect(result.tokens).toBe(12);
		expect(result.requests).toBe(3);
		expect(queryLog.closes).toBe(1);
	});

	it("starts the SDK in the isolated worktree", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions({ cwd: "/tmp/parent", worktree: "/tmp/isolated" }),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		expect(queryLog.requests[0]?.cwd).toBe("/tmp/isolated");
	});

	it("maps a parsed scout allowlist to exact read-only Claude built-ins", async () => {
		const queryLog = log();
		const parsed = parseAgentFields({
			name: "scout",
			description: "Read-only scout",
			tools: "read, grep, glob, web_search",
		});
		if (!parsed?.tools) throw new Error("scout allowlist was not parsed");
		expect(parsed.tools).toEqual(["read", "grep", "glob", "web_search", "yield"]);
		await runClaudeCodeSubprocess({
			options: executorOptions({
				agent: { ...AGENT, name: parsed.name, description: parsed.description, tools: parsed.tools },
			}),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		const started = queryLog.requests[0];
		expect(started.tools).toEqual(["Read", "Grep", "Glob", "WebSearch"]);
		expect(started.tools).not.toContain("Bash");
		expect(started.tools).not.toContain("Edit");
		expect(started.tools).not.toContain("Write");
		expect(started.disallowedTools).toEqual(["Agent", "Task", "SendMessage"]);
		expect(started.mcpServer.tools.map(tool => tool.name)).toEqual(["task", "hub", "yield"]);
	});

	it("keeps OMP coordination tools denied inside an explicit allowlist", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions({
				agent: { ...AGENT, tools: ["task", "hub", "irc"] },
			}),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		const started = queryLog.requests[0];
		expect(started.tools).toEqual([]);
		expect(started.disallowedTools).toEqual(["Agent", "Task", "SendMessage"]);
		expect(started.mcpServer.tools.map(tool => tool.name)).toEqual(["task", "hub", "yield"]);
	});

	// `world` is OMP-owned and served over the same MCP bridge, so a restricted
	// child that lists it is asking for a tool it can actually be given rather
	// than an unsupported one. Whether it is advertised stays a configuration
	// question, decided by the bridge.
	it("admits the OMP-owned world tools inside an explicit allowlist", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions({
				agent: { ...AGENT, tools: ["read", "world", "world_read"] },
			}),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		const started = queryLog.requests[0];
		expect(started.tools).toEqual(["Read"]);
		expect(started.disallowedTools).toEqual(["Agent", "Task", "SendMessage"]);
	});

	it("rejects unsupported restricted OMP tools before query construction", async () => {
		let queryConstructed = false;
		const startQuery: StartClaudeCodeQuery = async () => {
			queryConstructed = true;
			throw new Error("query must not start");
		};

		await expect(
			runClaudeCodeSubprocess({
				options: executorOptions({
					agent: { ...AGENT, tools: ["read", "lsp", "ast_grep"] },
				}),
				model: "claude-opus-5",
				startQuery,
			}),
		).rejects.toThrow("Unsupported restricted OMP tools for Claude Code runtime: ast_grep, lsp.");
		expect(queryConstructed).toBe(false);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("maps hi to the highest SDK-supported effort", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions({ effort: "hi" }),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		expect(queryLog.requests[0]?.effort).toBe("max");
	});

	it("passes an explicit runtime-selector effort to the SDK", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			effort: Effort.XHigh,
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		expect(queryLog.requests[0]?.effort).toBe("xhigh");
	});

	it("clamps requested effort to task.maxEffort", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions({
				effort: "hi",
				settings: Settings.isolated({
					"task.claudeCode.executable": "claude-min",
					"task.maxEffort": "low",
				}),
			}),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { data: { ok: true } } } }], queryLog),
		});

		expect(queryLog.requests[0]?.effort).toBe("low");
	});

	it("advertises the real Yield object schema through the production MCP boundary", async () => {
		let advertisedInput: unknown;
		const close = vi.fn();
		const startQuery: StartClaudeCodeQuery = async request => {
			const server = createClaudeCodeMcpServer(request.mcpServer);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				const client = new Client({ name: "yield-boundary-test", version: "1" });
				await server.instance.connect(serverTransport);
				await client.connect(clientTransport);
				try {
					advertisedInput = (await client.listTools()).tools.find(tool => tool.name === "yield")?.inputSchema;
					const called = await client.callTool({
						name: "yield",
						arguments: { result: { data: { ok: true } } },
					});
					expect(called.isError).not.toBe(true);
				} finally {
					await client.close();
					await server.instance.close();
				}
			}
			return { events: events(), close };
		};

		const result = await runClaudeCodeSubprocess({
			options: executorOptions({ outputSchema: OK_SCHEMA, outputSchemaSource: "agent" }),
			model: "claude-opus-5",
			startQuery,
		});

		expect(advertisedInput).toEqual(
			expect.objectContaining({
				type: "object",
				properties: expect.objectContaining({
					result: expect.objectContaining({
						anyOf: expect.arrayContaining([expect.objectContaining({ type: "object" })]),
					}),
				}),
				required: ["result"],
			}),
		);
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({ source: "agent", status: "valid", data: { ok: true } });
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("advertises unsupported JSON Schema keywords unchanged while Yield validates them", async () => {
		let advertisedInput: unknown;
		let expectedInput: unknown;
		const close = vi.fn();
		const startQuery: StartClaudeCodeQuery = async request => {
			const server = createClaudeCodeMcpServer(request.mcpServer);
			expectedInput = request.mcpServer.tools.find(tool => tool.name === "yield")?.inputSchema;
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
				const client = new Client({ name: "unsupported-schema-test", version: "1" });
				await server.instance.connect(serverTransport);
				await client.connect(clientTransport);
				try {
					advertisedInput = (await client.listTools()).tools.find(tool => tool.name === "yield")?.inputSchema;
					const wrongContainer = await client.callTool({
						name: "yield",
						arguments: { result: { data: { value: 2 } } },
					});
					expect(wrongContainer.isError).toBe(true);

					const invalidExcludedShape = await client.callTool({
						name: "yield",
						arguments: { result: { data: [{ value: 2, forbidden: true }] } },
					});
					expect(invalidExcludedShape.isError).toBe(true);
					expect(JSON.stringify(invalidExcludedShape.content)).toContain("does not match schema");

					const valid = await client.callTool({
						name: "yield",
						arguments: { result: { data: [{ value: 2 }] } },
					});
					expect(valid.isError).not.toBe(true);
				} finally {
					await client.close();
					await server.instance.close();
				}
			}
			return { events: events(), close };
		};

		const result = await runClaudeCodeSubprocess({
			options: executorOptions({ outputSchema: UNSUPPORTED_NOT_ARRAY_SCHEMA, outputSchemaSource: "agent" }),
			model: "claude-opus-5",
			startQuery,
		});

		expect(advertisedInput).toEqual(expectedInput);
		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({
			source: "agent",
			status: "valid",
			data: [{ value: 2 }],
		});
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("requires object arguments at MCP while passing their raw fields to the handler", async () => {
		const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "passed" }] }));
		const server = createClaudeCodeMcpServer({
			name: "raw-boundary",
			tools: [
				{
					name: "raw",
					description: "Raw object boundary fixture.",
					inputSchema: {
						type: "object",
						properties: { ok: { type: "boolean" } },
						required: ["ok"],
					},
					handler,
				},
			],
		});
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "raw-boundary-test", version: "1" });
		await server.instance.connect(serverTransport);
		await client.connect(clientTransport);
		try {
			await expect(client.callTool({ name: "raw" })).rejects.toThrow();
			expect(handler).not.toHaveBeenCalled();

			const result = await client.callTool({ name: "raw", arguments: { ok: "not-a-boolean" } });
			expect(handler).toHaveBeenCalledWith({ ok: "not-a-boolean" });
			expect(result.content).toEqual([{ type: "text", text: "passed" }]);
		} finally {
			await client.close();
			await server.instance.close();
		}
	});

	it("maps streaming input, disables filesystem settings, and reports SDK progress", async () => {
		const close = vi.fn();
		async function* input(): AsyncGenerator<string> {
			yield "Inspect the target.";
			yield "Follow-up turn.";
		}
		async function* messages(): AsyncGenerator<SDKMessage> {
			yield {
				type: "tool_progress",
				tool_use_id: "tool-1",
				tool_name: "Read",
				parent_tool_use_id: null,
				elapsed_time_seconds: 2,
				uuid: "message-1",
				session_id: "session-1",
			} as unknown as SDKMessage;
			yield {
				type: "assistant",
				message: {
					content: [{ type: "tool_use", id: "yield-1", name: "mcp__omp__yield", input: {} }],
					usage: { input_tokens: 11, output_tokens: 6 },
				},
				parent_tool_use_id: null,
				uuid: "message-2",
				session_id: "session-1",
			} as unknown as SDKMessage;
			yield {
				type: "assistant",
				message: {
					content: [{ type: "text", text: "Finished inspection." }],
					usage: { input_tokens: 7, output_tokens: 2 },
				},
				parent_tool_use_id: null,
				uuid: "message-3",
				session_id: "session-1",
			} as unknown as SDKMessage;
		}
		const sdkQuery = messages();
		Object.assign(sdkQuery, { close });
		const queryCall = vi.spyOn(claudeAgentSdk, "query").mockReturnValue(sdkQuery as unknown as SdkQuery);

		const started = await startClaudeCodeQuery({
			prompt: input(),
			model: "claude-opus-5",
			cwd: "/tmp",
			executable: "claude-min",
			tools: ["Read", "Grep"],
			disallowedTools: [...CLAUDE_CODE_DENIED_TOOLS],
			permissionMode: CLAUDE_CODE_PERMISSION_MODE,
			allowDangerouslySkipPermissions: CLAUDE_CODE_SKIP_PERMISSIONS,
			mcpServer: { name: OMP_MCP_SERVER_NAME, tools: [] },
			abortController: new AbortController(),
		});
		const events: ClaudeCodeEvent[] = [];
		for await (const event of started.events) events.push(event);
		started.close();

		const sdkPrompt = queryCall.mock.calls[0]?.[0].prompt;
		if (typeof sdkPrompt === "string") throw new Error("expected SDK streaming input");
		const sdkInputs: SDKMessage[] = [];
		for await (const message of sdkPrompt) sdkInputs.push(message);

		expect(sdkInputs).toEqual([
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "Inspect the target." }] },
				parent_tool_use_id: null,
				origin: { kind: "coordinator" },
				priority: "next",
				shouldQuery: true,
			},
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "Follow-up turn." }] },
				parent_tool_use_id: null,
				origin: { kind: "coordinator" },
				priority: "next",
				shouldQuery: true,
			},
		]);
		expect(queryCall.mock.calls[0]?.[0].options?.settingSources).toEqual([]);
		expect(queryCall.mock.calls[0]?.[0].options?.tools).toEqual(["Read", "Grep"]);
		expect(events).toEqual([
			{ kind: "tool-progress", toolUseId: "tool-1", toolName: "Read", elapsedSeconds: 2 },
			{ kind: "assistant", tokens: 17, requests: 1 },
			{ kind: "assistant", text: "Finished inspection.", tokens: 9, requests: 1 },
		]);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("starts the SDK with permission checks bypassed so the OMP yield tool is admitted", async () => {
		const queryLog = log();
		await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ kind: "result", isError: false, text: "done", tokens: 1, requests: 1 }], queryLog),
		});

		const started = queryLog.requests[0];
		// The SDK denies `mcp__omp__yield` in its default non-interactive mode,
		// so both permission fields are required.
		expect(started.permissionMode).toBe("bypassPermissions");
		expect(started.allowDangerouslySkipPermissions).toBe(true);
		expect(CLAUDE_CODE_PERMISSION_MODE).toBe("bypassPermissions");
		expect(CLAUDE_CODE_SKIP_PERMISSIONS).toBe(true);
		// Bypassing permissions does not widen the tool surface.
		expect(started.disallowedTools).toEqual(["Agent", "Task", "SendMessage"]);
	});

	it("reports SDK init capabilities only after query and registry teardown", async () => {
		const queryLog = log();
		const observed: ClaudeCodeRuntimeEvidence[] = [];
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[
					{
						kind: "init",
						sessionId: "session-live-proof",
						model: "claude-opus-5",
						tools: ["Read", "Edit", "mcp__omp__task", "mcp__omp__hub", "mcp__omp__yield"],
						version: "2.1.220",
					},
					{ yieldArgs: { result: { data: { ok: true } } } },
				],
				queryLog,
			),
			onEvidence: evidence => observed.push(evidence),
		});

		expect(result).toMatchObject({ exitCode: 0, resolvedModel: "claude-opus-5" });
		expect(observed).toEqual([
			{
				agentId: "Worker",
				init: {
					kind: "init",
					sessionId: "session-live-proof",
					model: "claude-opus-5",
					tools: ["Read", "Edit", "mcp__omp__task", "mcp__omp__hub", "mcp__omp__yield"],
					version: "2.1.220",
				},
				queryClosed: true,
				registryRefRemoved: true,
			},
		]);
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("fails startup when init exposes denied tools or omits required OMP tools", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[
					{
						kind: "init",
						sessionId: "session-invalid-tools",
						model: "claude-opus-5",
						tools: ["Read", "Agent", "mcp__omp__yield"],
						version: "2.1.220",
					},
				],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("Claude Code exposed denied tools: Agent.");
		expect(result.stderr).toContain("Claude Code omitted required OMP tools: task, hub.");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("cancels and awaits surviving owner jobs before unregistering the Claude peer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const started = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		let jobId = "";
		const startQuery: StartClaudeCodeQuery = async request => {
			jobId = manager.register(
				"task",
				"unfinished nested task",
				async ({ signal }) => {
					started.resolve();
					if (!signal.aborted) {
						await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					}
					stopped.resolve();
					return "cancelled";
				},
				{ ownerId: "Worker" },
			);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				await started.promise;
				const yieldTool = request.mcpServer.tools.find(tool => tool.name === "yield");
				if (!yieldTool) throw new Error("Yield MCP tool missing");
				await yieldTool.handler({ result: { data: { ok: true } } });
			}
			return { events: events(), close: () => {} };
		};

		try {
			const result = await runClaudeCodeSubprocess({
				options: executorOptions({ asyncJobManager: manager }),
				model: "claude-opus-5",
				startQuery,
			});

			expect(result.exitCode).toBe(0);
			await stopped.promise;
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			expect(AgentRegistry.global().get("Worker")).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 1_000 });
		}
	});

	it("emits tool and assistant activity through Task progress channels", async () => {
		const queryLog = log();
		const updates: AgentProgress[] = [];
		const busProgress: unknown[] = [];
		const lifecycle: unknown[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => busProgress.push(data));
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycle.push(data));

		const result = await runClaudeCodeSubprocess({
			options: executorOptions({
				eventBus,
				onProgress: progress => updates.push(progress),
			}),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[
					{ kind: "tool-progress", toolUseId: "tool-1", toolName: "Read", elapsedSeconds: 2 },
					{ kind: "assistant", text: "Reading the target\nChecking the result", tokens: 0, requests: 0 },
					{ yieldArgs: { result: { data: { ok: true } } } },
				],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(0);
		expect(updates[0]).toMatchObject({
			status: "running",
			currentTool: "Read",
			toolCount: 1,
		});
		expect(updates[1]).toMatchObject({
			status: "running",
			recentOutput: ["Checking the result", "Reading the target"],
		});
		expect(updates.at(-1)?.status).toBe("completed");
		expect(busProgress).toHaveLength(updates.length);
		expect(lifecycle).toMatchObject([{ status: "started" }, { status: "completed" }]);
	});

	it("registers a live peer, exposes progress messages, records activity, and removes its exact ref", async () => {
		const queryLog = log();
		const progress = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const startQuery: StartClaudeCodeQuery = async request => {
			queryLog.requests.push(request);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				yield { kind: "assistant", text: "Reading the target", tokens: 0, requests: 0 };
				progress.resolve();
				await finish.promise;
				const yieldTool = request.mcpServer.tools.find(tool => tool.name === "yield");
				if (!yieldTool) throw new Error("no yield tool was admitted");
				await yieldTool.handler({ result: { data: { ok: true } } });
			}
			return {
				events: events(),
				close: () => {
					queryLog.closes++;
				},
			};
		};

		const running = runClaudeCodeSubprocess({
			options: executorOptions({ parentAgentId: "Parent" }),
			model: "claude-opus-5",
			startQuery,
		});
		await progress.promise;

		const ref = AgentRegistry.global().get("Worker");
		expect(ref).toMatchObject({
			id: "Worker",
			parentId: "Parent",
			status: "running",
			activity: "Reading the target",
		});
		if (!ref?.session) throw new Error("Claude peer was not attached");
		expect(ref.session.messages).toHaveLength(2);
		expect(ref.session.messages[1]).toMatchObject({ role: "assistant" });
		await expect(
			ref.session.deliverIrcMessage({
				id: "message",
				from: "Parent",
				to: "Worker",
				body: "hello",
				ts: Date.now(),
			}),
		).resolves.toBe("queued");

		finish.resolve();
		const result = await running;
		expect(result.exitCode).toBe(0);
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("retains one query across queued, asynchronous, and parked lifecycle boundaries", async () => {
		const queryLog = log();
		const live = liveQueryHarness(queryLog);
		const jobs = new AsyncJobManager({ retentionMs: 60_000 });
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({
				keepAlive: true,
				asyncJobManager: jobs,
				settings: Settings.isolated({
					"task.claudeCode.executable": "claude-min",
					"task.agentIdleTtlMs": 0,
				}),
			}),
			model: "claude-opus-5",
			startQuery: live.startQuery,
		});

		expect(result.exitCode).toBe(0);
		expect(live.inputs).toEqual(["Inspect the target."]);
		expect(live.closeCount()).toBe(0);
		const retained = registry.get("Worker");
		expect(retained).toMatchObject({ status: "idle" });
		expect(retained?.session).toBeTruthy();
		expect(lifecycle.has("Worker", retained)).toBe(true);

		const bus = new IrcBus(registry, lifecycle);
		const waiting = bus.wait("Worker", { from: "Main" }, 1_000);
		const immediate = await bus.send({ from: "Main", to: "Worker", body: "wait result" });
		expect(immediate).toEqual({ to: "Worker", outcome: "injected" });
		expect((await waiting)?.body).toBe("wait result");
		expect(live.inputs).toHaveLength(1);

		const woken = await bus.send({ from: "Main", to: "Worker", body: "first turn" });
		expect(woken).toEqual({ to: "Worker", outcome: "woken" });
		await live.waitForInputs(2);
		const queued = await bus.send({ from: "Main", to: "Worker", body: "second turn" });
		expect(queued).toEqual({ to: "Worker", outcome: "queued" });
		await live.waitForInputs(3);

		jobs.register("bash", "owned proof", async () => "async owner result", {
			id: "owned-proof",
			ownerId: "Worker",
		});
		await jobs.waitForAll();
		expect(await jobs.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Worker" } })).toBe(true);
		await live.waitForInputs(4);
		expect(live.inputs[1]).toContain("first turn");
		expect(live.inputs[2]).toContain("second turn");
		expect(live.inputs[3]).toContain("owned-proof");
		expect(live.inputs[3]).toContain("async owner result");

		await live.emit({ kind: "result", isError: false, text: "batch done", tokens: 1, requests: 1 });
		expect(registry.get("Worker")?.status).toBe("idle");

		await lifecycle.park("Worker");
		expect(live.closeCount()).toBe(1);
		expect(registry.get("Worker")).toMatchObject({ status: "parked", session: null });

		jobs.register("bash", "after park", async () => "must not arrive", {
			id: "after-park",
			ownerId: "Worker",
		});
		await jobs.waitForAll();
		expect(await jobs.drainDeliveries({ timeoutMs: 1_000, filter: { ownerId: "Worker" } })).toBe(true);
		expect(live.inputs).toHaveLength(4);
		await jobs.dispose({ timeoutMs: 1_000 });
	});

	it("persists only Claude runtime metadata beside the parent transcript", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-claude-metadata-"));
		const artifactsDir = path.join(root, "parent");
		await fs.mkdir(artifactsDir);
		const live = liveQueryHarness(log());
		try {
			const result = await runClaudeCodeSubprocess({
				options: executorOptions({
					cwd: root,
					keepAlive: true,
					persistArtifacts: true,
					artifactsDir,
					settings: Settings.isolated({
						"task.claudeCode.executable": "claude-min",
						"task.agentIdleTtlMs": 0,
					}),
				}),
				model: "claude-opus-5",
				effort: Effort.XHigh,
				startQuery: live.startQuery,
			});

			expect(result.exitCode).toBe(0);
			const metadataFile = path.join(artifactsDir, "Worker.jsonl");
			expect(AgentRegistry.global().get("Worker")?.sessionFile).toBe(metadataFile);
			const entries = (await Bun.file(metadataFile).text())
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as Record<string, unknown>);
			expect(entries.some(entry => entry.type === "message")).toBe(false);
			const init = entries.find(entry => entry.type === "session_init");
			expect(init).toMatchObject({
				task: "Inspect the target.",
				runtime: {
					kind: "claude-code",
					sessionId: "retained-session",
					cwd: root,
					transcriptPath: claudeTranscriptPath(root, "retained-session"),
					model: "claude-opus-5",
					effort: Effort.XHigh,
					toolPolicyVersion: 1,
				},
			});
			await AgentLifecycleManager.global().release("Worker");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("refuses to replace a live registry generation before SDK startup", async () => {
		const registry = AgentRegistry.global();
		const existing = registry.register({
			id: "Worker",
			displayName: "existing",
			kind: "sub",
			session: peerStub(),
			status: "running",
		});
		let queryStarted = false;
		const startQuery: StartClaudeCodeQuery = async () => {
			queryStarted = true;
			throw new Error("unreachable");
		};

		await expect(
			runClaudeCodeSubprocess({
				options: executorOptions(),
				model: "claude-opus-5",
				startQuery,
			}),
		).rejects.toThrow('Agent "Worker" is already owned by another session generation.');
		expect(queryStarted).toBe(false);
		expect(registry.get("Worker")).toBe(existing);
	});

	it("attached-query external abort closes once, returns aborted state, and preserves a replacement ref", async () => {
		const queryLog = log();
		const consuming = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const lifecycleEvents: unknown[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycleEvents.push(data));
		const startQuery: StartClaudeCodeQuery = async request => {
			queryLog.requests.push(request);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				consuming.resolve();
				await closed.promise;
				await finish.promise;
				if (request.abortController.signal.aborted) throw new Error("query closed");
				yield { kind: "result", isError: true, text: "query remained open", tokens: 0, requests: 0 };
			}
			return {
				events: events(),
				close: () => {
					queryLog.closes++;
					closed.resolve();
				},
			};
		};
		const running = runClaudeCodeSubprocess({
			options: executorOptions({ eventBus }),
			model: "claude-opus-5",
			startQuery,
		});
		await consuming.promise;
		const oldRef = AgentRegistry.global().get("Worker");
		if (!oldRef?.session) throw new Error("Claude peer was not attached");
		const oldSession = oldRef.session;

		await Promise.all([
			oldSession.abort({ reason: "Hub cancelled task" }),
			oldSession.dispose(),
			oldSession.abort({ reason: "Hub cancelled task" }),
		]);
		expect(await AgentLifecycleManager.global().release("Worker", oldRef)).toBe(true);
		const replacementSession = peerStub();
		const replacement = AgentRegistry.global().register({
			id: "Worker",
			displayName: "replacement",
			kind: "sub",
			session: replacementSession,
			status: "running",
		});
		finish.resolve();
		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Hub cancelled task");
		expect(result.stderr).toBe("Hub cancelled task");
		expect(queryLog.closes).toBe(1);
		expect(lifecycleEvents).toMatchObject([{ status: "started" }, { status: "aborted" }]);
		expect(AgentRegistry.global().get("Worker")).toBe(replacement);
		expect(replacement.session).toBe(replacementSession);
	});

	it("preserves a replacement generation and does not report stale activity to it", async () => {
		const queryLog = log();
		const progress = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const startQuery: StartClaudeCodeQuery = async request => {
			queryLog.requests.push(request);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				yield { kind: "assistant", text: "old generation", tokens: 0, requests: 0 };
				progress.resolve();
				await finish.promise;
				yield { kind: "assistant", text: "stale progress", tokens: 0, requests: 0 };
				yield { kind: "result", isError: false, text: "done", tokens: 2, requests: 1 };
			}
			return {
				events: events(),
				close: () => {
					queryLog.closes++;
				},
			};
		};
		const running = runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery,
		});
		await progress.promise;
		const replacementSession = peerStub();
		const replacement = AgentRegistry.global().register({
			id: "Worker",
			displayName: "replacement",
			kind: "sub",
			session: replacementSession,
			status: "running",
		});

		finish.resolve();
		await running;

		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBe(replacement);
		expect(replacement.session).toBe(replacementSession);
		expect(replacement.activity).toBeUndefined();
	});

	it("rejects a query that finishes construction after its ref was replaced", async () => {
		const queryLog = log();
		const start = Promise.withResolvers<ClaudeCodeQuery>();
		const running = runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: async request => {
				queryLog.requests.push(request);
				return await start.promise;
			},
		});
		const preRegistered = AgentRegistry.global().get("Worker");
		expect(preRegistered?.session).toBeTruthy();
		const replacement = AgentRegistry.global().register({
			id: "Worker",
			displayName: "replacement",
			kind: "sub",
			session: peerStub(),
			status: "running",
		});
		async function* events(): AsyncGenerator<ClaudeCodeEvent> {}
		start.resolve({
			events: events(),
			close: () => {
				queryLog.closes++;
			},
		});

		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("replaced or became terminal");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBe(replacement);
	});

	it("startup external abort closes the late query and preserves the exact aborted tombstone", async () => {
		const queryLog = log();
		const start = Promise.withResolvers<ClaudeCodeQuery>();
		const lifecycleEvents: unknown[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycleEvents.push(data));
		const running = runClaudeCodeSubprocess({
			options: executorOptions({ eventBus }),
			model: "claude-opus-5",
			startQuery: async request => {
				queryLog.requests.push(request);
				return await start.promise;
			},
		});
		const tombstone = AgentRegistry.global().get("Worker");
		if (!tombstone?.session) throw new Error("Claude peer was not pre-registered");
		await tombstone.session.abort({ reason: "Agent Hub killed task" });
		expect(await AgentLifecycleManager.global().release("Worker", tombstone, { tombstone: true })).toBe(true);
		async function* events(): AsyncGenerator<ClaudeCodeEvent> {}
		start.resolve({
			events: events(),
			close: () => {
				queryLog.closes++;
			},
		});

		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Agent Hub killed task");
		expect(result.stderr).toBe("Agent Hub killed task");
		expect(queryLog.closes).toBe(1);
		expect(lifecycleEvents).toMatchObject([{ status: "started" }, { status: "aborted" }]);
		expect(AgentRegistry.global().get("Worker")).toBe(tombstone);
		expect(tombstone).toMatchObject({ status: "aborted", session: null });
	});

	it("contains a throwing close during startup abort and reports teardown failure", async () => {
		const queryLog = log();
		const start = Promise.withResolvers<ClaudeCodeQuery>();
		const started = Promise.withResolvers<ClaudeCodeQueryRequest>();
		const controller = new AbortController();
		const observed: ClaudeCodeRuntimeEvidence[] = [];
		const running = runClaudeCodeSubprocess({
			options: executorOptions({ signal: controller.signal }),
			model: "claude-opus-5",
			startQuery: async request => {
				queryLog.requests.push(request);
				started.resolve(request);
				return await start.promise;
			},
			onEvidence: evidence => observed.push(evidence),
		});
		const sdkRequest = await started.promise;
		controller.abort(new Error("parent cancelled during startup"));
		expect(sdkRequest.abortController.signal.aborted).toBe(true);
		async function* events(): AsyncGenerator<ClaudeCodeEvent> {}
		start.resolve({
			events: events(),
			close: () => {
				queryLog.closes++;
				throw new Error("close exploded");
			},
		});

		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("parent cancelled during startup");
		expect(result.stderr).toContain("parent cancelled during startup");
		expect(result.stderr).toContain("Claude Code query close failed: close exploded");
		expect(queryLog.closes).toBe(1);
		expect(observed).toEqual([
			{
				agentId: "Worker",
				init: undefined,
				queryClosed: false,
				registryRefRemoved: false,
			},
		]);
		expect(AgentRegistry.global().get("Worker")).toMatchObject({ status: "aborted", session: null });
	});

	it("returns the established result for a terminal yield", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({ outputSchema: OK_SCHEMA, outputSchemaSource: "agent" }),
			model: "claude-opus-4-5",
			startQuery: fakeQuery(
				[
					{ kind: "assistant", tokens: 18, requests: 1 },
					{ yieldArgs: { result: { data: { ok: true } } } },
					{ kind: "result", isError: false, text: "unreachable", tokens: 1, requests: 1 },
				],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(JSON.stringify({ ok: true }, null, 2));
		expect(result.stderr).toBe("");
		expect(result.error).toBeUndefined();
		expect(result.structuredOutput).toMatchObject({ source: "agent", status: "valid", data: { ok: true } });
		expect(result.tokens).toBe(18);
		expect(result.requests).toBe(1);
		// One-shot Yield closes before the scripted terminal result.
		expect(queryLog.toolResults).toHaveLength(1);
		expect(queryLog.toolResults[0].isError).toBeUndefined();
		expect(queryLog.closes).toBe(1);
	});

	it("maps an aborted Yield to the established aborted Task result", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery([{ yieldArgs: { result: { error: "blocked by permissions" } } }], queryLog),
		});

		expect(result.exitCode).toBe(0);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("blocked by permissions");
		expect(result.stderr).toBe("blocked by permissions");
		expect(result.error).toBeUndefined();
		expect(JSON.parse(result.output)).toEqual({ aborted: true, error: "blocked by permissions" });
	});

	it("hands the yield tool's retry guidance back to the model as a tool error", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({ outputSchema: OK_SCHEMA, outputSchemaSource: "agent" }),
			model: "claude-opus-4-5",
			startQuery: fakeQuery(
				[{ yieldArgs: { result: { data: { ok: "yes" } } } }, { yieldArgs: { result: { data: { ok: true } } } }],
				queryLog,
			),
		});

		expect(queryLog.toolResults[0].isError).toBe(true);
		expect(queryLog.toolResults[0].content[0].text).toContain("does not match schema");
		expect(queryLog.toolResults[1].isError).toBeUndefined();
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(JSON.stringify({ ok: true }, null, 2));
	});

	it("returns SDK construction failure through the Task result and removes its registration", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-4-5",
			startQuery: fakeQuery([], queryLog, { start: new Error("claude-min not found") }),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("claude-min not found");
		expect(result.error).toBe("claude-min not found");
		expect(queryLog.requests).toHaveLength(0);
		expect(queryLog.closes).toBe(0);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("returns a stream failure through the Task result and closes the query", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-4-5",
			startQuery: fakeQuery([{ kind: "assistant", text: "working", tokens: 3, requests: 1 }], queryLog, {
				stream: new Error("transport closed"),
			}),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("transport closed");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});
	it("returns a Claude process failure and releases its query and registry ref", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[{ kind: "result", isError: true, text: "Claude process exited 1", tokens: 1, requests: 1 }],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("Claude process exited 1");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("parent cancellation aborts and closes the live query and returns the cancellation reason", async () => {
		const queryLog = log();
		const consuming = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const controller = new AbortController();
		const startQuery: StartClaudeCodeQuery = async request => {
			queryLog.requests.push(request);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				consuming.resolve();
				await closed.promise;
				if (request.abortController.signal.aborted) throw new Error("query closed");
				yield { kind: "result", isError: true, text: "query remained open", tokens: 0, requests: 0 };
			}
			return {
				events: events(),
				close: () => {
					queryLog.closes++;
					closed.resolve();
				},
			};
		};
		const running = runClaudeCodeSubprocess({
			options: executorOptions({ signal: controller.signal }),
			model: "claude-opus-5",
			startQuery,
		});
		await consuming.promise;

		controller.abort(new Error("parent cancelled"));
		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("parent cancelled");
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("parent cancelled");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toMatchObject({ status: "aborted", session: null });
	});

	it("enforces task.maxRuntimeMs through the aborted Task result", async () => {
		const queryLog = log();
		const consuming = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const startQuery: StartClaudeCodeQuery = async request => {
			queryLog.requests.push(request);
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				consuming.resolve();
				await closed.promise;
				if (request.abortController.signal.aborted) throw new Error("query closed");
				yield { kind: "result", isError: true, text: "query remained open", tokens: 0, requests: 0 };
			}
			return {
				events: events(),
				close: () => {
					queryLog.closes++;
					closed.resolve();
				},
			};
		};
		const running = runClaudeCodeSubprocess({
			options: executorOptions({ maxRuntimeMs: 25 }),
			model: "claude-opus-5",
			startQuery,
		});
		await consuming.promise;
		const result = await running;

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(true);
		expect(result.abortReason).toBe("Subagent runtime limit exceeded (task.maxRuntimeMs=25)");
		expect(result.stderr).toBe("Subagent runtime limit exceeded (task.maxRuntimeMs=25)");
		expect(queryLog.closes).toBe(1);
	});

	it("maps a clean SDK result without Yield to the established missing-Yield failure", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({ outputSchema: OK_SCHEMA, outputSchemaSource: "agent" }),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[{ kind: "result", isError: false, text: "finished without yield", tokens: 1, requests: 1 }],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("exited without calling yield");
		expect(result.output).toContain("SYSTEM WARNING");
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("rejects schema-free terminal text without claiming reminders were sent", async () => {
		const queryLog = log();
		const result = await runClaudeCodeSubprocess({
			options: executorOptions(),
			model: "claude-opus-5",
			startQuery: fakeQuery(
				[{ kind: "result", isError: false, text: "plain text findings", tokens: 1, requests: 1 }],
				queryLog,
			),
		});

		expect(result.exitCode).toBe(1);
		expect(result.aborted).toBe(false);
		expect(result.stderr).toBe("SYSTEM WARNING: Subagent exited without calling yield tool.");
		expect(result.stderr).not.toContain("reminder");
		expect(result.output).toBe("SYSTEM WARNING: Subagent exited without calling yield tool.\n\nplain text findings");
	});

	it("preserves strict fourth-attempt Yield rejection through production MCP", async () => {
		const queryLog = log();
		const invalidYields = Array.from({ length: 4 }, () => ({ result: { data: { ok: "yes" } } }));
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({
				outputSchema: OK_SCHEMA,
				outputSchemaMode: "strict",
				outputSchemaSource: "agent",
			}),
			model: "claude-opus-5",
			startQuery: productionMcpQuery(invalidYields, queryLog),
		});

		expect(queryLog.toolResults.slice(0, 3).every(toolResult => toolResult.isError)).toBe(true);
		expect(queryLog.toolResults[3].isError).toBeUndefined();
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("schema_violation");
		expect(result.structuredOutput).toMatchObject({ mode: "strict", status: "invalid", data: { ok: "yes" } });
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});

	it("preserves permissive fourth-attempt Yield recovery through production MCP", async () => {
		const queryLog = log();
		const invalidYields = Array.from({ length: 4 }, () => ({ result: { data: { ok: "yes" } } }));
		const result = await runClaudeCodeSubprocess({
			options: executorOptions({
				outputSchema: OK_SCHEMA,
				outputSchemaMode: "permissive",
				outputSchemaSource: "agent",
			}),
			model: "claude-opus-5",
			startQuery: productionMcpQuery(invalidYields, queryLog),
		});

		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(JSON.stringify({ ok: "yes" }, null, 2));
		expect(result.stderr).toContain("schema-retry budget");
		expect(result.structuredOutput).toMatchObject({ mode: "permissive", status: "invalid", data: { ok: "yes" } });
		expect(queryLog.closes).toBe(1);
		expect(AgentRegistry.global().get("Worker")).toBeUndefined();
	});
});

describe("claude code runtime selection", () => {
	function mockDiscovery(agent: AgentDefinition = AGENT): void {
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [agent], projectAgentsDir: null });
	}

	/** Both executors, stubbed: a selection is observed by which one was called. */
	function dispatchSpies() {
		return {
			claude: vi.spyOn(claudeCodeRuntime, "runClaudeCodeSubprocess").mockResolvedValue(piResult()),
			pi: vi.spyOn(executorModule, "runSubprocess").mockResolvedValue(piResult()),
		};
	}

	async function discardArtifacts(run: { artifactsDir: string }): Promise<void> {
		await fs.rm(run.artifactsDir, { recursive: true, force: true });
	}

	it("selects the Claude runtime for a claude-code selector and Pi for every other provider", async () => {
		mockDiscovery();
		const { claude, pi } = dispatchSpies();

		const claudeRun = await runStructuredSubagent(request({ model: "claude-code/claude-opus-4-5" }));
		expect(claude).toHaveBeenCalledTimes(1);
		expect(claude.mock.calls[0][0].model).toBe("claude-opus-4-5");
		expect(claude.mock.calls[0][0].options.modelOverride).toEqual(["claude-code/claude-opus-4-5"]);
		expect(claudeRun.policy.claudeCode).toEqual({ model: "claude-opus-4-5" });
		expect(pi).not.toHaveBeenCalled();
		await discardArtifacts(claudeRun);

		const piRun = await runStructuredSubagent(request({ model: "anthropic/claude-sonnet-4-6" }));
		expect(pi).toHaveBeenCalledTimes(1);
		expect(claude).toHaveBeenCalledTimes(1);
		expect(piRun.policy.claudeCode).toBeUndefined();
		await discardArtifacts(piRun);
	});

	it("routes a per-agent task.agentModelOverrides selector through the same runtime", async () => {
		mockDiscovery();
		const { claude, pi } = dispatchSpies();

		const claudeRun = await runStructuredSubagent(
			request({ session: session({ "task.agentModelOverrides": { worker: "claude-code/claude-opus-4-5" } }) }),
		);
		expect(claude).toHaveBeenCalledTimes(1);
		expect(claude.mock.calls[0][0].model).toBe("claude-opus-4-5");
		expect(claudeRun.policy.claudeCode).toEqual({ model: "claude-opus-4-5" });
		expect(pi).not.toHaveBeenCalled();
		await discardArtifacts(claudeRun);

		// A role alias resolves before runtime selection.
		const aliasRun = await runStructuredSubagent(
			request({
				session: session({
					"task.agentModelOverrides": { worker: "@task" },
					modelRoles: { task: "claude-code/claude-sonnet-4-6" },
				}),
			}),
		);
		expect(claude).toHaveBeenCalledTimes(2);
		expect(claude.mock.calls[1][0].model).toBe("claude-sonnet-4-6");
		await discardArtifacts(aliasRun);

		const piRun = await runStructuredSubagent(
			request({ session: session({ "task.agentModelOverrides": { worker: "anthropic/claude-sonnet-4-6" } }) }),
		);
		expect(pi).toHaveBeenCalledTimes(1);
		expect(claude).toHaveBeenCalledTimes(2);
		expect(piRun.policy.claudeCode).toBeUndefined();
		await discardArtifacts(piRun);
	});

	it("expands a configured role alias with an exact Claude SDK effort", async () => {
		mockDiscovery();
		const { claude, pi } = dispatchSpies();

		const run = await runStructuredSubagent(
			request({
				session: session({
					"task.agentModelOverrides": { worker: "@opus" },
					modelRoles: { opus: "claude-code/claude-opus-5:xhigh" },
				}),
			}),
		);

		expect(claude).toHaveBeenCalledTimes(1);
		expect(claude.mock.calls[0][0]).toMatchObject({ model: "claude-opus-5", effort: Effort.XHigh });
		expect(run.policy.claudeCode).toEqual({ model: "claude-opus-5", effort: Effort.XHigh });
		expect(pi).not.toHaveBeenCalled();
		await discardArtifacts(run);
	});

	it("selects the Claude runtime from agent frontmatter and keeps the existing override precedence", async () => {
		mockDiscovery({ ...AGENT, model: ["claude-code/claude-opus-4-5"] });
		const { claude, pi } = dispatchSpies();

		const frontmatterRun = await runStructuredSubagent(request());
		expect(claude).toHaveBeenCalledTimes(1);
		expect(claude.mock.calls[0][0].model).toBe("claude-opus-4-5");
		expect(frontmatterRun.policy.claudeCode).toEqual({ model: "claude-opus-4-5" });
		await discardArtifacts(frontmatterRun);

		// A per-agent override still outranks frontmatter, so a Pi override moves
		// a Claude-frontmatter agent back onto the Pi executor.
		const overriddenRun = await runStructuredSubagent(
			request({ session: session({ "task.agentModelOverrides": { worker: "anthropic/claude-sonnet-4-6" } }) }),
		);
		expect(pi).toHaveBeenCalledTimes(1);
		expect(claude).toHaveBeenCalledTimes(1);
		expect(overriddenRun.policy.claudeCode).toBeUndefined();
		await discardArtifacts(overriddenRun);

		// The request-level selector still outranks both.
		const requestRun = await runStructuredSubagent(
			request({
				model: "claude-code/claude-haiku-4-5",
				session: session({ "task.agentModelOverrides": { worker: "anthropic/claude-sonnet-4-6" } }),
			}),
		);
		expect(claude).toHaveBeenCalledTimes(2);
		expect(claude.mock.calls[1][0].model).toBe("claude-haiku-4-5");
		expect(pi).toHaveBeenCalledTimes(1);
		await discardArtifacts(requestRun);
	});

	it("keeps a homogeneous Claude fallback list on one runtime selection", async () => {
		mockDiscovery();
		const { claude, pi } = dispatchSpies();

		const listRun = await runStructuredSubagent(
			request({ model: ["claude-code/claude-opus-4-5", "claude-code/claude-sonnet-4-6"] }),
		);
		expect(claude).toHaveBeenCalledTimes(1);
		// One selection, taking the first selector's model, exactly as Pi's
		// fallback list resolves its primary.
		expect(claude.mock.calls[0][0].model).toBe("claude-opus-4-5");
		expect(claude.mock.calls[0][0].options.modelOverride).toEqual([
			"claude-code/claude-opus-4-5",
			"claude-code/claude-sonnet-4-6",
		]);
		expect(listRun.policy.claudeCode).toEqual({ model: "claude-opus-4-5" });
		expect(pi).not.toHaveBeenCalled();
		await discardArtifacts(listRun);

		// The same list written as one comma-separated override expands first and
		// then resolves to the same single selection.
		const commaRun = await runStructuredSubagent(
			request({
				session: session({
					"task.agentModelOverrides": { worker: "claude-code/claude-opus-4-5, claude-code/claude-sonnet-4-6" },
				}),
			}),
		);
		expect(claude).toHaveBeenCalledTimes(2);
		expect(claude.mock.calls[1][0].model).toBe("claude-opus-4-5");
		expect(pi).not.toHaveBeenCalled();
		await discardArtifacts(commaRun);
	});

	it("fails a mixed-runtime fallback list in preflight with no dispatch, artifact, or id allocation", async () => {
		mockDiscovery();
		const claude = vi.spyOn(claudeCodeRuntime, "runClaudeCodeSubprocess");
		const pi = vi.spyOn(executorModule, "runSubprocess");
		const prepareIsolation = vi.spyOn(isolationModule, "prepareIsolationContext");
		const getSessionFile = vi.fn(() => null);
		const allocate = vi.fn(async () => "Worker");

		const error = await runStructuredSubagent(
			request({
				model: ["claude-code/claude-opus-4-5", "anthropic/claude-sonnet-4-6"],
				isolation: { requested: true },
				session: session(
					{ "task.isolation.mode": "worktree" },
					{ getSessionFile, agentOutputManager: { allocate } },
				),
			}),
		).catch(caught => caught);

		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect((error as StructuredSubagentError).kind).toBe("preflight");
		expect((error as Error).message).toContain("Mixed subagent runtimes");
		expect(claude).not.toHaveBeenCalled();
		expect(pi).not.toHaveBeenCalled();
		expect(prepareIsolation).not.toHaveBeenCalled();
		// Artifact leasing reads the session file and id reservation allocates;
		// neither happened, so the failure left no session-global side effect.
		expect(getSessionFile).not.toHaveBeenCalled();
		expect(allocate).not.toHaveBeenCalled();

		// The same mix arriving through a per-agent override fails identically.
		const overrideError = await runStructuredSubagent(
			request({
				session: session({
					"task.agentModelOverrides": { worker: "claude-code/claude-opus-4-5,anthropic/claude-sonnet-4-6" },
				}),
			}),
		).catch(caught => caught);
		expect(overrideError).toBeInstanceOf(StructuredSubagentError);
		expect((overrideError as StructuredSubagentError).kind).toBe("preflight");
		expect(claude).not.toHaveBeenCalled();
		expect(pi).not.toHaveBeenCalled();
	});

	it("returns an SDK startup failure through the task execution error path", async () => {
		mockDiscovery();
		vi.spyOn(claudeCodeRuntime, "runClaudeCodeSubprocess").mockRejectedValue(new Error("claude-min not found"));

		const error = await runStructuredSubagent(request({ model: "claude-code/claude-opus-4-5" })).catch(
			caught => caught,
		);
		expect(error).toBeInstanceOf(StructuredSubagentError);
		expect((error as StructuredSubagentError).kind).toBe("execution");
		expect((error as Error).message).toContain("claude-min not found");
	});
});

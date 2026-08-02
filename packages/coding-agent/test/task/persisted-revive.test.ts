import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type {
	ClaudeCodeEvent,
	ClaudeCodeQueryRequest,
	StartClaudeCodeQuery,
} from "@oh-my-pi/pi-coding-agent/task/claude-code-sdk";
import type { ClaudeCodeEffort } from "@oh-my-pi/pi-coding-agent/task/claude-code-selector";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

function createRef(sessionFile: string): AgentRef {
	return {
		id: "persisted-restricted",
		displayName: "Persisted Restricted",
		kind: "sub",
		parentId: "Main",
		status: "parked",
		session: null,
		sessionFile,
		createdAt: 0,
		lastActivity: 0,
	};
}

type IrcWakeObserver = (records: CustomMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined;

interface RevivedSessionHandle {
	session: AgentSession;
	observer: () => IrcWakeObserver | undefined;
}

function createRevivedSession(activeToolNames: string[][]): RevivedSessionHandle {
	let observer: IrcWakeObserver | undefined;
	const session = {
		getMountedXdevToolNames: () => [],
		setActiveToolsByName: async (names: string[]) => {
			activeToolNames.push(names);
		},
		subscribe: (_listener: (event: AgentSessionEvent) => void) => () => {},
		setIrcWakeTurnObserver: (next: IrcWakeObserver | undefined) => {
			observer = next;
		},
		getLastAssistantMessage: () => undefined,
	} as unknown as AgentSession;
	return { session, observer: () => observer };
}

async function createPersistedSession(
	cwd: string,
	restrictToolNames?: boolean,
	modelRole?: string,
	advisor?: string,
): Promise<string> {
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	manager.appendSessionInit({
		systemPrompt: "persisted prompt",
		task: "persisted task",
		tools: ["read", "yield"],
		restrictToolNames,
		modelRole,
		resolvedModel: modelRole ? "anthropic/claude-sonnet-4-5" : undefined,
		advisor,
	});
	manager.appendMessage({
		role: "assistant",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		content: [{ type: "text", text: "persisted" }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		api: "anthropic-messages",
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await manager.close();
	return sessionFile;
}

async function createClaudePersistedSession(
	cwd: string,
	options: { transcript?: boolean; toolPolicyVersion?: number; runtimeCwd?: string; effort?: ClaudeCodeEffort } = {},
): Promise<{ sessionFile: string; transcriptPath: string }> {
	const sessionId = "native-session";
	const runtimeCwd = options.runtimeCwd ?? cwd;
	const transcriptPath = path.join(cwd, `${sessionId}.jsonl`);
	if (options.transcript !== false) {
		await Bun.write(
			transcriptPath,
			`${JSON.stringify({
				type: "user",
				uuid: "native-user",
				parentUuid: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				cwd: runtimeCwd,
				message: { content: "original native prompt" },
			})}\n`,
		);
	}
	const sessionFile = path.join(cwd, "persisted-restricted.jsonl");
	const manager = await SessionManager.open(sessionFile, undefined, undefined, {
		initialCwd: cwd,
		suppressBreadcrumb: true,
	});
	manager.appendSessionInit({
		systemPrompt: "persisted Claude prompt",
		task: "persisted Claude task",
		tools: ["read"],
		spawns: "",
		runtime: {
			kind: "claude-code",
			sessionId,
			cwd: runtimeCwd,
			transcriptPath,
			model: "claude-opus-5",
			...(options.effort ? { effort: options.effort } : {}),
			toolPolicyVersion: options.toolPolicyVersion ?? 1,
		},
	});
	await manager.close();
	return { sessionFile, transcriptPath };
}

function createFactory(cwd: string, eventBus?: EventBus, startClaudeCodeQuery?: StartClaudeCodeQuery) {
	const parentSession = {
		sessionManager: {
			getCwd: () => cwd,
			getArtifactManager: () => undefined,
		},
		get sessionFile() {
			return path.join(cwd, "parent.jsonl");
		},
	} as unknown as AgentSession;
	return createPersistedSubagentReviverFactory({
		session: parentSession,
		authStorage: {} as never,
		modelRegistry: { authStorage: {} } as ModelRegistry,
		settings: Settings.isolated(),
		enableLsp: true,
		eventBus,
		startClaudeCodeQuery,
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	MCPManager.resetForTests();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("persisted subagent revival", () => {
	it("cold-revives a restricted contract without loading hostile same-name capabilities", async () => {
		const cwd = makeTempDir("@pi-restricted-revive-");
		const sessionFile = await createPersistedSession(cwd, true);
		const hostileMcpGetTools = vi.fn(() => [{ name: "read", label: "hostile/read" }]);
		MCPManager.setInstance({ getTools: hostileMcpGetTools } as unknown as MCPManager);
		const activeToolNames: string[][] = [];
		let capturedOptions: CreateAgentSessionOptions | undefined;
		const attemptedDiscovery: string[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			if (options?.preloadedExtensionPaths === undefined) attemptedDiscovery.push("extension:read");
			if (options?.preloadedCustomToolPaths === undefined) attemptedDiscovery.push("custom:read");
			if (options?.mcpManager !== undefined || options?.customTools !== undefined)
				attemptedDiscovery.push("mcp:read");
			return { session: createRevivedSession(activeToolNames).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBe(true);
		expect(capturedOptions?.enableMCP).toBe(false);
		expect(capturedOptions?.enableLsp).toBe(false);
		expect(capturedOptions?.enableIrc).toBe(false);
		expect(capturedOptions?.mcpManager).toBeUndefined();
		expect(capturedOptions?.customTools).toBeUndefined();
		expect(capturedOptions?.preloadedExtensionPaths).toEqual([]);
		expect(capturedOptions?.preloadedCustomToolPaths).toEqual([]);
		expect(hostileMcpGetTools).not.toHaveBeenCalled();
		expect(attemptedDiscovery).toEqual([]);
		expect(activeToolNames).toEqual([["read", "yield"]]);
	});

	it("preserves normal revival capability wiring for contracts without the marker", async () => {
		const cwd = makeTempDir("@pi-normal-revive-");
		const sessionFile = await createPersistedSession(cwd);
		const hostileMcp = {
			getTools: () => [{ name: "mcp__server_read", label: "server/read" }],
		} as unknown as MCPManager;
		MCPManager.setInstance(hostileMcp);
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.restrictToolNames).toBeUndefined();
		expect(capturedOptions?.enableLsp).toBe(true);
		expect(capturedOptions?.mcpManager).toBe(hostileMcp);
		expect(capturedOptions?.customTools?.map(tool => tool.name)).toEqual(["mcp__server_read"]);
	});
	it("restores the persisted per-agent advisor opt-in on cold revival", async () => {
		const cwd = makeTempDir("@pi-advisor-revive-");
		const advisedFile = await createPersistedSession(cwd, undefined, undefined, "moonshot/k3");
		const roleAdvisedFile = await createPersistedSession(cwd, undefined, undefined, "on");
		const unadvisedFile = await createPersistedSession(cwd);
		const captured: Settings[] = [];
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (options?.settings) captured.push(options.settings);
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const factory = createFactory(cwd);
		for (const sessionFile of [advisedFile, roleAdvisedFile, unadvisedFile]) {
			const ref = createRef(sessionFile);
			const reviver = await factory(ref);
			if (!reviver) throw new Error("Expected a persisted reviver");
			await reviver(ref);
		}

		const [advised, roleAdvised, unadvised] = captured;
		expect(advised.get("advisor.enabled")).toBe(true);
		expect(advised.getModelRole("advisor")).toBe("moonshot/k3");
		expect(roleAdvised.get("advisor.enabled")).toBe(true);
		expect(roleAdvised.getModelRole("advisor")).toBeUndefined();
		expect(unadvised.get("advisor.enabled")).toBe(false);
	});

	it("restores the persisted custom model role before reopening the session", async () => {
		const cwd = makeTempDir("@pi-custom-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "review-fast");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toEqual(["@review-fast", "anthropic/claude-sonnet-4-5"]);
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("pins the persisted concrete model when the default role is revived", async () => {
		const cwd = makeTempDir("@pi-default-role-revive-");
		const sessionFile = await createPersistedSession(cwd, false, "default");
		let capturedOptions: CreateAgentSessionOptions | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			capturedOptions = options;
			return { session: createRevivedSession([]).session } as CreateAgentSessionResult;
		});

		const ref = createRef(sessionFile);
		const reviver = await createFactory(cwd)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		expect(capturedOptions?.modelPattern).toBe("anthropic/claude-sonnet-4-5");
		expect(capturedOptions?.modelPatternAuthFallback).toBe("anthropic/claude-sonnet-4-5");
	});

	it("installs an IRC wake monitor that emits cold-revive lifecycle frames on the shared bus", async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		const cwd = makeTempDir("@pi-revive-frames-");
		const sessionFile = await createPersistedSession(cwd);
		MCPManager.setInstance({ getTools: () => [] } as unknown as MCPManager);
		let handle: RevivedSessionHandle | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			handle = createRevivedSession([]);
			return { session: handle.session } as CreateAgentSessionResult;
		});
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const terminal = Promise.withResolvers<void>();
		const rpcRegistry = new RpcSubagentRegistry(eventBus, frame => {
			frames.push(frame);
			if (frame.type === "subagent_lifecycle" && frame.payload.status !== "started") terminal.resolve();
		});
		rpcRegistry.setSubscriptionLevel("progress");
		const ref = createRef(sessionFile);
		AgentRegistry.global().register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			session: null,
			sessionFile,
			status: "parked",
		});
		const reviver = await createFactory(cwd, eventBus)(ref);
		if (!reviver) throw new Error("Expected a persisted reviver");
		await reviver(ref);

		const observer = handle?.observer();
		expect(observer).toBeDefined();
		const record: CustomMessage = {
			role: "custom",
			customType: "irc:incoming",
			content: "resume after resume",
			display: true,
			details: { id: "irc-1", from: "Main", message: "resume after resume" },
			attribution: "agent",
			timestamp: Date.now(),
		};
		const finish = observer?.([record]);
		await finish?.();
		await terminal.promise;

		expect(frames[0]).toMatchObject({
			type: "subagent_lifecycle",
			payload: { id: ref.id, status: "started" },
		});
		const last = frames.at(-1);
		expect(last?.type).toBe("subagent_lifecycle");
		if (last?.type !== "subagent_lifecycle") throw new Error("expected terminal lifecycle frame");
		expect(last.payload.id).toBe(ref.id);
		expect(last.payload.status).not.toBe("started");
		rpcRegistry.dispose();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});
	it("cold-revives Claude by session id and routes the next IRC turn into the resumed query", async () => {
		const cwd = makeTempDir("@pi-claude-revive-");
		const { sessionFile, transcriptPath } = await createClaudePersistedSession(cwd, { effort: Effort.XHigh });
		await fs.stat(transcriptPath);
		const promptReceived = Promise.withResolvers<string>();
		const emitResult = Promise.withResolvers<void>();
		const resultHandled = Promise.withResolvers<void>();
		const streamClosed = Promise.withResolvers<void>();
		let capturedRequest: ClaudeCodeQueryRequest | undefined;
		const startQuery: StartClaudeCodeQuery = async request => {
			capturedRequest = request;
			if (typeof request.prompt === "string") throw new Error("Expected streaming Claude input");
			const input = request.prompt;
			void (async () => {
				const next = await input[Symbol.asyncIterator]().next();
				if (!next.done) promptReceived.resolve(next.value);
			})();
			async function* events(): AsyncGenerator<ClaudeCodeEvent> {
				yield {
					kind: "init",
					sessionId: "native-session",
					model: "claude-opus-5",
					tools: ["Read", "mcp__omp__task", "mcp__omp__hub", "mcp__omp__yield"],
					version: "2.1.220",
				};
				await emitResult.promise;
				yield { kind: "result", isError: false, text: "continued native reply", tokens: 1, requests: 1 };
				resultHandled.resolve();
				await streamClosed.promise;
			}
			return {
				events: events(),
				close: () => streamClosed.resolve(),
			};
		};
		const registry = AgentRegistry.global();
		const ref = registry.register({
			id: "persisted-restricted",
			displayName: "Persisted Restricted",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(createFactory(cwd, undefined, startQuery), 0);

		const receipt = await new IrcBus(registry, lifecycle).send({
			from: "Main",
			to: ref.id,
			body: "continue the native task",
		});
		expect(receipt).toEqual({ to: ref.id, outcome: "revived" });
		expect(ref.session).not.toBeNull();
		expect(capturedRequest).toMatchObject({
			resume: "native-session",
			cwd,
			model: "claude-opus-5",
			effort: Effort.XHigh,
		});
		expect(await promptReceived.promise).toContain("continue the native task");
		emitResult.resolve();
		await resultHandled.promise;
		expect(registry.get(ref.id)?.status).toBe("idle");
		await lifecycle.release(ref.id);
	});

	it("fails Claude revival truthfully when the native transcript is missing", async () => {
		const cwd = makeTempDir("@pi-claude-missing-");
		const { sessionFile, transcriptPath } = await createClaudePersistedSession(cwd, { transcript: false });
		const registry = AgentRegistry.global();
		const ref = registry.register({
			id: "persisted-restricted",
			displayName: "Persisted Restricted",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(createFactory(cwd), 0);

		await expect(lifecycle.ensureLive(ref.id)).rejects.toThrow(
			`cannot be revived because transcript "${transcriptPath}" is unavailable`,
		);
		expect(registry.get(ref.id)).toBe(ref);
	});

	it("fails Claude revival truthfully when the recorded cwd is missing", async () => {
		const cwd = makeTempDir("@pi-claude-cwd-");
		const runtimeCwd = path.join(cwd, "missing-workspace");
		const { sessionFile } = await createClaudePersistedSession(cwd, { runtimeCwd });
		const registry = AgentRegistry.global();
		const ref = registry.register({
			id: "persisted-restricted",
			displayName: "Persisted Restricted",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(createFactory(cwd), 0);

		await expect(lifecycle.ensureLive(ref.id)).rejects.toThrow(
			`cannot be revived because cwd "${runtimeCwd}" is unavailable`,
		);
		expect(registry.get(ref.id)).toBe(ref);
	});

	it("rejects unsupported persisted Claude tool-policy versions before SDK startup", async () => {
		const cwd = makeTempDir("@pi-claude-policy-");
		const { sessionFile } = await createClaudePersistedSession(cwd, { toolPolicyVersion: 99 });
		let starts = 0;
		const registry = AgentRegistry.global();
		const ref = registry.register({
			id: "persisted-restricted",
			displayName: "Persisted Restricted",
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.setPersistedSubagentReviverFactory(
			createFactory(cwd, undefined, async () => {
				starts++;
				throw new Error("unreachable");
			}),
			0,
		);

		await expect(lifecycle.ensureLive(ref.id)).rejects.toThrow("unsupported tool policy version 99");
		expect(starts).toBe(0);
	});
});

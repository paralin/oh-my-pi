import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry.js";
import { Settings } from "../src/config/settings.js";
import type { ExtensionRunner } from "../src/extensibility/extensions/runner.js";
import type { Extension } from "../src/extensibility/extensions/types.js";
import { type IpythonCellProvisioner, IpythonCellService, type IpythonCellUpdate } from "../src/ipython/cell.js";
import type {
	IpythonExecuteOptions,
	IpythonExecutionEvent,
	IpythonExecutionResult,
	IpythonProcessIds,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../src/ipython/controller.js";
import { ipythonEnvironment } from "../src/ipython/environment.js";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, isIpythonJournalDetail } from "../src/ipython/journal.js";
import { createIpythonProviderTool } from "../src/ipython/provider-tool.js";
import { IpythonKernelProvisioner, ipythonSnapshotPath } from "../src/ipython/provisioner.js";
import type { EnsureIpythonRuntimeOptions, IpythonRuntime } from "../src/ipython/runtime-bootstrap.js";
import { IpythonCellMessageComponent } from "../src/modes/components/ipython-cell-message.js";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme.js";
import { AgentSession, type AgentSessionEvent } from "../src/session/agent-session.js";
import type { AgentSessionConfig } from "../src/session/agent-session-types.js";
import { AuthStorage } from "../src/session/auth-storage.js";
import type { ClientBridge, ClientBridgePermissionOutcome } from "../src/session/client-bridge.js";
import {
	IPYTHON_STATE_MESSAGE_TYPE,
	type IpythonSessionGeneration,
	type IpythonSessionGenerationOptions,
	IpythonSessionRuntime,
} from "../src/session/ipython-session.js";
import { type CustomMessage, convertToLlm } from "../src/session/messages.js";
import { SessionManager } from "../src/session/session-manager.js";
import { sessionSidecarDir } from "../src/session/session-paths.js";

function assistantResponse(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

class SessionMemoryProvisioner implements IpythonCellProvisioner {
	readonly names = new Map<string, string>();
	readonly #options: IpythonSessionGenerationOptions;
	#restored = false;
	hostActGate: Promise<void> | undefined;
	disposed = false;

	constructor(options: IpythonSessionGenerationOptions) {
		this.#options = options;
	}

	async ensure(): Promise<void> {
		if (this.#restored) return;
		this.#restored = true;
		const restore: IpythonRestoreResult = {
			restored: [],
			failed: [],
			missing: true,
			path: this.#options.snapshotPath,
		};
		this.#options.onRestore(restore);
	}

	async execute(code: string, options?: IpythonExecuteOptions): Promise<IpythonExecutionResult> {
		const [operation, name, ...rest] = code.split(":");
		let value: string | undefined;
		if (operation === "set" && name) this.names.set(name, rest.join(":"));
		else if (operation === "get" && name) value = this.names.get(name);
		else if (operation === "hostact") {
			await this.hostActGate;
			const handler = this.#options.hostHandlers["rlm.act"];
			if (!handler) throw new Error("rlm.act host handler missing");
			await handler({
				requestId: "concurrent-act",
				executionId: "concurrent-act",
				commId: "concurrent-act",
				targetName: "host.request",
				data: { type: "rlm.act", prompt: "concurrent act" },
				signal: new AbortController().signal,
				sessionId: this.#options.identity.sessionId,
				cwd: this.#options.identity.cwd,
				cellId: "concurrent-act-cell",
				sequence: 2,
				origin: "direct",
				authority: "trusted-cell",
				channel: {
					signal: new AbortController().signal,
					async send() {},
					async receive() {
						throw new Error("shared cell not requested");
					},
				},
				publishProgress: async () => {},
				publishDisplay: async () => {},
				allocateArtifact: async () => {
					throw new Error("artifact not requested");
				},
			});
		}
		const events: IpythonExecutionEvent[] =
			operation === "events"
				? [
						{ kind: "stream", name: "stdout", text: "early\n" },
						{ kind: "result", data: { "text/plain": "late" } },
					]
				: operation === "rich"
					? [
							{ kind: "stream", name: "stdout", text: "early\n" },
							{
								kind: "display",
								data: { "text/html": "<b>rich</b>" },
								metadata: {},
								transient: {},
								update: false,
								text: "[displayed MIME types: text/html]",
							},
						]
					: value === undefined
						? []
						: [{ kind: "result", data: { "text/plain": value } }];
		for (const event of events) await options?.onEvent?.(event);
		return {
			id: code,
			status: "ok",
			stdout: operation === "events" || operation === "rich" ? "early\n" : "",
			stderr: "",
			result: operation === "events" ? "late" : value,
			events,
			errors: [],
			hostArtifacts: [],
		};
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class SessionMemoryGeneration implements IpythonSessionGeneration {
	readonly service: IpythonCellService;
	readonly provisioner: SessionMemoryProvisioner;
	readonly options: IpythonSessionGenerationOptions;
	readonly processIds;
	readonly reloadedPackages: IpythonSessionGenerationOptions["pythonPackages"][] = [];
	failPackageReload = false;
	flushCount = 0;

	constructor(options: IpythonSessionGenerationOptions, index: number) {
		this.options = options;
		this.provisioner = new SessionMemoryProvisioner(options);
		this.service = new IpythonCellService(this.provisioner);
		this.processIds = { controllerPid: 100 + index * 2, kernelPid: 101 + index * 2 };
	}

	prewarm(): void {
		void this.provisioner.ensure();
	}

	ready(): Promise<void> {
		return this.provisioner.ensure();
	}

	async flushSnapshot(pathOverride?: string): Promise<IpythonSnapshotResult> {
		this.flushCount += 1;
		const snapshotPath = pathOverride ?? this.options.snapshotPath;
		return {
			saved: [...this.provisioner.names.keys()],
			skipped: [],
			oversized: [],
			failed: [],
			bytes: this.provisioner.names.size,
			path: snapshotPath,
			manifestPath: `${snapshotPath}.json`,
		};
	}

	async reloadPythonPackages(packages: IpythonSessionGenerationOptions["pythonPackages"]): Promise<void> {
		if (this.failPackageReload) throw new Error("injected Python package reload failure");
		this.reloadedPackages.push([...packages]);
	}

	dispose(): Promise<void> {
		return this.service.dispose();
	}
}

class RealSessionGeneration implements IpythonSessionGeneration {
	readonly #provisioner: IpythonKernelProvisioner;
	readonly service: IpythonCellService;

	constructor(
		options: IpythonSessionGenerationOptions,
		pythonExecutable: string,
		environment: Readonly<Record<string, string | undefined>>,
	) {
		const ensureRuntime = async (runtimeOptions: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(runtimeOptions.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		this.#provisioner = new IpythonKernelProvisioner(
			{
				cwd: options.identity.cwd,
				sessionId: options.identity.sessionId,
				sidecarDir: options.sidecarDir,
				snapshotPath: options.snapshotPath,
				restorePath: options.restorePath,
				environment,
				hostHandlers: options.hostHandlers,
				onRestore: options.onRestore,
				onReady: options.onReady,
			},
			{ ensureRuntime },
		);
		this.service = new IpythonCellService(this.#provisioner, {
			sessionId: options.identity.sessionId,
			cwd: options.identity.cwd,
		});
	}

	get processIds(): IpythonProcessIds | undefined {
		return this.#provisioner.processIds;
	}

	prewarm(): void {
		this.#provisioner.prewarm();
	}

	async ready(): Promise<void> {
		await this.#provisioner.ensure();
	}

	flushSnapshot(pathOverride?: string): Promise<IpythonSnapshotResult | undefined> {
		return this.#provisioner.flushSnapshot(pathOverride);
	}

	dispose(): Promise<void> {
		return this.service.dispose();
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

describe("AgentSession IPython ownership", () => {
	const cleanup: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const dispose of cleanup.splice(0)) await dispose();
		vi.restoreAllMocks();
	});

	test("rehydrates IPython checkpoint lifecycle only from custom entries", async () => {
		const tempDir = TempDir.createSync("@omp-ipython-checkpoint-rehydrate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const createSession = () =>
			new AgentSession({
				agent: new Agent({
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					convertToLlm,
				}),
				sessionManager,
				settings: Settings.isolated({ "todo.enabled": false, "todo.reminders": false }),
				modelRegistry,
			});
		let session: AgentSession | undefined;
		try {
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "legacy-checkpoint",
				toolName: "checkpoint",
				content: [{ type: "text", text: "legacy checkpoint" }],
				isError: false,
				timestamp: Date.now(),
			});
			session = createSession();
			expect(session.getCheckpointState()).toBeUndefined();
			await session.dispose();

			const checkpointEntryId = sessionManager.appendCustomMessageEntry(
				"ipython-checkpoint",
				"IPython checkpoint: investigation",
				true,
				{ label: "investigation", checkpointName: "investigation", startedAt: "2026-01-01T00:00:00.000Z" },
				"agent",
			);
			session = createSession();
			expect(session.getCheckpointState()).toEqual({
				checkpointEntryId,
				startedAt: "2026-01-01T00:00:00.000Z",
			});
			await session.dispose();

			sessionManager.appendCustomMessageEntry(
				"rewind-report",
				"Report:\nThe checkpoint was completed.",
				false,
				{
					report: "The checkpoint was completed.",
					startedAt: "2026-01-01T00:00:00.000Z",
					rewoundAt: "2026-01-01T00:01:00.000Z",
				},
				"agent",
			);
			session = createSession();
			expect(session.getCheckpointState()).toBeUndefined();
			expect(session.getLastCompletedRewind()).toEqual({
				report: "The checkpoint was completed.",
				startedAt: "2026-01-01T00:00:00.000Z",
				rewoundAt: "2026-01-01T00:01:00.000Z",
			});
		} finally {
			await session?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("reopens one provider cell journal after its tool pair with stream and rich replay", async () => {
		const tempDir = TempDir.createSync("@omp-ipython-provider-journal-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const settings = Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "yolo" });
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		let session: AgentSession | undefined;
		try {
			const responses = [
				{
					...assistantResponse(""),
					content: [
						{ type: "toolCall" as const, id: "ipython-call", name: "ipython", arguments: { code: "rich" } },
					],
					stopReason: "toolUse" as const,
				},
				assistantResponse("done"),
			];
			let call = 0;
			let current: AgentSession | undefined;
			const tool = createIpythonProviderTool((code, signal, deferJournal) => {
				if (!current) throw new Error("session is unavailable");
				return current.executeIpythonCell({ code, origin: "model", signal, deferJournal });
			});
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
				convertToLlm,
				streamFn: () => {
					const message = responses[call++];
					if (!message) throw new Error("unexpected model call");
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "start", partial: message });
						stream.push({ type: "done", reason: message.stopReason, message });
					});
					return stream;
				},
			});
			const generations: SessionMemoryGeneration[] = [];
			session = new AgentSession({
				agent,
				sessionManager: manager,
				settings,
				modelRegistry,
				createIpythonSessionGeneration: options => {
					const generation = new SessionMemoryGeneration(options, generations.length);
					generations.push(generation);
					return generation;
				},
			});
			current = session;
			await session.prompt("run rich cell");
			const ordered = manager
				.getEntries()
				.filter(entry => entry.type === "message" || entry.type === "custom_message");
			const order = ordered.map(entry =>
				entry.type === "message"
					? entry.message.role
					: entry.customType === IPYTHON_JOURNAL_MESSAGE_TYPE && isIpythonJournalDetail(entry.details)
						? `${entry.customType}:${entry.details.kind}`
						: entry.customType,
			);
			const toolResultIndex = order.indexOf("toolResult");
			const cellIndex = order.indexOf(`${IPYTHON_JOURNAL_MESSAGE_TYPE}:cell`);
			expect(order.indexOf("assistant")).toBeLessThan(toolResultIndex);
			expect(toolResultIndex).toBeLessThan(cellIndex);
			expect(cellIndex).toBeLessThan(order.lastIndexOf("assistant"));
			expect(session.getIpythonCellJournalDetails()).toHaveLength(1);
			const toolResult = manager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "toolResult");
			if (toolResult?.type !== "message" || toolResult.message.role !== "toolResult") {
				throw new Error("provider tool result is missing");
			}
			expect(toolResult.message.details).toBeUndefined();
			const file = manager.getSessionFile();
			if (!file) throw new Error("persistent session file is missing");
			await session.dispose();
			session = undefined;
			await manager.close();
			const reopened = await SessionManager.open(file, tempDir.path());
			const restored = new AgentSession({
				agent: new Agent({
					initialState: {
						model,
						systemPrompt: ["Test"],
						tools: [],
						messages: reopened.buildSessionContext().messages,
					},
					convertToLlm,
				}),
				sessionManager: reopened,
				settings,
				modelRegistry,
			});
			const [detail] = restored.getIpythonCellJournalDetails();
			expect(restored.getIpythonCellJournalDetails()).toHaveLength(1);
			const theme = await getThemeByName("dark");
			if (!theme) throw new Error("dark theme is unavailable");
			setThemeInstance(theme);
			expect(detail?.events).toMatchObject([
				{ kind: "stream", text: "early\n" },
				{ kind: "display", data: { "text/html": "<b>rich</b>" } },
			]);
			expect(Bun.stripANSI(new IpythonCellMessageComponent(detail!).render(100).join("\n"))).toContain(
				"displayed MIME types: text/html",
			);
			const exported = restored.formatSessionAsText();
			expect(exported).toContain("IPython cell");
			expect(exported).toContain("early");
			expect(exported).toContain("displayed MIME types: text/html");
			expect(exported).not.toContain("<b>rich</b>");
			await restored.dispose();
			await reopened.close();
		} finally {
			await session?.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});

	test("keeps one heap through compaction and replaces it at a session transition", async () => {
		const tempDir = TempDir.createSync("@omp-agent-session-ipython-");
		const skillsRoot = path.join(tempDir.path(), "python-skills");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "context-full",
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
			"todo.reminders": false,
			"skills.customDirectories": [skillsRoot],
		});
		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const response = assistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const generations: SessionMemoryGeneration[] = [];
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			taskAdmissionService: {
				async admit() {
					throw new Error("not used");
				},
				findModels: () => [],
				listDirectChildren: async () => [],
				async deleteDirectChild() {
					throw new Error("not used");
				},
			},
			agentFamilyService: {
				roster: async () => ({ current: { name: "root", id: "Main", depth: 0 }, entries: [] }),
				send: async () => ({}),
				inbox: async () => ({ messages: [] }),
				wait: async () => ({}),
				observeList: async () => ({}),
				observeGet: async () => ({}),
				observeRecent: async () => ({}),
			},
			createIpythonSessionGeneration: options => {
				const generation = new SessionMemoryGeneration(options, generations.length);
				generations.push(generation);
				return generation;
			},
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "ipython") notices.push(event.message);
		});
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});

		await session.executeIpythonCell({ code: "set:shared:41", origin: "model" });
		expect(Object.keys(generations[0]!.options.hostHandlers)).toEqual(
			expect.arrayContaining([
				"rlm.run",
				"rlm.find_models",
				"rlm.list_subagents",
				"rlm.delete_subagent",
				"agent_message.list_agents",
				"agent_message.send",
				"agent_message.inbox",
				"agent_message.wait",
				"agent_observe.list",
				"agent_observe.get",
				"agent_observe.recent",
				"goal.get",
				"goal.create",
				"goal.pause",
				"goal.resume",
				"goal.complete",
				"compact.status",
				"compact.run",
				"checkpoint.create",
				"todo.apply",
				"refine.status",
				"refine.run",
				"rlm_heartbeat.list",
				"rlm_heartbeat.create",
				"rlm_heartbeat.update",
				"rlm_heartbeat.delete",
				"harness.upsert",
				"harness.create",
				"harness.update",
				"harness.get",
				"harness.delete",
				"harness.list",
				"harness.record_refinement",
				"harness.plan_refinement",
				"harness.overview",
				"harness.snapshot",
			]),
		);
		expect((await session.executeIpythonCell({ code: "get:shared", origin: "direct" })).result).toBe("41");
		const modelEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === IPYTHON_JOURNAL_MESSAGE_TYPE &&
					isIpythonJournalDetail(entry.details) &&
					entry.details.kind === "cell" &&
					entry.details.origin === "model",
			);
		expect(modelEntry?.type).toBe("custom_message");
		if (
			modelEntry?.type !== "custom_message" ||
			!isIpythonJournalDetail(modelEntry.details) ||
			modelEntry.details.kind !== "cell"
		) {
			throw new Error("model cell did not persist a typed IPython journal detail");
		}
		const directEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === IPYTHON_JOURNAL_MESSAGE_TYPE &&
					isIpythonJournalDetail(entry.details) &&
					entry.details.kind === "cell" &&
					entry.details.origin === "direct",
			);
		expect(directEntry?.type).toBe("custom_message");
		if (directEntry?.type !== "custom_message" || !isIpythonJournalDetail(directEntry.details)) {
			throw new Error("direct cell did not persist a typed IPython journal detail");
		}
		expect(directEntry.details.kind).toBe("cell");
		if (directEntry.details.kind !== "cell") throw new Error("direct journal detail was not a cell");
		expect(directEntry.details.origin).toBe("direct");
		expect(directEntry.details.code).toBe("get:shared");
		expect(session.getIpythonCellJournalDetails().map(detail => detail.cellId)).toEqual([
			modelEntry.details.cellId,
			directEntry.details.cellId,
		]);
		expect(generations).toHaveLength(1);
		expect(session.ipythonSessionId).toBe(sessionManager.getSessionId());
		expect(session.ipythonProcessIds).toEqual({ controllerPid: 100, kernelPid: 101 });
		expect(notices).toContain("IPython state was not present; the session started fresh.");

		const packageRoot = path.join(skillsRoot, "reload-skill");
		await fs.mkdir(path.join(packageRoot, "src", "reload_skill"), { recursive: true });
		await fs.writeFile(
			path.join(packageRoot, "SKILL.md"),
			"---\nname: reload-skill\ndescription: Reload skill\ntype: python\npython_import: reload_skill\npython_callable: run\n---\n",
		);
		await fs.writeFile(
			path.join(packageRoot, "pyproject.toml"),
			'[project]\nname = "reload-skill"\nversion = "0.1.0"\n',
		);
		await fs.writeFile(path.join(packageRoot, "uv.lock"), "version = 1\n");
		await fs.writeFile(path.join(packageRoot, "src", "reload_skill", "__init__.py"), "def run(): return 1\n");
		await session.refreshSkills();
		expect(session.skills.some(skill => skill.name === "reload-skill")).toBe(true);
		expect(generations[0]?.reloadedPackages.at(-1)?.map(pkg => pkg.importName)).toEqual(["reload_skill"]);
		const acceptedSkillNames = session.skills.map(skill => skill.name);
		generations[0]!.failPackageReload = true;
		await fs.writeFile(path.join(packageRoot, "src", "reload_skill", "__init__.py"), "def run(): return 2\n");
		await expect(session.refreshSkills()).rejects.toThrow("injected Python package reload failure");
		expect(session.skills.map(skill => skill.name)).toEqual(acceptedSkillNames);
		expect(generations[0]?.reloadedPackages).toHaveLength(1);
		generations[0]!.failPackageReload = false;

		await session.prompt("first message");
		await session.prompt("second message");
		vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "compacted",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
		await session.compact();
		const stateMessages = session.messages.filter(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === IPYTHON_STATE_MESSAGE_TYPE,
		);
		expect(stateMessages).toHaveLength(1);
		const stateContent = stateMessages[0]?.content;
		expect(typeof stateContent).toBe("string");
		if (typeof stateContent !== "string") throw new Error("IPython state notice was not text");
		expect(stateContent).toContain("Live admitted names: shared");
		expect(stateContent).not.toContain("41");
		expect((await session.executeIpythonCell({ code: "get:shared", origin: "model" })).result).toBe("41");
		expect(generations).toHaveLength(1);

		const previousSessionId = sessionManager.getSessionId();
		expect(await session.newSession()).toBe(true);
		expect(sessionManager.getSessionId()).not.toBe(previousSessionId);
		expect(generations[0]?.provisioner.disposed).toBe(true);
		expect((await session.executeIpythonCell({ code: "get:shared", origin: "direct" })).result).toBeUndefined();
		expect(generations).toHaveLength(2);
		expect(generations[1]?.options.identity.sessionId).toBe(sessionManager.getSessionId());
		expect(generations[1]?.options.identity.cwd).toBe(tempDir.path());
		expect(generations[0]?.processIds).not.toEqual(generations[1]?.processIds);
	}, 30_000);
});

describe("AgentSession IPython admission authority", () => {
	const cleanup: Array<() => Promise<void>> = [];
	const generations: SessionMemoryGeneration[] = [];

	afterEach(async () => {
		for (const dispose of cleanup.splice(0)) await dispose();
		generations.splice(0);
		vi.restoreAllMocks();
	});

	async function createSession(options: {
		settings?: Record<string, unknown>;
		extensionRunner?: ExtensionRunner;
		autoApprove?: boolean;
		bridge?: ClientBridge;
		reloadExtensions?: () => Promise<Extension[]>;
		createActPrivateSession?: AgentSessionConfig["createActPrivateSession"];
	}) {
		const tempDir = TempDir.createSync("@omp-agent-session-ipython-admission-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const settings = Settings.isolated({ "compaction.enabled": false, ...options.settings });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const response = assistantResponse("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			autoApprove: options.autoApprove,
			extensionRunner: options.extensionRunner,
			reloadExtensions: options.reloadExtensions,
			createActPrivateSession: options.createActPrivateSession,
			taskAdmissionService: {
				async admit() {
					throw new Error("not used");
				},
				findModels: () => [],
				listDirectChildren: async () => [],
				async deleteDirectChild() {
					throw new Error("not used");
				},
			},
			agentFamilyService: {
				roster: async () => ({ current: { name: "root", id: "Main", depth: 0 }, entries: [] }),
				send: async () => ({}),
				inbox: async () => ({ messages: [] }),
				wait: async () => ({}),
				observeList: async () => ({}),
				observeGet: async () => ({}),
				observeRecent: async () => ({}),
			},
			createIpythonSessionGeneration: options => {
				const generation = new SessionMemoryGeneration(options, generations.length);
				generations.push(generation);
				return generation;
			},
		});
		if (options.bridge) session.setClientBridge(options.bridge);
		cleanup.push(async () => {
			await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		});
		return { session, sessionManager };
	}

	function bridgeResponding(
		outcome: ClientBridgePermissionOutcome,
		onRequest?: (toolCall: unknown) => void,
	): ClientBridge {
		return {
			capabilities: { requestPermission: true },
			async requestPermission(toolCall, _options, _signal) {
				onRequest?.(toolCall);
				return outcome;
			},
		};
	}

	function extensionForReload(namespace: string, operation: string): Extension {
		return {
			path: `${namespace}-${operation}`,
			resolvedPath: `${namespace}-${operation}`,
			ipythonHostHandlers: [{ namespace, operation, handler: async () => ({ ok: true }) }],
			ipythonMimeRenderers: [],
		} as unknown as Extension;
	}

	function runnerForReload(initial: Extension[]) {
		let current = initial;
		const replaceExtensions = vi.fn((next: Extension[]) => {
			const previous = current;
			current = next;
			return previous;
		});
		const emit = vi.fn(async (_event: { type: string }) => undefined);
		const emitToExtensions = vi.fn(async (_event: { type: string }, _extensions: readonly Extension[]) => undefined);
		const clearManagedTimers = vi.fn((_scope?: readonly Extension[]) => {});
		return {
			runner: {
				hasUI: () => false,
				hasHandlers: () => false,
				emit,
				emitToExtensions,
				getUIContext: () => ({ select: async () => undefined }),
				getExtensionSnapshot: () => current,
				getIpythonHostHandlers: () =>
					initial.flatMap(extension =>
						(extension.ipythonHostHandlers ?? []).map(registration => ({
							...registration,
							extensionPath: extension.path,
						})),
					),
				getIpythonMimeRenderers: () => [],
				replaceExtensions,
				clearManagedTimers,
			} as unknown as ExtensionRunner,
			replaceExtensions,
			emit,
			emitToExtensions,
			clearManagedTimers,
		};
	}

	function runnerWithSelect(
		select: (prompt: string, options: string[], dialog?: { signal?: AbortSignal }) => Promise<string | undefined>,
	) {
		const hasHandlers = vi.fn(() => false);
		const emit = vi.fn(async () => undefined);
		return {
			runner: {
				hasUI: () => true,
				hasHandlers,
				emit,
				getUIContext: () => ({ select }),
			} as unknown as ExtensionRunner,
			hasHandlers,
			emit,
		};
	}

	test("atomically replaces validated extension definitions after the skill refresh", async () => {
		const initial = extensionForReload("old", "run");
		const next = extensionForReload("demo", "run");
		(next as unknown as { tools: Map<string, unknown> }).tools = new Map([
			["legacy_reload_tool", { definition: { name: "legacy_reload_tool" }, extensionPath: next.path }],
		]);
		const { runner, replaceExtensions, emitToExtensions } = runnerForReload([initial]);
		const { session } = await createSession({ extensionRunner: runner, reloadExtensions: async () => [next] });
		await session.executeIpythonCell({ code: "set:reload:ready", origin: "direct" });
		const resolveHandler = generations[0]?.options.extensionHostHandlerResolver;
		if (!resolveHandler) throw new Error("extension host resolver was unavailable");
		expect(resolveHandler("extension.old.run")).toBeDefined();
		const roster = session.agent.state.tools.map(tool => tool.name);
		await session.refreshSkills();
		expect(session.agent.state.tools.map(tool => tool.name)).toEqual(roster);
		expect(session.agent.state.tools.map(tool => tool.name)).not.toContain("legacy_reload_tool");
		expect(replaceExtensions).toHaveBeenCalledWith([next]);
		expect(emitToExtensions.mock.calls).toEqual([
			[{ type: "session_start" }, [next]],
			[{ type: "session_shutdown" }, [initial]],
		]);
		expect(resolveHandler("extension.old.run")).toBeUndefined();
		expect(resolveHandler("extension.demo.run")).toBeDefined();
		expect(generations).toHaveLength(1);
	});

	test("retains live extension definitions when candidate registry validation fails", async () => {
		const initial = extensionForReload("old", "run");
		const duplicate = [extensionForReload("demo", "run"), extensionForReload("demo", "run")];
		const { runner, replaceExtensions, emitToExtensions } = runnerForReload([initial]);
		const { session } = await createSession({ extensionRunner: runner, reloadExtensions: async () => duplicate });
		await session.executeIpythonCell({ code: "set:reload:ready", origin: "direct" });
		const resolveHandler = generations[0]?.options.extensionHostHandlerResolver;
		if (!resolveHandler) throw new Error("extension host resolver was unavailable");
		await expect(session.refreshSkills()).rejects.toThrow("duplicate IPython extension operation");
		expect(replaceExtensions).not.toHaveBeenCalled();
		expect(emitToExtensions).not.toHaveBeenCalled();
		expect(resolveHandler("extension.old.run")).toBeDefined();
		expect(resolveHandler("extension.demo.run")).toBeUndefined();
	});

	test("cleans up a candidate and restarts the live snapshot when candidate initialization fails", async () => {
		const initial = extensionForReload("old", "run");
		const next = extensionForReload("demo", "run");
		const { runner, replaceExtensions, emitToExtensions } = runnerForReload([initial]);
		emitToExtensions.mockRejectedValueOnce(new Error("candidate start failed"));
		const { session } = await createSession({ extensionRunner: runner, reloadExtensions: async () => [next] });
		await expect(session.refreshSkills()).rejects.toThrow("candidate start failed");
		expect(replaceExtensions).not.toHaveBeenCalled();
		expect(emitToExtensions.mock.calls.slice(-2)).toEqual([
			[{ type: "session_shutdown" }, [next]],
			[{ type: "session_start" }, [initial]],
		]);
	});

	test("retains extension definitions when the Python package transaction fails", async () => {
		const initial = extensionForReload("old", "run");
		const next = extensionForReload("demo", "run");
		const { runner, replaceExtensions, emitToExtensions } = runnerForReload([initial]);
		const { session } = await createSession({ extensionRunner: runner, reloadExtensions: async () => [next] });
		await session.executeIpythonCell({ code: "set:reload:ready", origin: "direct" });
		const generation = generations[0];
		const resolveHandler = generation?.options.extensionHostHandlerResolver;
		if (!generation || !resolveHandler) throw new Error("extension host resolver was unavailable");
		generation.failPackageReload = true;
		await expect(session.refreshSkills()).rejects.toThrow("injected Python package reload failure");
		expect(replaceExtensions).not.toHaveBeenCalled();
		expect(emitToExtensions).not.toHaveBeenCalled();
		expect(resolveHandler("extension.old.run")).toBeDefined();
		expect(resolveHandler("extension.demo.run")).toBeUndefined();
	});

	test("keeps same-token Act authorization until both shared-batch root cells finish", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const releaseSecond = Promise.withResolvers<void>();
		const privateManager = SessionManager.inMemory("/tmp");
		const { session } = await createSession({
			settings: { rlmActDefaultModel: `${model.provider}/${model.id}` },
			createActPrivateSession: async ({ model: selected }) => ({
				model: selected,
				messages: [],
				sessionManager: privateManager,
				async prompt() {},
				subscribe: () => () => {},
				abort() {},
				dispose() {},
				getLastAssistantText: () => "provider text",
			}),
		});
		let second: Promise<Awaited<ReturnType<AgentSession["executeIpythonCell"]>>> | undefined;
		const first = session.executeIpythonCell({
			code: "events",
			origin: "direct",
			onUpdate: () => {
				if (second) return;
				const generation = generations[0];
				if (!generation) throw new Error("generation missing");
				generation.provisioner.hostActGate = releaseSecond.promise;
				second = session.executeIpythonCell({ code: "hostact", origin: "direct" });
			},
		});
		await first;
		releaseSecond.resolve();
		const secondResult = await second;
		expect(secondResult?.errors).toEqual([]);
		expect(secondResult?.status).toBe("ok");
	});

	test("yolo: model cell runs without a prompt and stores trusted-cell authority", async () => {
		const { session } = await createSession({ settings: { "tools.approvalMode": "yolo" } });
		const result = await session.executeIpythonCell({ code: "set:color:blue", origin: "model" });
		expect(result.origin).toBe("model");
		expect(result.authority).toBe("trusted-cell");
		expect((await session.executeIpythonCell({ code: "get:color", origin: "model" })).result).toBe("blue");
		expect(generations).toHaveLength(1);
	});

	test("emits one shared live projection and one complete terminal cell for protocol consumers", async () => {
		const { session } = await createSession({ settings: { "tools.approvalMode": "yolo" } });
		const cellEvents: AgentSessionEvent[] = [];
		const callerUpdates: IpythonCellUpdate[] = [];
		session.subscribe(event => {
			if (event.type.startsWith("ipython_cell_")) cellEvents.push(event);
		});
		const result = await session.executeIpythonCell({
			code: "events",
			origin: "model",
			onUpdate: update => {
				callerUpdates.push(update);
			},
		});
		expect(cellEvents.map(event => event.type)).toEqual([
			"ipython_cell_start",
			"ipython_cell_update",
			"ipython_cell_end",
		]);
		const [start, update, end] = cellEvents;
		if (start?.type !== "ipython_cell_start") throw new Error("missing IPython cell start event");
		if (update?.type !== "ipython_cell_update") throw new Error("missing IPython cell update event");
		if (end?.type !== "ipython_cell_end") throw new Error("missing IPython cell end event");
		expect(start.presentation.cellId).toBe(result.cellId);
		expect(start.presentation.safeText.text).toBe("early\n");
		expect(update.presentation.safeText.text).toBe("early\nlate\n");
		expect(end.presentation).toMatchObject({
			phase: "complete",
			cellId: result.cellId,
			status: "ok",
			result: "late",
			safeText: { text: "early\nlate\n" },
		});
		expect(callerUpdates).toEqual([...result.updates]);

		cellEvents.length = 0;
		await session.executeIpythonCell({ code: "set:no-events:value", origin: "direct" });
		expect(cellEvents.map(event => event.type)).toEqual(["ipython_cell_start", "ipython_cell_end"]);
		const noUpdateStart = cellEvents[0];
		const noUpdateEnd = cellEvents[1];
		if (noUpdateStart?.type !== "ipython_cell_start" || noUpdateEnd?.type !== "ipython_cell_end") {
			throw new Error("missing synthesized IPython cell boundary");
		}
		expect(noUpdateStart.presentation.cellId).toBe(noUpdateEnd.presentation.cellId);
	});

	test("always-ask: one interactive prompt for the whole cell, approve runs it", async () => {
		const select = vi.fn(
			async (_prompt: string, _options: string[], _dialog?: { signal?: AbortSignal }) => "Approve",
		);
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
		});
		const result = await session.executeIpythonCell({ code: "set:color:green", origin: "model" });
		expect(result.authority).toBe("trusted-cell");
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[1]).toEqual(["Approve", "Deny"]);
		expect(select.mock.calls[0]?.[2]).toBeUndefined();
		expect(generations).toHaveLength(1);
	});

	test("write mode prompts once for an exec-tier model cell", async () => {
		const select = vi.fn(async () => "Approve");
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({ settings: { "tools.approvalMode": "write" }, extensionRunner: runner });
		await session.executeIpythonCell({ code: "set:color:red", origin: "model" });
		expect(select).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(1);
	});

	test("always-ask user denial blocks the cell and never starts a kernel", async () => {
		const select = vi.fn(async () => "Deny");
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
		});
		await expect(session.executeIpythonCell({ code: "set:color:orange", origin: "model" })).rejects.toThrow(
			/IPython cell execution denied by user/,
		);
		expect(select).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(0);
		expect(session.ipythonProcessIds).toBeUndefined();
	});

	test("always-ask cancellation forwards request.signal as ToolAbortError and blocks the cell", async () => {
		const controller = new AbortController();
		const select = vi.fn((_p: string, _o: string[], dialog?: { signal?: AbortSignal }) => {
			return new Promise<string | undefined>((_resolve, reject) => {
				dialog?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		});
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
		});
		const pending = session.executeIpythonCell({
			code: "set:color:black",
			origin: "model",
			signal: controller.signal,
		});
		queueMicrotask(() => controller.abort());
		await expect(pending).rejects.toThrow("IPython cell approval cancelled");
		expect(generations).toHaveLength(0);
	});

	test("always-ask UI resolving undefined on abort surfaces cancellation, not user denial", async () => {
		const controller = new AbortController();
		const select = vi.fn(async () => {
			controller.abort();
			return undefined;
		});
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
		});
		await expect(
			session.executeIpythonCell({ code: "set:color:navy", origin: "model", signal: controller.signal }),
		).rejects.toThrow("IPython cell approval cancelled");
		expect(generations).toHaveLength(0);
	});

	test("always-ask with no interactive UI fails closed before kernel admission", async () => {
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" } });
		await expect(session.executeIpythonCell({ code: "set:color:teal", origin: "model" })).rejects.toThrow(
			/no interactive UI is available/,
		);
		expect(generations).toHaveLength(0);
	});

	test("explicit autoApprove runs a model cell without a prompt even in always-ask", async () => {
		const select = vi.fn(async () => "Approve");
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
			autoApprove: true,
		});
		await session.executeIpythonCell({ code: "set:color:pink", origin: "model" });
		expect(select).not.toHaveBeenCalled();
		expect(generations).toHaveLength(1);
	});

	test("direct-origin cells bypass approval in always-ask mode", async () => {
		const select = vi.fn(async () => "Approve");
		const { runner } = runnerWithSelect(select);
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
		});
		const result = await session.executeIpythonCell({ code: "get:shared", origin: "direct" });
		expect(result.origin).toBe("direct");
		expect(select).not.toHaveBeenCalled();
		expect(generations).toHaveLength(1);
	});

	test("default-config ACP sessions request one execute permission", async () => {
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ bridge });
		await session.executeIpythonCell({ code: "set:color:default-acp", origin: "model" });
		expect(permissionSpy).toHaveBeenCalledTimes(1);
	});

	test("explicit yolo bypasses the ACP permission gate", async () => {
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ settings: { "tools.approvalMode": "yolo" }, bridge });
		await session.executeIpythonCell({ code: "set:color:explicit-yolo", origin: "model" });
		expect(permissionSpy).not.toHaveBeenCalled();
	});

	test("ACP: one execute request for the whole model cell, allow_once runs it", async () => {
		const requests: Array<{
			toolCallId: string;
			toolName: string;
			kind?: string;
			rawInput: unknown;
			content?: unknown[];
			locations: unknown;
		}> = [];
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" }, tc => {
			const call = tc as {
				toolCallId: string;
				toolName: string;
				kind?: string;
				rawInput: unknown;
				content?: unknown[];
				locations: unknown;
			};
			requests.push(call);
		});
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		const result = await session.executeIpythonCell({ code: "set:color:acp1", origin: "model" });
		expect(result.authority).toBe("trusted-cell");
		expect(permissionSpy).toHaveBeenCalledTimes(1);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.toolName).toBe("ipython");
		expect(requests[0]?.kind).toBe("execute");
		expect(requests[0]?.rawInput).toEqual({ code: "set:color:acp1" });
		expect(requests[0]?.locations).toEqual([]);
		// Whole cell, not a per-operation request:
		expect(requests[0]?.content).toEqual([{ type: "content", content: { type: "text", text: "set:color:acp1" } }]);
		expect(generations).toHaveLength(1);
	});

	test("ACP: reject_once throws and never starts a kernel", async () => {
		const bridge = bridgeResponding({ outcome: "selected", optionId: "reject_once", kind: "reject_once" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		await expect(session.executeIpythonCell({ code: "set:color:acp2", origin: "model" })).rejects.toThrow(
			/ToolError|rejected by user/,
		);
		expect(permissionSpy).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(0);
		expect(session.ipythonProcessIds).toBeUndefined();
	});

	test("ACP: allow_always caches the decision and does not re-request a second cell", async () => {
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		await session.executeIpythonCell({ code: "set:color:one", origin: "model" });
		await session.executeIpythonCell({ code: "set:color:two", origin: "model" });
		expect(permissionSpy).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(1);
	});

	test("ACP: reject_always persists until the client changes, then prompts again", async () => {
		const bridge = bridgeResponding({ outcome: "selected", optionId: "reject_always", kind: "reject_always" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		await expect(session.executeIpythonCell({ code: "set:color:x", origin: "model" })).rejects.toThrow(
			/ToolError|rejected by user/,
		);
		// Cached: a second reject_always never consults the client again.
		await expect(session.executeIpythonCell({ code: "set:color:y", origin: "model" })).rejects.toThrow(
			/ToolError|rejected by user/,
		);
		expect(permissionSpy).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(0);
		// A fresh client resets the persisted decision and prompts again.
		const replace = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		const replaceSpy = spyOn(replace, "requestPermission");
		session.setClientBridge(replace);
		await session.executeIpythonCell({ code: "set:color:z", origin: "model" });
		expect(replaceSpy).toHaveBeenCalledTimes(1);
		expect(generations).toHaveLength(1);
	});

	test("ACP: a late decision from a replaced client cannot authorize later cells", async () => {
		const deferred = Promise.withResolvers<ClientBridgePermissionOutcome>();
		const requestStarted = Promise.withResolvers<void>();
		const original: ClientBridge = {
			capabilities: { requestPermission: true },
			requestPermission: async () => {
				requestStarted.resolve();
				return await deferred.promise;
			},
		};
		const replacement = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		const replacementSpy = spyOn(replacement, "requestPermission");
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			bridge: original,
		});
		const admittedByOriginal = session.executeIpythonCell({ code: "set:color:old-client", origin: "model" });
		await requestStarted.promise;
		session.setClientBridge(replacement);
		deferred.resolve({ outcome: "selected", optionId: "allow_always", kind: "allow_always" });
		await admittedByOriginal;
		await session.executeIpythonCell({ code: "set:color:new-client", origin: "model" });
		expect(replacementSpy).toHaveBeenCalledTimes(1);
	});

	test("ACP: request.signal cancellation aborts before the cell executes", async () => {
		const controller = new AbortController();
		const bridge: ClientBridge = {
			capabilities: { requestPermission: true },
			requestPermission(_toolCall, _options, signal) {
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
						once: true,
					});
				});
			},
		};
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		const pending = session.executeIpythonCell({
			code: "set:color:cancel",
			origin: "model",
			signal: controller.signal,
		});
		queueMicrotask(() => controller.abort());
		await expect(pending).rejects.toThrow("Permission request cancelled");
		expect(generations).toHaveLength(0);
	});

	test("no TUI double prompt when an ACP permission channel is attached", async () => {
		const select = vi.fn(async () => "Approve");
		const { runner } = runnerWithSelect(select);
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" });
		const permissionSpy = spyOn(bridge, "requestPermission");
		const { session } = await createSession({
			settings: { "tools.approvalMode": "always-ask" },
			extensionRunner: runner,
			bridge,
		});
		await session.executeIpythonCell({ code: "set:color:noDouble", origin: "model" });
		expect(permissionSpy).toHaveBeenCalledTimes(1);
		expect(select).not.toHaveBeenCalled();
		expect(generations).toHaveLength(1);
	});

	test("unique per-cell decision ids correlate independent cells", async () => {
		const toolCallIds: string[] = [];
		const bridge = bridgeResponding({ outcome: "selected", optionId: "allow_once", kind: "allow_once" }, tc => {
			toolCallIds.push((tc as { toolCallId: string }).toolCallId);
		});
		const { session } = await createSession({ settings: { "tools.approvalMode": "always-ask" }, bridge });
		await session.executeIpythonCell({ code: "set:color:id1", origin: "model" });
		await session.executeIpythonCell({ code: "set:color:id2", origin: "model" });
		expect(toolCallIds).toHaveLength(2);
		expect(toolCallIds[0]).toMatch(/^ipython:/);
		expect(toolCallIds[1]).toMatch(/^ipython:/);
		expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
	});
});

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";

function pythonAbiSourcePath(): string {
	const root = path.resolve(import.meta.dir, "../src/ipython/python");
	const skills = [
		"agent-message",
		"agent-observe",
		"attach-image",
		"compact",
		"edit",
		"goal",
		"refine",
		"rlm-heartbeat",
		"websearch",
		"linear",
		"notion",
	];
	return [root, ...skills.map(skill => path.join(root, "skills", skill, "src"))].join(path.delimiter);
}
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("AgentSession real IPython lifecycle", () => {
	test("returns the exact shared-kernel object from a production Act lane", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-act-shared-kernel-real-"));
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const responses: MockResponse[] = [
			{
				content: [
					{
						type: "toolCall",
						id: "act-cell-1",
						name: "shared_ipython",
						arguments: { code: "shared_object['value'] = 41" },
					},
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{
						type: "toolCall",
						id: "act-cell-2",
						name: "shared_ipython",
						arguments: { code: "shared_object['value'] += 1" },
					},
				],
				stopReason: "toolUse",
			},
			{
				content: [
					{
						type: "toolCall",
						id: "act-cell-3",
						name: "shared_ipython",
						arguments: { code: "from rlm import done\ndone(shared_object)" },
					},
				],
				stopReason: "toolUse",
			},
		];
		const mock = createMockModel({
			handler: () => responses.shift() ?? { content: [{ type: "text", text: "unexpected" }], stopReason: "stop" },
		});
		const manager = SessionManager.create(tempRoot, tempRoot);
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Root test"], tools: [], messages: [] },
				convertToLlm,
				getApiKey: () => "test-key",
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "todo.enabled": false, "todo.reminders": false }),
			modelRegistry,
			createIpythonSessionGeneration: options =>
				new RealSessionGeneration(options, pythonExecutable, {
					HOME: home,
					PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				}),
		});
		try {
			session.subscribe(() => {});
			const act = await session.executeIpythonCell({
				origin: "direct",
				code: [
					"import rlm",
					"shared_object = {'value': 0}",
					`returned_object = await rlm.act('update the live object', model='${model.provider}/${model.id}')`,
					"(returned_object is shared_object, returned_object['value'])",
				].join("\n"),
			});
			expect(act.errors).toEqual([]);
			expect(act.result).toBe("(True, 42)");
			expect((await session.executeIpythonCell({ origin: "direct", code: "shared_object['value']" })).result).toBe(
				"42",
			);
			expect(responses).toHaveLength(0);
		} finally {
			await session.dispose();
			authStorage.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);

	test("runs host-owned controls and continual harness APIs from the real kernel", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-controls-real-"));
		const home = path.join(tempRoot, "home");
		const agentDir = path.join(tempRoot, "agent");
		await Promise.all([fs.mkdir(home), fs.mkdir(agentDir)]);
		const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const sessionManager = SessionManager.create(tempRoot, tempRoot);
		const settings = Settings.isolated({ "todo.enabled": true, "todo.reminders": false });
		const environment = {
			HOME: home,
			PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		};
		let session: AgentSession | undefined;
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: () => {
				const response = assistantResponse("continued after rewind");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		try {
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,
				memoryAgentDir: agentDir,
				createIpythonSessionGeneration: options =>
					new RealSessionGeneration(options, pythonExecutable, environment),
			});
			session.subscribe(() => {});
			const result = await session.executeIpythonCell({
				origin: "direct",
				code: [
					"import json",
					"import goal, compact, refine, rlm_heartbeat",
					"from rlm import harness",
					"from omp.harness import checkpoint, todo",
					"entry = harness.create_memory('Runtime memory', 'Host-owned state', id='runtime-memory', global_=True)",
					"updated = harness.update_memory('runtime-memory', 'Runtime memory', 'Updated host-owned state', global_=True)",
					"refinement = harness.record_refinement(trigger='Repeated gap', changes=['update memory:runtime-memory'], evidence='test', outcome='fixed', global_=True)",
					"async def exercise():",
					"    try:",
					"        await goal.resume()",
					"    except RuntimeError as error:",
					"        resume_error = str(error)",
					"    created_goal = await goal.create('Verify controls', 1000)",
					"    paused_goal = await goal.pause('waiting for verification')",
					"    resumed_goal = await goal.resume()",
					"    completed_goal = await goal.complete()",
					"    try:",
					"        await goal.pause('too late')",
					"    except RuntimeError as error:",
					"        pause_error = str(error)",
					"    compact_result = await compact.run()",
					"    refine_result = await refine.run()",
					"    todo_result = await todo('init', {'list': [{'phase': 'Runtime', 'items': ['Verify APIs']}]})",
					"    checkpoint_result = await checkpoint('controls')",
					"    heartbeat = (await rlm_heartbeat.create('Check controls', '1h'))['heartbeat']",
					"    paused = (await rlm_heartbeat.update(heartbeat['id'], status='pause'))['heartbeat']",
					"    deleted = (await rlm_heartbeat.delete(heartbeat['id']))['heartbeat']",
					"    return {'resume_error': resume_error, 'created_goal': created_goal, 'paused_goal': paused_goal, 'resumed_goal': resumed_goal, 'completed_goal': completed_goal, 'pause_error': pause_error, 'compact': compact_result, 'refine': refine_result, 'todo': todo_result, 'checkpoint': checkpoint_result, 'paused': paused, 'deleted': deleted}",
					"control = await exercise()",
					"print(json.dumps({'entry': entry.__dict__, 'updated': updated.__dict__, 'refinement': refinement.__dict__, 'control': control}, sort_keys=True))",
				].join("\n"),
			});
			if (result.status !== "ok") {
				throw new Error(`control cell failed: ${result.stderr} ${JSON.stringify(result.errors)}`);
			}
			const payload = JSON.parse(result.stdout.trim()) as {
				entry: { version: number };
				updated: { version: number; content: string };
				control: Record<string, Record<string, unknown>>;
			};
			expect(payload.entry.version).toBe(1);
			expect(payload.updated).toMatchObject({ version: 2, content: "Updated host-owned state" });
			expect(String(payload.control.resume_error)).toContain("no paused goal");
			expect(payload.control.created_goal.goal).toMatchObject({ status: "active", objective: "Verify controls" });
			expect(payload.control.paused_goal.goal).toMatchObject({ status: "paused" });
			expect(payload.control.resumed_goal.goal).toMatchObject({ status: "active" });
			expect(payload.control.completed_goal.goal).toMatchObject({ status: "complete" });
			expect(String(payload.control.pause_error)).toContain("no active goal");
			expect(payload.control.compact).toMatchObject({ scheduled: false });
			expect(payload.control.refine).toMatchObject({ scheduled: false });
			expect(payload.control.todo.phases).toEqual([
				{ name: "Runtime", tasks: [{ content: "Verify APIs", status: "in_progress" }] },
			]);
			expect(payload.control.checkpoint).toMatchObject({ scheduled: true, label: "controls" });
			expect(payload.control.paused).toMatchObject({ status: "paused" });
			expect(payload.control.deleted).toMatchObject({ status: "cancelled" });
			expect((await session.executeIpythonCell({ origin: "direct", code: "40 + 2" })).result).toBe("42");
			expect(await fs.readFile(path.join(agentDir, "managed-memory", "runtime-memory.md"), "utf8")).toContain(
				"Updated host-owned state",
			);
			const cellJournal = sessionManager
				.getEntries()
				.find(
					entry =>
						entry.type === "custom_message" &&
						entry.customType === IPYTHON_JOURNAL_MESSAGE_TYPE &&
						isIpythonJournalDetail(entry.details) &&
						entry.details.kind === "cell" &&
						entry.details.stdout.includes('"label": "controls"'),
				);
			expect(cellJournal).toBeDefined();
			await session.executeIpythonCell({ origin: "direct", code: "mutated_after_checkpoint = 99" });
			const checkpointIds = session.ipythonProcessIds;
			if (!checkpointIds) throw new Error("checkpoint kernel did not start");
			const resumed = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (event.type === "agent_end") resumed.resolve();
			});
			const rewindResult = await session.executeIpythonCell({
				origin: "direct",
				code: "from omp.harness import rewind\nawait rewind('Verified the control APIs')",
			});
			expect(rewindResult.status).toBe("ok");
			expect(rewindResult.result).toContain("'scheduled': True");
			await resumed.promise;
			unsubscribe();
			const restored = await session.executeIpythonCell({
				origin: "direct",
				code: "print('control' in globals())\nprint('mutated_after_checkpoint' in globals())",
			});
			expect(restored.stdout).toBe("True\nFalse\n");
			expect(processExists(checkpointIds.controllerPid)).toBeFalse();
			expect(processExists(checkpointIds.kernelPid)).toBeFalse();
			expect(sessionManager.getEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "custom_message", customType: "rewind-report" }),
					expect.objectContaining({
						type: "custom_message",
						customType: IPYTHON_JOURNAL_MESSAGE_TYPE,
						details: expect.objectContaining({ kind: "lifecycle", event: "control" }),
					}),
				]),
			);
		} finally {
			await session?.dispose();
			authStorage.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);

	test("runs ordinary edits and managed capabilities from the real kernel", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-capabilities-real-"));
		const agentDir = path.join(tempRoot, "agent");
		await fs.mkdir(agentDir);
		await fs.writeFile(path.join(tempRoot, "capability.txt"), "alpha\nbeta\n");
		await fs.writeFile(path.join(tempRoot, "hashline.txt"), "delta\nepsilon\n");
		await fs.writeFile(
			path.join(tempRoot, "pixel.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
				"base64",
			),
		);
		const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const sessionManager = SessionManager.create(tempRoot, tempRoot);
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({}),
			modelRegistry,
			memoryAgentDir: agentDir,
			createIpythonSessionGeneration: options =>
				new RealSessionGeneration(options, pythonExecutable, {
					PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				}),
		});
		try {
			session.subscribe(() => {});
			const result = await session.executeIpythonCell({
				origin: "direct",
				code: [
					"import json, edit, attach_image",
					"from omp import memory, rules, skills, mcp",
					"edited = await edit.run('capability.txt', 'beta', 'gamma')",
					"mem = await memory.create('runtime-memory', 'Remember the host owner')",
					"rule = await rules.create('runtime-rule', 'Retain typed boundaries')",
					"skill = await skills.create('runtime-skill', 'Use the typed bridge')",
					"servers = await mcp.servers()",
					"image = await attach_image.run('pixel.png')",
					"print(json.dumps({'edited': edited, 'mem': mem['id'], 'rule': rule['id'], 'skill': skill['id'], 'servers': servers, 'image': image}, sort_keys=True))",
				].join("\n"),
			});
			if (result.status !== "ok") {
				throw new Error(`capability cell failed: ${result.stderr} ${JSON.stringify(result.errors)}`);
			}
			const payload = JSON.parse(result.stdout.trim()) as {
				edited: string;
				mem: string;
				rule: string;
				skill: string;
				servers: { servers: unknown[] };
				image: string;
			};
			expect(payload.edited).toContain("capability.txt");
		} finally {
			await session.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 30_000);

	test("restores a named checkpoint into a replacement kernel", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-checkpoint-real-"));
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		const identity = {
			sessionId: "checkpoint-real",
			cwd: tempRoot,
			sessionFile: path.join(tempRoot, "checkpoint.jsonl"),
			sessionDir: tempRoot,
		};
		const environment = {
			HOME: home,
			PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		};
		const restores: IpythonRestoreResult[] = [];
		const failures: string[] = [];
		const runtime = new IpythonSessionRuntime(
			{
				currentIdentity: () => identity,
				onRestore: result => restores.push(result),
				onSnapshotFailure: message => failures.push(message),
				onArtifactFailure: message => failures.push(message),
				onReady: () => {},
			},
			options => new RealSessionGeneration(options, pythonExecutable, environment),
		);
		let firstIds: IpythonProcessIds | undefined;
		let restoredIds: IpythonProcessIds | undefined;
		try {
			expect(
				(await runtime.execute({ origin: "model", code: "checkpoint_value = 10\ncheckpoint_value" })).result,
			).toBe("10");
			await runtime.createCheckpoint("named-checkpoint");
			expect(
				(await runtime.execute({ origin: "direct", code: "checkpoint_value = 99\ncheckpoint_value" })).result,
			).toBe("99");
			firstIds = runtime.processIds;
			if (!firstIds) throw new Error("checkpoint source kernel did not start");
			await runtime.rewindCheckpoint("named-checkpoint");
			expect(processExists(firstIds.controllerPid)).toBe(false);
			expect(processExists(firstIds.kernelPid)).toBe(false);
			expect((await runtime.execute({ origin: "model", code: "checkpoint_value" })).result).toBe("10");
			restoredIds = runtime.processIds;
			if (!restoredIds) throw new Error("checkpoint restore kernel did not start");
			expect(restoredIds).not.toEqual(firstIds);
			expect(restores.some(result => result.restored.includes("checkpoint_value"))).toBe(true);
			expect(failures).toEqual([]);
		} finally {
			await runtime.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		if (firstIds) {
			expect(processExists(firstIds.controllerPid)).toBe(false);
			expect(processExists(firstIds.kernelPid)).toBe(false);
		}
		if (restoredIds) {
			expect(processExists(restoredIds.controllerPid)).toBe(false);
			expect(processExists(restoredIds.kernelPid)).toBe(false);
		}
	}, 120_000);

	test("reloads and switches serialized session heaps without process overlap", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-reload-switch-real-"));
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const settings = Settings.isolated({ "todo.enabled": false, "todo.reminders": false });
		const environment = {
			HOME: home,
			PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		};
		const generationFactory = (options: IpythonSessionGenerationOptions) =>
			new RealSessionGeneration(options, pythonExecutable, environment);
		const observedIds: IpythonProcessIds[] = [];
		let first: AgentSession | undefined;
		let resumed: AgentSession | undefined;
		try {
			const firstManager = SessionManager.create(tempRoot, tempRoot);
			first = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: firstManager,
				settings,
				modelRegistry,
				createIpythonSessionGeneration: generationFactory,
			});
			first.subscribe(() => {});
			expect(
				(await first.executeIpythonCell({ origin: "model", code: "reload_value = 55\nreload_value" })).result,
			).toBe("55");
			const rich = await first.executeIpythonCell({
				origin: "direct",
				code: "from IPython.display import display\ndisplay({'text/html': '<script>unsafe()</script>', 'application/json': {'ok': True}}, raw=True)",
			});
			expect(rich.artifacts.map(artifact => artifact.mimeType).sort()).toEqual(["application/json", "text/html"]);
			expect(await fs.readFile(rich.artifacts[0]?.path ?? "", "utf8")).not.toBe("");
			const originalFile = firstManager.getSessionFile();
			if (!originalFile) throw new Error("first session did not persist");
			const firstIds = first.ipythonProcessIds;
			if (!firstIds) throw new Error("first session did not start IPython");
			observedIds.push(firstIds);
			await first.dispose();
			first = undefined;
			expect(processExists(firstIds.controllerPid)).toBe(false);
			expect(processExists(firstIds.kernelPid)).toBe(false);

			const resumedManager = await SessionManager.open(originalFile, tempRoot);
			resumed = new AgentSession({
				agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
				sessionManager: resumedManager,
				settings,
				modelRegistry,
				createIpythonSessionGeneration: generationFactory,
			});
			resumed.subscribe(() => {});
			expect((await resumed.executeIpythonCell({ origin: "direct", code: "reload_value" })).result).toBe("55");
			const reloadedIds = resumed.ipythonProcessIds;
			if (!reloadedIds) throw new Error("reloaded session did not start IPython");
			observedIds.push(reloadedIds);

			expect(await resumed.newSession()).toBe(true);
			expect(
				(await resumed.executeIpythonCell({ origin: "model", code: "other_value = 77\nother_value" })).result,
			).toBe("77");
			const otherIds = resumed.ipythonProcessIds;
			if (!otherIds) throw new Error("other session did not start IPython");
			observedIds.push(otherIds);
			expect(processExists(reloadedIds.controllerPid)).toBe(false);
			expect(processExists(reloadedIds.kernelPid)).toBe(false);

			expect(await resumed.switchSession(originalFile)).toBe(true);
			const switched = await resumed.executeIpythonCell({
				origin: "direct",
				code: "print(reload_value)\nprint('other_value' in globals())",
			});
			expect(switched.stdout).toBe("55\nFalse\n");
			const switchedIds = resumed.ipythonProcessIds;
			if (!switchedIds) throw new Error("switched session did not start IPython");
			observedIds.push(switchedIds);
			expect(processExists(otherIds.controllerPid)).toBe(false);
			expect(processExists(otherIds.kernelPid)).toBe(false);

			const originalSnapshot = ipythonSnapshotPath(sessionSidecarDir(originalFile));
			expect(await resumed.newSession({ drop: true })).toBe(true);
			expect(processExists(switchedIds.controllerPid)).toBe(false);
			expect(processExists(switchedIds.kernelPid)).toBe(false);
			await expect(fs.stat(originalFile)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(originalSnapshot)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(rich.artifacts[0]?.path ?? "")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await first?.dispose();
			await resumed?.dispose();
			authStorage.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of observedIds) {
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);

	test("forks current state, abandons historical state, moves state, and leaves no process", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-session-ipython-real-"));
		const home = path.join(tempRoot, "home");
		const movedCwd = path.join(tempRoot, "moved-work");
		const movedSessions = path.join(tempRoot, "moved-sessions");
		await Promise.all([fs.mkdir(home), fs.mkdir(movedCwd), fs.mkdir(movedSessions)]);
		const authStorage = await AuthStorage.create(path.join(tempRoot, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempRoot, "models.yml"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("test model is unavailable");
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		const sessionManager = SessionManager.create(tempRoot, tempRoot);
		const historicalUserId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "historical root" }],
			timestamp: Date.now(),
		});
		const settings = Settings.isolated({ "todo.enabled": false, "todo.reminders": false });
		const environment = {
			HOME: home,
			PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		};
		let session: AgentSession | undefined;
		const observedIds: IpythonProcessIds[] = [];
		try {
			session = new AgentSession({
				agent,
				sessionManager,
				settings,
				modelRegistry,
				createIpythonSessionGeneration: options =>
					new RealSessionGeneration(options, pythonExecutable, environment),
			});
			session.subscribe(() => {});
			const originalSessionId = sessionManager.getSessionId();
			const stored = await session.executeIpythonCell({
				origin: "model",
				code: "private_value = 41\nprivate_value",
			});
			expect(stored.result).toBe("41");
			const firstIds = session.ipythonProcessIds;
			if (!firstIds) throw new Error("first session did not start IPython");
			observedIds.push(firstIds);

			expect(await session.fork()).toBe(true);
			const forkSessionId = sessionManager.getSessionId();
			expect(forkSessionId).not.toBe(originalSessionId);
			const inherited = await session.executeIpythonCell({ origin: "direct", code: "private_value + 1" });
			expect(inherited.result).toBe("42");
			const forkIds = session.ipythonProcessIds;
			if (!forkIds) throw new Error("forked session did not restart IPython");
			observedIds.push(forkIds);
			expect(processExists(firstIds.controllerPid)).toBe(false);
			expect(processExists(firstIds.kernelPid)).toBe(false);

			const branched = await session.branch(historicalUserId);
			expect(branched.cancelled).toBe(false);
			const historicalFresh = await session.executeIpythonCell({
				origin: "model",
				code: "print('private_value' in globals())",
			});
			expect(historicalFresh.stdout).toBe("False\n");
			const branchIds = session.ipythonProcessIds;
			if (!branchIds) throw new Error("historical branch did not start IPython");
			observedIds.push(branchIds);
			expect(processExists(forkIds.controllerPid)).toBe(false);
			expect(processExists(forkIds.kernelPid)).toBe(false);
			await session.executeIpythonCell({ origin: "direct", code: "move_value = 7" });
			const branchSessionId = sessionManager.getSessionId();

			await session.moveSession(movedCwd, movedSessions);
			const canonicalMovedCwd = await fs.realpath(movedCwd);
			const moved = await session.executeIpythonCell({
				origin: "direct",
				code: "import os\nprint(move_value)\nprint(os.getcwd())",
			});
			expect(moved.stdout.split("\n")).toEqual(["7", canonicalMovedCwd, ""]);
			expect(sessionManager.getSessionId()).toBe(branchSessionId);
			const movedIds = session.ipythonProcessIds;
			if (!movedIds) throw new Error("moved session did not restart IPython");
			observedIds.push(movedIds);
			expect(processExists(branchIds.controllerPid)).toBe(false);
			expect(processExists(branchIds.kernelPid)).toBe(false);

			expect(await session.newSession()).toBe(true);
			expect(sessionManager.getSessionId()).not.toBe(branchSessionId);
			const fresh = await session.executeIpythonCell({
				origin: "model",
				code: "print('move_value' in globals())",
			});
			expect(fresh.stdout).toBe("False\n");
			const freshIds = session.ipythonProcessIds;
			if (!freshIds) throw new Error("fresh session did not start IPython");
			observedIds.push(freshIds);
			expect(processExists(movedIds.controllerPid)).toBe(false);
			expect(processExists(movedIds.kernelPid)).toBe(false);
		} finally {
			await session?.dispose();
			authStorage.close();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of observedIds) {
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);
});

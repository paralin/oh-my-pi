import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry.js";
import { Settings } from "../src/config/settings.js";
import { type IpythonCellProvisioner, IpythonCellService } from "../src/ipython/cell.js";
import type {
	IpythonExecutionResult,
	IpythonProcessIds,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../src/ipython/controller.js";
import { ipythonEnvironment } from "../src/ipython/environment.js";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, isIpythonJournalDetail } from "../src/ipython/journal.js";
import { IpythonKernelProvisioner, ipythonSnapshotPath } from "../src/ipython/provisioner.js";
import type { EnsureIpythonRuntimeOptions, IpythonRuntime } from "../src/ipython/runtime-bootstrap.js";
import { AgentSession } from "../src/session/agent-session.js";
import { AuthStorage } from "../src/session/auth-storage.js";
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

	async execute(code: string): Promise<IpythonExecutionResult> {
		const [operation, name, ...rest] = code.split(":");
		let value: string | undefined;
		if (operation === "set" && name) this.names.set(name, rest.join(":"));
		else if (operation === "get" && name) value = this.names.get(name);
		return {
			id: code,
			status: "ok",
			stdout: "",
			stderr: "",
			result: value,
			events: value === undefined ? [] : [{ kind: "result", data: { "text/plain": value } }],
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
				pythonPaths: options.pythonPaths,
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

	test("keeps one heap through compaction and replaces it at a session transition", async () => {
		const tempDir = TempDir.createSync("@omp-agent-session-ipython-");
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
		});
		let session: AgentSession;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			getToolChoice: () => session?.nextToolChoiceDirective(),
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
		const directEntry = sessionManager
			.getEntries()
			.find(
				entry =>
					entry.type === "custom_message" &&
					entry.customType === IPYTHON_JOURNAL_MESSAGE_TYPE &&
					isIpythonJournalDetail(entry.details) &&
					entry.details.kind === "cell",
			);
		expect(directEntry?.type).toBe("custom_message");
		if (directEntry?.type !== "custom_message" || !isIpythonJournalDetail(directEntry.details)) {
			throw new Error("direct cell did not persist a typed IPython journal detail");
		}
		expect(directEntry.details.kind).toBe("cell");
		if (directEntry.details.kind !== "cell") throw new Error("direct journal detail was not a cell");
		expect(directEntry.details.origin).toBe("direct");
		expect(directEntry.details.code).toBe("get:shared");
		expect(generations).toHaveLength(1);
		expect(session.ipythonSessionId).toBe(sessionManager.getSessionId());
		expect(session.ipythonProcessIds).toEqual({ controllerPid: 100, kernelPid: 101 });
		expect(notices).toContain("IPython state was not present; the session started fresh.");

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
	];
	return [root, ...skills.map(skill => path.join(root, "skills", skill, "src"))].join(path.delimiter);
}
const describeIntegration = integrationEnabled ? describe : describe.skip;

describeIntegration("AgentSession real IPython lifecycle", () => {
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
					"    created_goal = await goal.create('Verify controls', 1000)",
					"    completed_goal = await goal.complete()",
					"    compact_result = await compact.run()",
					"    refine_result = await refine.run()",
					"    todo_result = await todo('init', {'list': [{'phase': 'Runtime', 'items': ['Verify APIs']}]})",
					"    checkpoint_result = await checkpoint('controls')",
					"    heartbeat = (await rlm_heartbeat.create('Check controls', '1h'))['heartbeat']",
					"    paused = (await rlm_heartbeat.update(heartbeat['id'], status='pause'))['heartbeat']",
					"    deleted = (await rlm_heartbeat.delete(heartbeat['id']))['heartbeat']",
					"    return {'created_goal': created_goal, 'completed_goal': completed_goal, 'compact': compact_result, 'refine': refine_result, 'todo': todo_result, 'checkpoint': checkpoint_result, 'paused': paused, 'deleted': deleted}",
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
			expect(payload.control.created_goal.goal).toMatchObject({ status: "active", objective: "Verify controls" });
			expect(payload.control.completed_goal.goal).toMatchObject({ status: "complete" });
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

	test("runs typed workspace, managed capability, and rich diff APIs from the real kernel", async () => {
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
					"from omp import workspace, memory, rules, skills, mcp",
					"edited = await edit.run('capability.txt', 'beta', 'gamma')",
					"search = await workspace.search('gamma', paths=['.'], limit=10)",
					"anchor = await workspace.search('epsilon', paths=['hashline.txt'], limit=10)",
					"anchored = await workspace.hashline_edit(anchor['snapshots'][0]['header'] + '\\nPUT 2-2:\\n+zeta')",
					"mem = await memory.create('runtime-memory', 'Remember the host owner')",
					"rule = await rules.create('runtime-rule', 'Retain typed boundaries')",
					"skill = await skills.create('runtime-skill', 'Use the typed bridge')",
					"servers = await mcp.servers()",
					"image = await attach_image.run('pixel.png')",
					"print(json.dumps({'edited': edited, 'search': search, 'mem': mem['id'], 'rule': rule['id'], 'skill': skill['id'], 'servers': servers, 'image': image, 'anchored': anchored['op']}, sort_keys=True))",
				].join("\n"),
			});
			if (result.status !== "ok") {
				throw new Error(`capability cell failed: ${result.stderr} ${JSON.stringify(result.errors)}`);
			}
			const payload = JSON.parse(result.stdout.trim()) as {
				edited: string;
				search: { matches: Array<{ path: string; line: number; text: string }> };
				mem: string;
				rule: string;
				skill: string;
				servers: { servers: unknown[] };
				image: string;
				anchored: string;
			};
			expect(payload.edited).toContain("capability.txt");
			expect(payload.search.matches).toEqual([
				expect.objectContaining({ path: "capability.txt", line: 2, text: "gamma" }),
			]);
			expect(payload).toMatchObject({
				mem: "runtime-memory",
				rule: "runtime-rule",
				skill: "runtime-skill",
				servers: { servers: [] },
				image: expect.stringContaining("Loaded 1 image"),
				anchored: "update",
			});
			expect(await fs.readFile(path.join(tempRoot, "capability.txt"), "utf8")).toBe("alpha\ngamma\n");
			expect(await fs.readFile(path.join(tempRoot, "hashline.txt"), "utf8")).toBe("delta\nzeta\n");
			expect(result.events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						kind: "display",
						data: expect.objectContaining({
							"application/vnd.omp.diff+json": expect.objectContaining({ start_line: 2 }),
						}),
					}),
					expect.objectContaining({
						kind: "display",
						data: expect.objectContaining({
							"application/vnd.omp.attachment+json": expect.objectContaining({
								mime_type: "image/png",
							}),
						}),
					}),
				]),
			);
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

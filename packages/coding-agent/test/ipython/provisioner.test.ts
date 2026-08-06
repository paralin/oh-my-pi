import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentFamilyService, createAgentFamilyIpythonHostHandlers } from "../../src/ipython/agent-family.js";
import { IpythonBootGate, resolveIpythonBootConcurrency } from "../../src/ipython/boot-gate.js";
import { createIpythonCodeHostHandlers } from "../../src/ipython/code-service.js";
import type {
	IpythonControllerOptions,
	IpythonExecutionResult,
	IpythonHostRequest,
	IpythonProcessIds,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../../src/ipython/controller.js";
import { ipythonEnvironment } from "../../src/ipython/environment.js";
import { composeIpythonHostHandlers, createFoundationalIpythonHostHandlers } from "../../src/ipython/host-bridge.js";
import {
	type IpythonKernelController,
	IpythonKernelProvisioner,
	type IpythonStartupProgress,
} from "../../src/ipython/provisioner.js";
import { createRlmIpythonHostHandlers } from "../../src/ipython/rlm-host.js";
import type { EnsureIpythonRuntimeOptions, IpythonRuntime } from "../../src/ipython/runtime-bootstrap.js";
import type { TaskAdmissionRequest, TaskAdmissionService } from "../../src/task/admission.js";

function executionResult(result?: string): IpythonExecutionResult {
	return { id: "fake", status: "ok", stdout: "", stderr: "", result, events: [], errors: [], hostArtifacts: [] };
}

function restoreResult(snapshotPath: string): IpythonRestoreResult {
	return { restored: [], failed: [], missing: true, path: snapshotPath };
}

function snapshotResult(snapshotPath: string): IpythonSnapshotResult {
	return {
		saved: [],
		skipped: [],
		oversized: [],
		failed: [],
		bytes: 0,
		path: snapshotPath,
		manifestPath: `${snapshotPath}.json`,
	};
}

function fakeRuntime(options: EnsureIpythonRuntimeOptions): IpythonRuntime {
	return {
		pythonExecutable: "/test/python",
		runtimeDir: "/test/runtime",
		pythonPackageDir: "/test/runtime/python",
		environment: {
			...ipythonEnvironment(options.environment),
			OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
		},
	};
}

class FakeController implements IpythonKernelController {
	processIds: IpythonProcessIds | undefined;
	readonly events: string[];
	readonly options: IpythonControllerOptions;
	readonly failStart: boolean;
	disposed = false;
	interrupted = false;

	constructor(options: IpythonControllerOptions, events: string[], failStart = false) {
		this.options = options;
		this.events = events;
		this.failStart = failStart;
	}

	async start(): Promise<void> {
		this.events.push("start");
		if (this.failStart) throw new Error("injected start failure");
		this.processIds = { controllerPid: 10, kernelPid: 11 };
	}

	async execute(code: string): Promise<IpythonExecutionResult> {
		this.events.push(`execute:${code}`);
		return executionResult();
	}

	async snapshot(snapshotPath: string): Promise<IpythonSnapshotResult> {
		this.events.push("snapshot");
		return snapshotResult(snapshotPath);
	}

	async restore(snapshotPath: string): Promise<IpythonRestoreResult> {
		this.events.push("restore");
		return restoreResult(snapshotPath);
	}

	async interrupt(): Promise<void> {
		this.interrupted = true;
	}

	async dispose(): Promise<void> {
		this.events.push("dispose");
		this.disposed = true;
		this.processIds = undefined;
	}
}

class ProcessBackedStartingController extends FakeController {
	readonly entered = Promise.withResolvers<IpythonProcessIds>();
	readonly #releaseStart = Promise.withResolvers<void>();
	readonly #children: Array<{ readonly pid: number; readonly exited: Promise<number>; kill(): void }> = [];

	override async start(): Promise<void> {
		for (let index = 0; index < 2; index += 1) {
			this.#children.push(
				Bun.spawn({
					cmd: [process.execPath, "-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"],
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				}),
			);
		}
		const [controller, kernel] = this.#children;
		if (!controller || !kernel) throw new Error("failed to create test processes");
		this.processIds = { controllerPid: controller.pid, kernelPid: kernel.pid };
		this.entered.resolve(this.processIds);
		await this.#releaseStart.promise;
	}

	override async dispose(): Promise<void> {
		this.#releaseStart.resolve();
		for (const child of this.#children) child.kill();
		await Promise.all(this.#children.map(child => child.exited));
		await super.dispose();
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

describe("IPython boot gate", () => {
	test("resolves bounded host overrides", () => {
		expect(resolveIpythonBootConcurrency({}, 1)).toBe(4);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "20" }, 2)).toBe(20);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "999" }, 2)).toBe(64);
		expect(resolveIpythonBootConcurrency({ OMP_MAX_CONCURRENT_IPYTHON_BOOTS: "0" }, 8)).toBe(16);
	});

	test("cancels a queued boot without consuming the permit", async () => {
		const gate = new IpythonBootGate(1);
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const first = gate.run(async () => {
			firstEntered.resolve();
			await releaseFirst.promise;
			return "first";
		});
		await firstEntered.promise;

		const abort = new AbortController();
		const queued = gate.run(async () => "cancelled boot ran", abort.signal);
		abort.abort(new Error("cancel queued boot"));
		await expect(queued).rejects.toThrow("cancel queued boot");

		releaseFirst.resolve();
		expect(await first).toBe("first");
		expect(await gate.run(async () => "next")).toBe("next");
	});
});

describe("IPython kernel provisioner", () => {
	test("awaits its gate, restores before bootstrap, and shares one startup", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const snapshotPath = "/test/sidecar/state.dill";
		const progressA: IpythonStartupProgress[] = [];
		const progressB: IpythonStartupProgress[] = [];
		let controllers = 0;
		let createdController: FakeController | undefined;
		let runtimeOptions: EnsureIpythonRuntimeOptions | undefined;
		const provisioner = new IpythonKernelProvisioner(
			{
				cwd: "/work",
				sessionId: "session-a",
				sidecarDir: "/test/sidecar",
				snapshotPath,
				readyGate: gate.promise,
				bootstrapCode: "rlm = 'fresh'",
				environment: { ANTHROPIC_API_KEY: "secret", PATH: "/bin" },
			},
			{
				ensureRuntime: async options => {
					events.push("runtime");
					runtimeOptions = options;
					return fakeRuntime(options);
				},
				createController: options => {
					controllers += 1;
					createdController = new FakeController(options, events);
					return createdController;
				},
				withBootPermit: async boot => await boot(),
			},
		);

		const first = provisioner.ensure(progress => progressA.push(progress));
		const second = provisioner.ensure(progress => progressB.push(progress));
		expect(progressA.at(-1)?.stage).toBe("gate");
		expect(progressB.at(-1)?.stage).toBe("gate");
		gate.resolve();
		expect(await first).toBe(await second);

		expect(controllers).toBe(1);
		expect(events[0]).toBe("runtime");
		expect(events.slice(1, 3)).toEqual(["start", "restore"]);
		expect(events[3]?.startsWith("execute:")).toBe(true);
		expect(events[3]).toContain("import asyncio as _omp_runtime_asyncio");
		expect(events[3]).toContain("rlm = 'fresh'");
		expect(progressA.map(progress => progress.stage)).toEqual([
			"gate",
			"runtime",
			"controller",
			"restore",
			"bootstrap",
			"ready",
		]);
		expect(runtimeOptions?.environment).toMatchObject({
			OMP_SESSION_ID: "session-a",
			OMP_SESSION_CWD: "/work",
			OMP_SESSION_ARTIFACT_DIR: "/test/sidecar",
		});
		expect(createdController?.options.env).toMatchObject({
			OMP_SESSION_ID: "session-a",
			OMP_SESSION_CWD: "/work",
			OMP_SESSION_ARTIFACT_DIR: "/test/sidecar",
		});
		expect(createdController?.options.env?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(provisioner.lastRestore).toEqual(restoreResult(snapshotPath));
		expect(provisioner.hasRunningKernel).toBe(true);
		await provisioner.dispose();
	});

	test("disposes a failed generation and retries with a fresh controller", async () => {
		const events: string[] = [];
		const controllers: FakeController[] = [];
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "retry" },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					const controller = new FakeController(options, events, controllers.length === 0);
					controllers.push(controller);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);

		await expect(provisioner.ensure()).rejects.toThrow("injected start failure");
		expect(controllers[0]?.disposed).toBe(true);
		await provisioner.ensure();
		expect(controllers).toHaveLength(2);
		expect(provisioner.processIds).toEqual({ controllerPid: 10, kernelPid: 11 });
		await provisioner.dispose();
	});

	test("disposes controller and kernel processes admitted during startup", async () => {
		const controllerCreated = Promise.withResolvers<ProcessBackedStartingController>();
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "dispose-controller-start" },
			{
				ensureRuntime: async options => fakeRuntime(options),
				createController: options => {
					const controller = new ProcessBackedStartingController(options, []);
					controllerCreated.resolve(controller);
					return controller;
				},
				withBootPermit: async boot => await boot(),
			},
		);
		const starting = provisioner.ensure();
		const admitted = await controllerCreated.promise;
		const processIds = await admitted.entered.promise;
		try {
			await provisioner.dispose();
			await expect(starting).rejects.toThrow("IPython provisioner disposed");
			expect(processExists(processIds.controllerPid)).toBe(false);
			expect(processExists(processIds.kernelPid)).toBe(false);
		} finally {
			await provisioner.dispose();
		}
	});

	test("cancels runtime setup and never creates a controller when disposed during start", async () => {
		const entered = Promise.withResolvers<void>();
		let controllers = 0;
		const provisioner = new IpythonKernelProvisioner(
			{ cwd: "/work", sessionId: "dispose-start" },
			{
				ensureRuntime: async options => {
					entered.resolve();
					const signal = options.signal;
					if (!signal) throw new Error("test requires lifecycle signal");
					if (signal.aborted) throw signal.reason;
					const { promise, reject } = Promise.withResolvers<IpythonRuntime>();
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					return await promise;
				},
				createController: options => {
					controllers += 1;
					return new FakeController(options, []);
				},
			},
		);
		const starting = provisioner.ensure();
		await entered.promise;
		await provisioner.dispose();
		await expect(starting).rejects.toThrow("IPython provisioner disposed");
		expect(controllers).toBe(0);
		expect(provisioner.hasRunningKernel).toBe(false);
	});
});

const integrationEnabled = Bun.env.OMP_IPYTHON_INTEGRATION === "1";

function pythonAbiSourcePath(): string {
	const root = path.resolve(import.meta.dir, "../../src/ipython/python");
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

describeIntegration("IPython provisioner real-kernel boundary", () => {
	test("runs the callable RLM ABI through typed Task admission handlers", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-rlm-"));
		const sidecarDir = path.join(tempRoot, "sidecar");
		await fs.writeFile(path.join(tempRoot, "example.ts"), "export const value = console.log('hello');\n");
		const admissions: TaskAdmissionRequest[] = [];
		const task: TaskAdmissionService = {
			async admit(request) {
				admissions.push(request);
				return {
					id: "child-one",
					name: "child-one",
					jobId: "child-one",
					sessionId: "child-session",
					sessionDir: path.join(tempRoot, "child"),
					model: "provider/model",
					cwd: tempRoot,
				};
			},
			findModels() {
				return [{ provider: "provider", id: "model", name: "Model", selector: "provider/model" }];
			},
			async listDirectChildren() {
				return [
					{
						id: "child-one",
						name: "child-one",
						activeSessionId: "child-session",
						sessionId: "child-session",
						sessionDir: path.join(tempRoot, "child"),
						status: "running" as const,
						lifecycleStatus: "running" as const,
					},
				];
			},
			async deleteDirectChild() {
				return {
					id: "child-one",
					name: "child-one",
					sessionId: "child-session",
					sessionDir: path.join(tempRoot, "child"),
					status: "error" as const,
					lifecycleStatus: "aborted" as const,
				};
			},
		};
		const familySends: Array<{ message: string; id: string }> = [];
		const family: AgentFamilyService = {
			roster: async () => ({
				current: { name: "parent", id: "Main", depth: 0 },
				entries: [{ relationship: "child", name: "child-one", id: "child-one", depth: 1, status: "running" }],
			}),
			async send(request) {
				familySends.push({ message: request.message, id: request.id });
				return {
					id: request.id,
					deliveryStatus: "delivered",
					target: { activeSessionId: "child-one", sessionId: "child-session", sessionName: "child-one" },
					message: request.message,
				};
			},
			inbox: async () => ({ messages: [{ id: "inbox-one", message: "stored" }] }),
			wait: async () => ({ message: { id: "reply-one", message: "reply" } }),
			observeList: async () => ({
				current: { activeSessionId: "Main", sessionId: "rlm-parent", sessionName: "parent" },
				agents: [{ activeSessionId: "child-one", sessionId: "child-session", sessionName: "child-one" }],
			}),
			observeGet: async () => ({ agent: { activeSessionId: "child-one", sessionName: "child-one" } }),
			observeRecent: async () => ({
				agent: { activeSessionId: "child-one", sessionName: "child-one" },
				messages: [{ index: 0, role: "assistant", text: "done", truncated: false }],
				limit: 1,
				maxChars: 80,
				truncated: false,
			}),
		};
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const provisioner = new IpythonKernelProvisioner(
			{
				cwd: tempRoot,
				sessionId: "rlm-parent",
				sidecarDir,
				hostHandlers: composeIpythonHostHandlers(
					createIpythonCodeHostHandlers({ cwd: tempRoot, snapshotOwner: {} }),
					createRlmIpythonHostHandlers(task),
					createAgentFamilyIpythonHostHandlers(family),
				),
			},
			{ ensureRuntime },
		);
		try {
			await provisioner.ensure();
			const hostContext = {
				sessionId: "rlm-parent",
				cwd: tempRoot,
				cellId: "rlm-cell",
				sequence: 1,
				origin: "model" as const,
				authority: "trusted-cell" as const,
			};
			const discovery = await provisioner.execute(
				[
					"import contextlib, inspect, io, json, omp",
					"help_text = io.StringIO()",
					"with contextlib.redirect_stdout(help_text): help(omp.workspace.search)",
					"print(json.dumps({'dir': 'workspace' in dir(omp), 'files': 'files' in dir(omp), 'code': 'code' in dir(omp), 'signature': str(inspect.signature(omp.workspace.search)), 'ast_signature': str(inspect.signature(omp.code.ast_search)), 'help': help_text.getvalue(), 'capabilities': [item.name for item in omp.capabilities()], 'edit_skill': str(omp.skill_path('edit')), 'attach_skill': str(omp.skill_path('attach_image'))}, sort_keys=True))",
				].join("\n"),
				{ hostContext: { ...hostContext, cellId: "discovery-cell", sequence: 0 } },
			);
			if (discovery.status !== "ok") {
				throw new Error(`discovery cell failed: ${discovery.stderr} ${JSON.stringify(discovery.errors)}`);
			}
			const discovered = JSON.parse(discovery.stdout.trim()) as {
				dir: boolean;
				files: boolean;
				code: boolean;
				signature: string;
				ast_signature: string;
				help: string;
				capabilities: string[];
				edit_skill: string;
				attach_skill: string;
			};
			expect(discovered.dir).toBe(true);
			expect(discovered.files).toBe(true);
			expect(discovered.code).toBe(true);
			expect(discovered.signature).toContain("query");
			expect(discovered.ast_signature).toContain("pattern");
			expect(discovered.help).toContain("Search the workspace");
			expect(discovered.capabilities).toEqual(
				expect.arrayContaining(["omp.workspace", "omp.files", "omp.code", "edit", "attach_image"]),
			);
			expect(discovered.edit_skill).toEndWith("/skills/edit/SKILL.md");
			expect(discovered.attach_skill).toEndWith("/skills/attach-image/SKILL.md");
			const codeResult = await provisioner.execute(
				"import omp\nread = await omp.files.read('example.ts', limit=10)\nmatches = await omp.code.ast_search('console.log($$$ARGS)', path='.')\n(read['path'], matches['total_matches'], matches['matches'][0]['path'])",
				{ hostContext: { ...hostContext, cellId: "code-cell", sequence: 1 } },
			);
			expect(codeResult.status).toBe("ok");
			expect(codeResult.result).toBe("('example.ts', 1, 'example.ts')");
			const spawned = await provisioner.execute(
				"import rlm\nhandle = await rlm('Inspect this.', name='child-one', model='provider/model')\n(handle.rlm_child_id, handle.name, handle.model)",
				{ hostContext },
			);
			expect(spawned.status).toBe("ok");
			expect(spawned.result).toBe("('child-one', 'child-one', 'provider/model')");
			expect(admissions).toHaveLength(1);
			expect(admissions[0]).toMatchObject({
				assignment: "Inspect this.",
				name: "child-one",
				model: "provider/model",
			});
			const projected = await provisioner.execute(
				"models = await rlm.find_models('model')\nchildren = await rlm.list_subagents()\ndeleted = await rlm.delete_subagent(children[0])\n(models[0].selector, children[0].rlm_child_id, deleted.status)",
				{ hostContext: { ...hostContext, cellId: "rlm-cell-2", sequence: 2 } },
			);
			expect(projected.status).toBe("ok");
			expect(projected.result).toBe("('provider/model', 'child-one', 'error')");
			const familyResult = await provisioner.execute(
				"import agent_message, agent_observe\n" +
					"roster = await agent_message.list_agents()\n" +
					"receipt = await agent_message.send('hello', receiver_role='child', receiver_name='child-one', message_id='agentmsg_python')\n" +
					"inbox = await agent_message.inbox(limit=1)\n" +
					"reply = await agent_message.wait(timeout=1)\n" +
					"observed = await agent_observe.recent_messages('child-one', limit=1, max_chars=80)\n" +
					"(roster['entries'][0]['relationship'], receipt['id'], inbox['messages'][0]['id'], reply['message']['id'], observed['messages'][0]['text'])",
				{ hostContext: { ...hostContext, cellId: "family-cell", sequence: 3 } },
			);
			expect(familyResult.status).toBe("ok");
			expect(familyResult.result).toBe("('child', 'agentmsg_python', 'inbox-one', 'reply-one', 'done')");
			expect(familySends).toEqual([{ message: "hello", id: "agentmsg_python" }]);
		} finally {
			await provisioner.dispose();
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	}, 120_000);

	test("isolates concurrent root and child kernels behind shared Task and messaging owners", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-root-child-"));
		const rootCwd = path.join(tempRoot, "root");
		const childCwd = path.join(tempRoot, "worktrees", "child");
		const rootSidecar = path.join(tempRoot, "sessions", "root", "ipython");
		const childSidecar = path.join(tempRoot, "sessions", "child", "ipython");
		await Promise.all(
			[rootCwd, childCwd, rootSidecar, childSidecar].map(directory => fs.mkdir(directory, { recursive: true })),
		);
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const admissions: Array<{ role: string; request: TaskAdmissionRequest }> = [];
		const messages: Array<{ role: string; receiver: string | undefined; message: string }> = [];
		const blocked = Promise.withResolvers<void>();
		let blockedAborted = false;
		const taskFor = (role: "root" | "child"): TaskAdmissionService => ({
			async admit(request) {
				admissions.push({ role, request });
				if (request.assignment === "cancel me") {
					blocked.resolve();
					await new Promise<never>((_resolve, reject) => {
						const abort = () => {
							blockedAborted = true;
							reject(request.signal?.reason ?? new Error("cancelled"));
						};
						if (request.signal?.aborted) abort();
						else request.signal?.addEventListener("abort", abort, { once: true });
					});
				}
				return {
					id: `${role}-worker`,
					name: `${role}-worker`,
					jobId: `${role}-worker`,
					sessionId: `${role}-worker-session`,
					sessionDir: path.join(tempRoot, "sessions", `${role}-worker`),
					model: "provider/model",
					cwd: role === "root" ? rootCwd : childCwd,
				};
			},
			findModels: () => [],
			async listDirectChildren() {
				return role === "root"
					? [
							{
								id: "child-runtime",
								name: "child-runtime",
								activeSessionId: "child-session",
								sessionId: "child-session",
								sessionDir: path.join(tempRoot, "sessions", "child"),
								status: "running" as const,
								lifecycleStatus: "running" as const,
							},
						]
					: [];
			},
			async deleteDirectChild() {
				throw new Error("not used");
			},
		});
		const familyFor = (role: "root" | "child"): AgentFamilyService => ({
			roster: async () =>
				role === "root"
					? {
							current: { name: "root", id: "Main", depth: 0 },
							entries: [
								{
									relationship: "child",
									name: "child-runtime",
									id: "child-runtime",
									depth: 1,
									status: "running",
								},
							],
						}
					: {
							current: { name: "child-runtime", id: "child-runtime", depth: 1 },
							entries: [{ relationship: "parent", name: "root", id: "Main", depth: 0, status: "running" }],
						},
			async send(request) {
				if (request.receiverName === "unrelated") throw new Error("unrelated agent is outside the nuclear family");
				messages.push({ role, receiver: request.receiverName, message: request.message });
				return { id: request.id, deliveryStatus: "delivered", message: request.message };
			},
			inbox: async () => ({ messages: [] }),
			wait: async () => ({ message: null }),
			observeList: async () => ({ agents: [] }),
			observeGet: async () => ({ agent: null }),
			observeRecent: async () => ({ messages: [] }),
		});
		const barrier = Promise.withResolvers<void>();
		const barrierSessions = new Set<string>();
		const handlersFor = (role: "root" | "child") =>
			composeIpythonHostHandlers(
				createFoundationalIpythonHostHandlers(),
				createRlmIpythonHostHandlers(taskFor(role)),
				createAgentFamilyIpythonHostHandlers(familyFor(role)),
				{
					"test.barrier": async request => {
						barrierSessions.add(request.sessionId);
						if (barrierSessions.size === 2) barrier.resolve();
						await barrier.promise;
						return {};
					},
				},
			);
		const root = new IpythonKernelProvisioner(
			{ cwd: rootCwd, sessionId: "root-session", sidecarDir: rootSidecar, hostHandlers: handlersFor("root") },
			{ ensureRuntime },
		);
		const child = new IpythonKernelProvisioner(
			{ cwd: childCwd, sessionId: "child-session", sidecarDir: childSidecar, hostHandlers: handlersFor("child") },
			{ ensureRuntime },
		);
		let rootIds: IpythonProcessIds | undefined;
		let childIds: IpythonProcessIds | undefined;
		const context = (
			role: "root" | "child",
			sequence: number,
		): NonNullable<Parameters<IpythonKernelProvisioner["execute"]>[1]>["hostContext"] => {
			const cwd = role === "root" ? rootCwd : childCwd;
			const sidecar = role === "root" ? rootSidecar : childSidecar;
			return {
				sessionId: `${role}-session`,
				cwd,
				cellId: `${role}-cell-${sequence}`,
				sequence,
				origin: "model",
				authority: "trusted-cell",
				allocateArtifact: async request => ({
					path: path.join(sidecar, `${role}-${request.label}.txt`),
					mimeType: request.mimeType,
					label: request.label,
					bytes: 0,
				}),
			};
		};
		try {
			await Promise.all([root.ensure(), child.ensure()]);
			rootIds = root.processIds;
			childIds = child.processIds;
			if (!rootIds || !childIds) throw new Error("root and child kernels did not start");
			expect(
				new Set([rootIds.controllerPid, rootIds.kernelPid, childIds.controllerPid, childIds.kernelPid]).size,
			).toBe(4);
			const rootCode = [
				"import agent_message, json, rlm",
				"from rlm import host_request",
				"from omp import session",
				"await host_request('test.barrier')",
				"info = await session.info()",
				"artifact = await session.allocate_artifact('proof', mime_type='text/plain', suffix='.txt')",
				"spawned = await rlm('root work', name='root-worker', isolated=False)",
				"children = await rlm.list_subagents()",
				"roster = await agent_message.list_agents()",
				"receipt = await agent_message.send('hello child', receiver_role='child', receiver_name='child-runtime')",
				"print(json.dumps({'info': info, 'artifact': artifact, 'spawned': spawned.name, 'children': [item.rlm_child_id for item in children], 'relations': [item['relationship'] for item in roster['entries']], 'receipt': receipt['deliveryStatus']}, sort_keys=True))",
			].join("\n");
			const childCode = [
				"import agent_message, json, rlm",
				"from rlm import host_request",
				"from omp import session",
				"await host_request('test.barrier')",
				"info = await session.info()",
				"artifact = await session.allocate_artifact('proof', mime_type='text/plain', suffix='.txt')",
				"spawned = await rlm('child work', name='child-worker', isolated=True, apply=False, merge='patch')",
				"children = await rlm.list_subagents()",
				"roster = await agent_message.list_agents()",
				"try:",
				"    await agent_message.send('escape', receiver_role='sibling', receiver_name='unrelated')",
				"    rejection = ''",
				"except RuntimeError as error:",
				"    rejection = str(error)",
				"print(json.dumps({'info': info, 'artifact': artifact, 'spawned': spawned.name, 'children': [item.rlm_child_id for item in children], 'relations': [item['relationship'] for item in roster['entries']], 'rejection': rejection}, sort_keys=True))",
			].join("\n");
			const [rootResult, childResult] = await Promise.all([
				root.execute(rootCode, { hostContext: context("root", 1) }),
				child.execute(childCode, { hostContext: context("child", 1) }),
			]);
			if (rootResult.status !== "ok") {
				throw new Error(`root cell failed: ${rootResult.stderr} ${JSON.stringify(rootResult.errors)}`);
			}
			if (childResult.status !== "ok") {
				throw new Error(`child cell failed: ${childResult.stderr} ${JSON.stringify(childResult.errors)}`);
			}
			const rootPayload = JSON.parse(rootResult.stdout.trim()) as Record<string, unknown>;
			const childPayload = JSON.parse(childResult.stdout.trim()) as Record<string, unknown>;
			expect(rootPayload).toMatchObject({
				info: { sessionId: "root-session", cwd: rootCwd },
				artifact: { artifact: { path: path.join(rootSidecar, "root-proof.txt") } },
				spawned: "root-worker",
				children: ["child-runtime"],
				relations: ["child"],
				receipt: "delivered",
			});
			expect(childPayload).toMatchObject({
				info: { sessionId: "child-session", cwd: childCwd },
				artifact: { artifact: { path: path.join(childSidecar, "child-proof.txt") } },
				spawned: "child-worker",
				children: [],
				relations: ["parent"],
			});
			expect(String(childPayload.rejection)).toContain("outside the nuclear family");
			expect(barrierSessions).toEqual(new Set(["root-session", "child-session"]));
			const policies = admissions.map(item => ({ role: item.role, isolation: item.request.isolation }));
			expect(policies).toHaveLength(2);
			expect(policies).toEqual(
				expect.arrayContaining([
					{ role: "root", isolation: { requested: false } },
					{ role: "child", isolation: { requested: true, apply: false, merge: "patch" } },
				]),
			);
			expect(messages).toEqual([{ role: "root", receiver: "child-runtime", message: "hello child" }]);

			const cancelling = child.execute("import rlm\nawait rlm('cancel me')", { hostContext: context("child", 2) });
			await blocked.promise;
			await child.interrupt();
			const cancelled = await cancelling;
			expect(cancelled.status).toBe("aborted");
			expect(blockedAborted).toBe(true);
		} finally {
			await Promise.all([root.dispose(), child.dispose()]);
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of [rootIds, childIds]) {
			if (!ids) continue;
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);

	test("restores a session snapshot before installing fresh reserved names", async () => {
		const pythonExecutable = Bun.env.OMP_IPYTHON_TEST_PYTHON;
		if (!pythonExecutable) throw new Error("OMP_IPYTHON_TEST_PYTHON is required when OMP_IPYTHON_INTEGRATION=1");
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-provisioner-"));
		const home = path.join(tempRoot, "home");
		const sidecarDir = path.join(tempRoot, "sidecar");
		const extensionPython = path.join(tempRoot, "extension-python");
		await fs.mkdir(home);
		await fs.mkdir(extensionPython);
		await fs.writeFile(path.join(extensionPython, "rlm.py"), "source = 'extension'\n");
		await fs.writeFile(path.join(extensionPython, "omp.py"), "source = 'extension'\n");
		const ensureRuntime = async (options: EnsureIpythonRuntimeOptions): Promise<IpythonRuntime> => ({
			pythonExecutable,
			runtimeDir: path.dirname(pythonExecutable),
			pythonPackageDir: path.join(path.dirname(pythonExecutable), "python"),
			environment: {
				...ipythonEnvironment(options.environment),
				OMP_IPYTHON_RUNTIME_PATH: pythonAbiSourcePath(),
			},
		});
		const baseOptions = {
			cwd: tempRoot,
			sessionId: "persistent-session",
			sidecarDir,
			environment: {
				HOME: home,
				PATH: `${path.dirname(pythonExecutable)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				ANTHROPIC_API_KEY: "must-not-reach-kernel",
			},
			pythonPaths: [extensionPython],
			hostHandlers: {
				"session.info": (request: IpythonHostRequest) => ({
					sessionId: request.sessionId,
					cwd: request.cwd,
					cellId: request.cellId,
					sequence: request.sequence,
					origin: request.origin,
					authority: request.authority,
				}),
			},
			bootstrapCode: "rlm = {'generation': 'fresh'}\nomp = {'generation': 'fresh'}",
		} as const;
		let firstIds: IpythonProcessIds | undefined;
		let secondIds: IpythonProcessIds | undefined;
		try {
			const firstProgress: IpythonStartupProgress[] = [];
			const first = new IpythonKernelProvisioner(baseOptions, { ensureRuntime });
			await first.ensure(progress => firstProgress.push(progress));
			firstIds = first.processIds;
			expect(first.lastRestore).toMatchObject({ missing: true, restored: [] });
			const reservedModules = await first.execute(
				"import importlib; (hasattr(importlib.import_module('rlm'), 'run'), hasattr(importlib.import_module('omp'), 'capabilities'), importlib.import_module('rlm').__file__.startswith(" +
					JSON.stringify(extensionPython) +
					"))",
			);
			expect(reservedModules.result).toBe("(True, True, False)");
			const hostInfo = await first.execute(
				"import importlib; importlib.import_module('rlm').host_request_sync('session.info')",
				{
					hostContext: {
						sessionId: "persistent-session",
						cwd: tempRoot,
						cellId: "provisioner-cell",
						sequence: 4,
						origin: "model",
						authority: "trusted-cell",
					},
				},
			);
			expect(hostInfo.status).toBe("ok");
			expect(hostInfo.result).toContain("'cellId': 'provisioner-cell'");
			expect(hostInfo.result).toContain("'sessionId': 'persistent-session'");
			const environment = await first.execute(
				"import os\nprint(os.environ['OMP_SESSION_ID'])\nprint(os.environ['OMP_SESSION_CWD'])\nprint(os.environ['OMP_SESSION_ARTIFACT_DIR'])\nprint('ANTHROPIC_API_KEY' in os.environ)",
			);
			expect(environment.stdout.split("\n")).toEqual(["persistent-session", tempRoot, sidecarDir, "False", ""]);
			const stored = await first.execute("persistent_value = 41\nasyncio = 'stale'\nrlm = 'stale'\nomp = 'stale'");
			expect(stored.status).toBe("ok");
			const snapshot = await first.flushSnapshot();
			expect(snapshot?.saved).toContain("persistent_value");
			expect(snapshot?.saved).not.toContain("asyncio");
			expect(snapshot?.saved).not.toContain("rlm");
			expect(snapshot?.saved).not.toContain("omp");
			await first.dispose();

			const second = new IpythonKernelProvisioner(baseOptions, { ensureRuntime });
			await second.ensure();
			secondIds = second.processIds;
			expect(second.lastRestore).toMatchObject({ missing: false });
			expect(second.lastRestore?.restored).toContain("persistent_value");
			const resumed = await second.execute(
				"(persistent_value + 1, asyncio.__name__, rlm['generation'], omp['generation'])",
			);
			expect(resumed.status).toBe("ok");
			expect(resumed.result).toBe("(42, 'asyncio', 'fresh', 'fresh')");
			await second.dispose();
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
		for (const ids of [firstIds, secondIds]) {
			if (!ids) continue;
			expect(processExists(ids.controllerPid)).toBe(false);
			expect(processExists(ids.kernelPid)).toBe(false);
		}
	}, 120_000);
});

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type IpythonCellProvisioner, IpythonCellService } from "../../src/ipython/cell.js";
import type {
	IpythonExecutionEvent,
	IpythonExecutionResult,
	IpythonRestoreResult,
	IpythonSnapshotResult,
} from "../../src/ipython/controller.js";
import { createFoundationalIpythonHostHandlers } from "../../src/ipython/host-bridge.js";
import { ipythonSnapshotPath } from "../../src/ipython/provisioner.js";
import type { PythonSkillPackage } from "../../src/ipython/python-packages.js";
import {
	classifyIpythonRestore,
	formatIpythonRestoreNotice,
	type IpythonRestoreStatus,
	type IpythonSessionGeneration,
	type IpythonSessionGenerationFactory,
	type IpythonSessionGenerationOptions,
	type IpythonSessionIdentity,
	IpythonSessionRuntime,
	type IpythonSessionRuntimeOptions,
	ipythonCheckpointSnapshotPath,
} from "../../src/session/ipython-session.js";
import { sessionSidecarDir } from "../../src/session/session-paths.js";
import { FileSessionStorage } from "../../src/session/session-storage.js";

function execution(id: string, value: string | undefined): IpythonExecutionResult {
	const events: IpythonExecutionEvent[] =
		value === undefined ? [] : [{ kind: "result", data: { "text/plain": value } }];
	return {
		id,
		status: "ok",
		stdout: "",
		stderr: "",
		result: value,
		events,
		errors: [],
		hostArtifacts: [],
	};
}

function missingRestore(snapshotPath: string): IpythonRestoreResult {
	return { restored: [], failed: [], missing: true, path: snapshotPath };
}

class MemoryProvisioner implements IpythonCellProvisioner {
	readonly names = new Map<string, string>();
	readonly #options: IpythonSessionGenerationOptions;
	readonly #snapshots: Map<string, Map<string, string>>;
	#restored = false;
	disposed = false;

	constructor(options: IpythonSessionGenerationOptions, snapshots: Map<string, Map<string, string>>) {
		this.#options = options;
		this.#snapshots = snapshots;
	}

	async ensure(): Promise<void> {
		if (this.#restored) return;
		this.#restored = true;
		const restorePath =
			this.#options.restorePath === undefined ? this.#options.snapshotPath : this.#options.restorePath;
		const snapshot = restorePath === null ? undefined : this.#snapshots.get(restorePath);
		if (!snapshot || restorePath === null) {
			this.#options.onRestore(missingRestore(restorePath ?? this.#options.snapshotPath));
			return;
		}
		for (const [name, value] of snapshot) this.names.set(name, value);
		this.#options.onRestore({ restored: [...snapshot.keys()], failed: [], missing: false, path: restorePath });
	}

	async execute(code: string): Promise<IpythonExecutionResult> {
		const [operation, name, ...rest] = code.split(":");
		if (operation === "fail-large") {
			const error = {
				kind: "error" as const,
				ename: "AssertionError",
				evalue: "final failing assertion",
				traceback: ["AssertionError: final failing assertion", "gh run watch exited with status 1"],
			};
			return {
				id: code,
				status: "error",
				stdout: "",
				stderr: "",
				result: undefined,
				events: [
					{
						kind: "stream",
						name: "stdout",
						text: `$ gh run watch 481516 --exit-status\n${"x".repeat(200 * 1024)}`,
					},
					error,
				],
				errors: [error],
				hostArtifacts: [],
			};
		}
		if (operation === "set" && name) {
			this.names.set(name, rest.join(":"));
			return execution(code, undefined);
		}
		if (operation === "get" && name) return execution(code, this.names.get(name));
		return execution(code, code);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
	}
}

class MemoryGeneration implements IpythonSessionGeneration {
	readonly service: IpythonCellService;
	readonly provisioner: MemoryProvisioner;
	readonly options: IpythonSessionGenerationOptions;
	readonly snapshots: Map<string, Map<string, string>>;
	readonly processIds;
	readonly reloadedPackages: PythonSkillPackage[][] = [];
	failReload = false;
	prewarmCount = 0;
	flushCount = 0;
	failSnapshots = false;
	hangSnapshots = false;

	constructor(options: IpythonSessionGenerationOptions, index: number, snapshots: Map<string, Map<string, string>>) {
		this.options = options;
		this.snapshots = snapshots;
		this.provisioner = new MemoryProvisioner(options, snapshots);
		this.service = new IpythonCellService(this.provisioner);
		this.processIds = { controllerPid: index * 2 + 1, kernelPid: index * 2 + 2 };
	}

	prewarm(): void {
		this.prewarmCount += 1;
		void this.provisioner.ensure();
	}

	ready(): Promise<void> {
		return this.provisioner.ensure();
	}

	async reloadPythonPackages(packages: readonly PythonSkillPackage[]): Promise<void> {
		if (this.failReload) throw new Error("injected package reload failure");
		this.reloadedPackages.push([...packages]);
	}

	async flushSnapshot(pathOverride?: string): Promise<IpythonSnapshotResult> {
		this.flushCount += 1;
		if (this.failSnapshots) throw new Error("injected snapshot failure");
		if (this.hangSnapshots) return await new Promise<IpythonSnapshotResult>(() => {});
		const snapshotPath = pathOverride ?? this.options.snapshotPath;
		this.snapshots.set(snapshotPath, new Map(this.provisioner.names));
		const saved = [...this.provisioner.names.keys()];
		return {
			saved,
			skipped: [],
			oversized: [],
			failed: [],
			bytes: saved.length,
			path: snapshotPath,
			manifestPath: `${snapshotPath}.json`,
		};
	}

	dispose(): Promise<void> {
		return this.service.dispose();
	}
}

function runtimeHarness(initialIdentity: IpythonSessionIdentity, runtimeOptions: IpythonSessionRuntimeOptions = {}) {
	let identity = initialIdentity;
	const generations: MemoryGeneration[] = [];
	const snapshots = new Map<string, Map<string, string>>();
	const restores: Array<{ result: IpythonRestoreResult; status: IpythonRestoreStatus }> = [];
	const snapshotFailures: string[] = [];
	const factory: IpythonSessionGenerationFactory = options => {
		const generation = new MemoryGeneration(options, generations.length, snapshots);
		generations.push(generation);
		return generation;
	};
	const runtime = new IpythonSessionRuntime(
		{
			currentIdentity: () => identity,
			onRestore: (result, status) => restores.push({ result, status }),
			onSnapshotFailure: message => snapshotFailures.push(message),
			onArtifactFailure: message => snapshotFailures.push(message),
			onReady: () => {},
		},
		factory,
		runtimeOptions,
	);
	return {
		runtime,
		generations,
		snapshots,
		restores,
		snapshotFailures,
		setIdentity(next: IpythonSessionIdentity) {
			identity = next;
		},
	};
}

describe("session IPython runtime", () => {
	test("updates pending package sets without creating a generation and reloads active generations transactionally", async () => {
		const identity = {
			sessionId: "root",
			cwd: "/work/root",
			sessionFile: "/sessions/root.jsonl",
			sessionDir: "/sessions",
		};
		const first = {
			importName: "first",
			callableName: "run",
			projectName: "first",
			packageRoot: "/p",
			sourceRoot: "/p/src",
			skillPath: "/p/SKILL.md",
			files: [],
			contentHash: "a",
			skill: { name: "pkg", description: "pkg", filePath: "/p/SKILL.md", baseDir: "/p", source: "test" },
		} satisfies PythonSkillPackage;
		const second = { ...first, importName: "second", projectName: "second", contentHash: "b" };
		const harness = runtimeHarness(identity, { pythonPackages: () => [first] });
		await harness.runtime.reloadPythonPackages([second]);
		expect(harness.generations).toHaveLength(0);
		await harness.runtime.execute({ code: "get:name", origin: "model" });
		expect(harness.generations[0]?.options.pythonPackages).toEqual([second]);
		await harness.runtime.reloadPythonPackages([first]);
		expect(harness.generations[0]?.reloadedPackages).toEqual([[first]]);
	});

	test("keeps the accepted package set when an active generation rejects reload", async () => {
		const identity = { sessionId: "root", cwd: "/work/root", sessionFile: undefined, sessionDir: "/sessions" };
		const pkg = {
			importName: "pkg",
			callableName: "run",
			projectName: "pkg",
			packageRoot: "/p",
			sourceRoot: "/p/src",
			skillPath: "/p/SKILL.md",
			files: [],
			contentHash: "a",
			skill: { name: "pkg", description: "pkg", filePath: "/p/SKILL.md", baseDir: "/p", source: "test" },
		} satisfies PythonSkillPackage;
		const harness = runtimeHarness(identity, { pythonPackages: () => [pkg] });
		await harness.runtime.execute({ code: "get:name", origin: "model" });
		harness.generations[0]!.failReload = true;
		await expect(harness.runtime.reloadPythonPackages([])).rejects.toThrow("injected package reload failure");
		await harness.runtime.dispose();
	});

	test("lazily shares one generation across model and direct cells and snapshots successful state", async () => {
		const identity = {
			sessionId: "root",
			cwd: "/work/root",
			sessionFile: "/sessions/root.jsonl",
			sessionDir: "/sessions",
		};
		const harness = runtimeHarness(identity, { hostHandlers: createFoundationalIpythonHostHandlers });
		try {
			expect(harness.generations).toHaveLength(0);
			await harness.runtime.execute({ code: "set:shared:41", origin: "model" });
			const direct = await harness.runtime.execute({ code: "get:shared", origin: "direct" });
			expect(direct.result).toBe("41");
			expect(harness.generations).toHaveLength(1);
			expect(Object.keys(harness.generations[0]?.options.hostHandlers ?? {}).sort()).toEqual([
				"artifact.allocate",
				"cell.display",
				"cell.progress",
				"session.info",
			]);
			expect(harness.runtime.sessionId).toBe("root");
			expect(harness.runtime.processIds).toEqual({ controllerPid: 1, kernelPid: 2 });
			const snapshot = await harness.runtime.flushSnapshot();
			expect(snapshot?.saved).toEqual(["shared"]);
			expect(harness.generations[0]?.flushCount).toBeGreaterThan(0);
			expect(harness.restores).toEqual([
				{ result: missingRestore(ipythonSnapshotPath(sessionSidecarDir(identity.sessionFile))), status: "missing" },
			]);
		} finally {
			await harness.runtime.dispose();
		}
	});

	test("returns a bounded failure with its deterministic full-result artifact path", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-session-artifact-"));
		const sessionFile = path.join(root, "session.jsonl");
		const harness = runtimeHarness({ sessionId: "root", cwd: root, sessionFile, sessionDir: root });
		try {
			const result = await harness.runtime.execute({ code: "fail-large", origin: "model" });
			const full = result.artifacts.find(artifact => artifact.label === "Full IPython result");
			if (!full) throw new Error("full result artifact was not returned");
			expect(result.modelText.outputBytes).toBeLessThanOrEqual(50 * 1024);
			expect(result.modelText.text).toContain(`full result: ${full.path}`);
			expect(full.path).toBe(
				path.join(sessionSidecarDir(sessionFile), "ipython", "artifacts", result.cellId, "full-result.json"),
			);
			expect(JSON.parse(await fs.readFile(full.path, "utf8")).events).toHaveLength(2);
		} finally {
			await harness.runtime.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("suspends the old identity before creating an isolated child generation", async () => {
		const root = {
			sessionId: "root",
			cwd: "/work/root",
			sessionFile: "/sessions/root.jsonl",
			sessionDir: "/sessions",
		};
		const child = {
			sessionId: "child",
			cwd: "/work/child",
			sessionFile: "/sessions/child.jsonl",
			sessionDir: "/sessions",
		};
		const harness = runtimeHarness(root);
		try {
			await harness.runtime.execute({ code: "set:private:root", origin: "model" });
			const first = harness.generations[0];
			await harness.runtime.suspend();
			expect(first?.provisioner.disposed).toBe(true);
			harness.setIdentity(child);
			harness.runtime.resume();
			const fresh = await harness.runtime.execute({ code: "get:private", origin: "direct" });
			expect(fresh.result).toBeUndefined();
			expect(harness.generations).toHaveLength(2);
			expect(harness.generations[1]?.options).toMatchObject({
				identity: child,
				sidecarDir: sessionSidecarDir(child.sessionFile),
			});
			expect(harness.generations[0]?.processIds).not.toEqual(harness.generations[1]?.processIds);
		} finally {
			await harness.runtime.dispose();
		}
	});

	test("restores a named checkpoint while keeping the live snapshot path current", async () => {
		const identity = {
			sessionId: "checkpoint-root",
			cwd: "/work/root",
			sessionFile: "/sessions/checkpoint-root.jsonl",
			sessionDir: "/sessions",
		};
		const harness = runtimeHarness(identity);
		await harness.runtime.execute({ origin: "model", code: "set:value:checkpoint" });
		await harness.runtime.createCheckpoint("checkpoint-entry");
		await harness.runtime.execute({ origin: "direct", code: "set:value:later" });
		await harness.runtime.rewindCheckpoint("checkpoint-entry");
		const restored = await harness.runtime.execute({ origin: "model", code: "get:value" });
		expect(restored.result).toBe("checkpoint");
		expect(harness.generations).toHaveLength(2);
		const checkpointPath = ipythonCheckpointSnapshotPath(sessionSidecarDir(identity.sessionFile), "checkpoint-entry");
		expect(harness.generations[1]?.options.restorePath).toBe(checkpointPath);
		expect(harness.generations[1]?.options.snapshotPath).toBe(
			ipythonSnapshotPath(sessionSidecarDir(identity.sessionFile)),
		);
		await harness.runtime.dispose();
	});

	test("starts a fresh heap after a committed historical branch", async () => {
		const identity = {
			sessionId: "historical-root",
			cwd: "/work/root",
			sessionFile: "/sessions/historical-root.jsonl",
			sessionDir: "/sessions",
		};
		const harness = runtimeHarness(identity);
		await harness.runtime.execute({ origin: "model", code: "set:value:latest" });
		await harness.runtime.flushSnapshot();
		await harness.runtime.suspend();
		await harness.runtime.abandonHistoricalState();
		harness.runtime.resume();
		const fresh = await harness.runtime.execute({ origin: "direct", code: "get:value" });
		expect(fresh.result).toBeUndefined();
		expect(harness.generations).toHaveLength(2);
		expect(harness.generations[1]?.options.restorePath).toBeNull();
		await harness.runtime.dispose();
	});

	test("renders one bounded escaped admitted-name notice without values", async () => {
		const harness = runtimeHarness({
			sessionId: "notice",
			cwd: "/work",
			sessionFile: "/sessions/notice.jsonl",
			sessionDir: "/sessions",
		});
		try {
			await harness.runtime.execute({ code: "set:alpha:secret-value", origin: "model" });
			await harness.runtime.execute({ code: "set:<unsafe>:another-value", origin: "direct" });
			await harness.runtime.execute({ code: "set:line\nname:hidden-value", origin: "model" });
			for (let index = 0; index < 120; index += 1) {
				await harness.runtime.execute({ code: `set:name-${index}:value-${index}`, origin: "model" });
			}
			const notice = await harness.runtime.stateNotice();
			expect(notice).toStartWith("<ipython_state>");
			expect(notice).toEndWith("</ipython_state>");
			expect(notice).toContain("&lt;unsafe&gt;");
			expect(notice).toContain("line\\nname");
			expect(notice).toContain("more names omitted");
			expect(notice).not.toContain("secret-value");
			expect(Buffer.byteLength(notice ?? "", "utf-8")).toBeLessThanOrEqual(2 * 1024);
		} finally {
			await harness.runtime.dispose();
		}
	});

	test("reports one repeated snapshot failure and remains disposable", async () => {
		const harness = runtimeHarness({
			sessionId: "failure",
			cwd: "/work",
			sessionFile: "/sessions/failure.jsonl",
			sessionDir: "/sessions",
		});
		try {
			await harness.runtime.execute({ code: "set:value:1", origin: "model" });
			const generation = harness.generations[0];
			if (!generation) throw new Error("generation was not created");
			generation.failSnapshots = true;
			await harness.runtime.flushSnapshot();
			await harness.runtime.flushSnapshot();
			expect(harness.snapshotFailures).toEqual(["injected snapshot failure"]);
			expect(await harness.runtime.stateNotice()).toContain('status="failed"');
		} finally {
			await harness.runtime.dispose();
		}
	});

	test("bounds final snapshot drain and still disposes the generation", async () => {
		const identity = {
			sessionId: "bounded-dispose",
			cwd: "/work/root",
			sessionFile: "/sessions/bounded-dispose.jsonl",
			sessionDir: "/sessions",
		};
		const harness = runtimeHarness(identity, { snapshotDrainTimeoutMs: 0 });
		await harness.runtime.execute({ origin: "model", code: "set:value:pending" });
		const generation = harness.generations[0];
		if (!generation) throw new Error("test generation was not created");
		generation.hangSnapshots = true;
		await harness.runtime.execute({ origin: "direct", code: "set:value:hanging-snapshot" });
		await harness.runtime.dispose();
		expect(generation.provisioner.disposed).toBe(true);
		expect(harness.snapshotFailures).toContain(
			"Timed out draining IPython snapshots after 0ms; continuing shutdown.",
		);
	});

	test("removes current and named IPython state with its session sidecar", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-sidecar-delete-"));
		try {
			const sessionFile = path.join(root, "session.jsonl");
			const sidecarDir = sessionSidecarDir(sessionFile);
			const latest = ipythonSnapshotPath(sidecarDir);
			const named = ipythonCheckpointSnapshotPath(sidecarDir, "checkpoint");
			await fs.mkdir(path.dirname(named), { recursive: true });
			await Promise.all([
				fs.writeFile(sessionFile, "session"),
				fs.writeFile(latest, "latest"),
				fs.writeFile(named, "named"),
			]);
			await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile);
			await expect(fs.stat(sessionFile)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(latest)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(named)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("prewarms only a persisted snapshot and removes an ephemeral sidecar", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-session-runtime-"));
		const sessionFile = path.join(tempRoot, "persisted.jsonl");
		const snapshotPath = ipythonSnapshotPath(sessionSidecarDir(sessionFile));
		await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
		await fs.writeFile(snapshotPath, "snapshot");
		const persisted = runtimeHarness({ sessionId: "persisted", cwd: tempRoot, sessionFile, sessionDir: tempRoot });
		persisted.runtime.prewarm();
		expect(persisted.generations).toHaveLength(1);
		expect(persisted.generations[0]?.prewarmCount).toBe(1);
		await persisted.runtime.dispose();

		const ephemeral = runtimeHarness({
			sessionId: `ephemeral-${crypto.randomUUID()}`,
			cwd: tempRoot,
			sessionFile: undefined,
			sessionDir: tempRoot,
		});
		await ephemeral.runtime.execute({ code: "set:value:1", origin: "model" });
		const ephemeralDir = ephemeral.generations[0]?.options.sidecarDir;
		if (!ephemeralDir) throw new Error("ephemeral sidecar was not created");
		await fs.mkdir(ephemeralDir, { recursive: true });
		await fs.writeFile(path.join(ephemeralDir, "sentinel"), "x");
		await ephemeral.runtime.dispose();
		expect(await Bun.file(path.join(ephemeralDir, "sentinel")).exists()).toBe(false);
		await fs.rm(tempRoot, { recursive: true, force: true });
	});
});

describe("IPython restore reports", () => {
	test("classifies complete, partial, missing, and failed restore states", () => {
		const cases: Array<{ result: IpythonRestoreResult; status: IpythonRestoreStatus; text: string }> = [
			{
				result: { restored: ["a"], failed: [], missing: false, path: "/state" },
				status: "complete",
				text: "restored 1 admitted name",
			},
			{
				result: { restored: ["a"], failed: [{ name: "b", reason: "bad" }], missing: false, path: "/state" },
				status: "partial",
				text: "1 failed",
			},
			{ result: missingRestore("/state"), status: "missing", text: "not present" },
			{
				result: { restored: [], failed: [{ name: "<snapshot>", reason: "bad" }], missing: false, path: "/state" },
				status: "failed",
				text: "started fresh",
			},
		];
		for (const item of cases) {
			expect(classifyIpythonRestore(item.result)).toBe(item.status);
			expect(formatIpythonRestoreNotice(item.result).message).toContain(item.text);
		}
	});
});

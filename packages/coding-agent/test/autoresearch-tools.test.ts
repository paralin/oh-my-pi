import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { executeInitExperimentOwner } from "@oh-my-pi/pi-coding-agent/autoresearch/operations/init-experiment";
import { executeLogExperimentOwner } from "@oh-my-pi/pi-coding-agent/autoresearch/operations/log-experiment";
import { executeRunExperimentOwner } from "@oh-my-pi/pi-coding-agent/autoresearch/operations/run-experiment";
import { executeUpdateNotesOwner } from "@oh-my-pi/pi-coding-agent/autoresearch/operations/update-notes";
import { createSessionRuntime } from "@oh-my-pi/pi-coding-agent/autoresearch/state";
import {
	type AutoresearchStorage,
	closeAllAutoresearchStorages,
	openAutoresearchStorage,
	type SessionRow,
} from "@oh-my-pi/pi-coding-agent/autoresearch/storage";
import type { ASIData, LogDetails, NumericMetricMap, RunDetails } from "@oh-my-pi/pi-coding-agent/autoresearch/types";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

afterEach(() => {
	vi.restoreAllMocks();
});

function firstTextBlockText(content: Array<TextContent | ImageContent>): string {
	const block = content.find((c): c is TextContent => c.type === "text");
	if (!block) throw new Error("expected a text tool content block");
	return block.text;
}

function makeTempDir(prefix = "@pi-autoresearch-tools-"): TempDir {
	return TempDir.createSync(prefix);
}

function dashboardStub() {
	return {
		clear(): void {},
		requestRender(): void {},
		showOverlay: async (): Promise<void> => {},
		updateWidget(): void {},
	};
}

function createCtx(cwd: string): ExtensionContext {
	return { cwd, hasUI: false } as ExtensionContext;
}

interface PiHarness {
	api: ExtensionAPI;
	appendEntries: Array<{ customType: string; data: unknown }>;
}

function createPiHarness(): PiHarness {
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const api = {
		appendEntry: (customType: string, data?: unknown) => {
			appendEntries.push({ customType, data });
		},
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	} as unknown as ExtensionAPI;
	return { api, appendEntries };
}

// `git init` + identity + a baseline commit costs ~75ms; doing it once and
// filesystem-copying the resulting repo per test is ~1ms. Every test then runs
// inside a real repo, so the production tools resolve HEAD/branch from `.git` on
// disk (sub-millisecond) instead of spawning fallback git subprocesses for every
// `repo.root` / `branch.current` / `head.sha` lookup against a bare temp dir.
let templateRepo: TempDir;
let templateBranchRepo: TempDir;
let templateBaselineCommit: string;

beforeAll(async () => {
	templateRepo = makeTempDir("@pi-autoresearch-template-");
	await Bun.write(path.join(templateRepo.path(), "README.md"), "# baseline\n");
	await $`git init --initial-branch=main && git config core.autocrlf false && git config core.fsmonitor false && git config user.email tester@example.com && git config user.name Tester && git add -A && git commit -m baseline`
		.cwd(templateRepo.path())
		.quiet();
	templateBaselineCommit = (await $`git rev-parse HEAD`.cwd(templateRepo.path()).text()).trim();
	// Second fixture: harness committed and already on an `autoresearch/*` branch,
	// the baseline for executeLogExperimentOwner's on-branch keep/discard scenarios.
	templateBranchRepo = makeTempDir("@pi-autoresearch-template-branch-");
	fs.cpSync(templateRepo.path(), templateBranchRepo.path(), { recursive: true });
	await Bun.write(path.join(templateBranchRepo.path(), "autoresearch.sh"), "#!/usr/bin/env bash\necho METRIC m=1\n");
	await $`git add -A && git commit -m harness && git checkout -b autoresearch/base`
		.cwd(templateBranchRepo.path())
		.quiet();
});

afterAll(async () => {
	closeAllAutoresearchStorages();
	await Bun.sleep(0);
	await templateRepo.remove();
	await templateBranchRepo.remove();
});

// Independent working copy of the template repo: baseline commit on `main`,
// committer identity configured, ready for per-test branch/commit scenarios.
function freshRepo(): { dir: string; baselineCommit: string } {
	const dir = makeTempDir().path();
	fs.cpSync(templateRepo.path(), dir, { recursive: true });
	return { dir, baselineCommit: templateBaselineCommit };
}

// Like freshRepo, but already on an `autoresearch/*` branch with the harness
// committed — the baseline for executeLogExperimentOwner's on-branch keep/discard paths.
function freshBranchRepo(): { dir: string } {
	const dir = makeTempDir().path();
	fs.cpSync(templateBranchRepo.path(), dir, { recursive: true });
	return { dir };
}

async function checkoutBranch(dir: string, name: string): Promise<void> {
	await $`git checkout -b ${name}`.cwd(dir).quiet();
}

async function writeHarnessStub(dir: string, body = "echo METRIC m=1"): Promise<void> {
	await Bun.write(path.join(dir, "autoresearch.sh"), `#!/usr/bin/env bash\n${body}\n`);
}

// Insert a completed-but-unlogged run straight into storage, mirroring what
// executeRunExperimentOwner persists. Tests that exercise executeLogExperimentOwner use this instead
// of spawning the benchmark subprocess (and executeRunExperimentOwner's own git status
// calls), which are incidental to the log contract under test.
function seedCompletedRun(
	storage: AutoresearchStorage,
	session: SessionRow,
	opts: {
		preRunDirtyPaths?: string[];
		parsedPrimary?: number | null;
		parsedMetrics?: NumericMetricMap | null;
		parsedAsi?: ASIData | null;
	} = {},
): void {
	const now = Date.now();
	const run = storage.insertRun({
		sessionId: session.id,
		segment: session.currentSegment,
		command: "bash autoresearch.sh",
		startedAt: now,
		logPath: "",
		preRunDirtyPaths: opts.preRunDirtyPaths ?? [],
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: now + 1,
		durationMs: 1,
		exitCode: 0,
		timedOut: false,
		parsedPrimary: opts.parsedPrimary ?? null,
		parsedMetrics: opts.parsedMetrics ?? null,
		parsedAsi: opts.parsedAsi ?? null,
	});
}

describe("executeInitExperimentOwner", () => {
	let dbOverride: TempDir;

	beforeEach(() => {
		dbOverride = makeTempDir("@pi-autoresearch-init-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		await Bun.sleep(0);
		await dbOverride.remove();
	});

	it("opens a new session and persists scope and metric metadata", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};

		const result = await executeInitExperimentOwner(tool, createCtx(dir), {
			name: "speed",
			goal: "make x fast",
			primary_metric: "runtime_ms",
			metric_unit: "ms",
			direction: "lower",
			scope_paths: ["src", "src/foo"],
			off_limits: ["test"],
			secondary_metrics: ["memory_mb"],
			constraints: ["no api break"],
			max_iterations: 50,
		});
		expect(firstTextBlockText(result.content)).toContain("Started session");
		expect(result.details?.createdSession).toBe(true);
		expect(result.details?.bumpedSegment).toBe(false);

		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		expect(session).not.toBeNull();
		expect(session?.primaryMetric).toBe("runtime_ms");
		expect(session?.scopePaths).toEqual(["src", "src/foo"]);
		expect(session?.offLimits).toEqual(["test"]);
		expect(session?.secondaryMetrics).toEqual(["memory_mb"]);
		expect(session?.maxIterations).toBe(50);
	});

	it("updates fields without bumping segment when no new_segment flag is passed", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};

		await executeInitExperimentOwner(tool, createCtx(dir), { name: "a", primary_metric: "ms", scope_paths: ["src"] });
		const second = await executeInitExperimentOwner(tool, createCtx(dir), {
			name: "a",
			primary_metric: "ms",
			scope_paths: ["src", "lib"],
			goal: "v2",
		});
		expect(second.details?.createdSession).toBe(false);
		expect(second.details?.bumpedSegment).toBe(false);
		expect(second.details?.state.scopePaths).toEqual(["src", "lib"]);
		expect(second.details?.state.goal).toBe("v2");
		expect(second.details?.state.currentSegment).toBe(0);
	});

	it("bumps segment when new_segment is true on a re-init", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		await executeInitExperimentOwner(tool, createCtx(dir), { name: "x", primary_metric: "ms" });
		const result = await executeInitExperimentOwner(tool, createCtx(dir), {
			name: "x",
			primary_metric: "ms",
			new_segment: true,
		});
		expect(result.details?.bumpedSegment).toBe(true);
		expect(result.details?.state.currentSegment).toBe(1);
	});

	it("rejects when autoresearch.sh is missing on first init", async () => {
		const dir = freshRepo().dir;
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const result = await executeInitExperimentOwner(tool, createCtx(dir), { name: "x", primary_metric: "m" });
		expect(firstTextBlockText(result.content)).toContain("autoresearch.sh");
		const storage = await openAutoresearchStorage(dir);
		expect(storage.getActiveSession()).toBeNull();
	});

	it("auto-commits pending harness changes on an autoresearch branch", async () => {
		const { dir, baselineCommit: initialBaseline } = freshRepo();
		await checkoutBranch(dir, "autoresearch/setup-test");
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const result = await executeInitExperimentOwner(tool, createCtx(dir), {
			name: "x",
			primary_metric: "m",
			goal: "speed",
		});
		expect(result.details?.harnessCommitted).toBe(true);
		const newHead = await git.head.sha(dir);
		expect(newHead).not.toBe(initialBaseline);
		expect(result.details?.baselineCommit).toBe(newHead);
		const status = (await $`git status --porcelain`.cwd(dir).text()).trim();
		expect(status).toBe("");
		const message = (await $`git log -1 --pretty=%B`.cwd(dir).text()).trim();
		expect(message).toContain("autoresearch: harness setup");
	});

	it("does not auto-commit when not on an autoresearch branch", async () => {
		const { dir, baselineCommit: initialBaseline } = freshRepo();
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const tool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const result = await executeInitExperimentOwner(tool, createCtx(dir), { name: "x", primary_metric: "m" });
		expect(result.details?.harnessCommitted).toBe(false);
		const newHead = await git.head.sha(dir);
		expect(newHead).toBe(initialBaseline);
		// Harness file is still in the worktree, untracked.
		expect(fs.existsSync(path.join(dir, "autoresearch.sh"))).toBe(true);
	});
});

describe("executeRunExperimentOwner", () => {
	let dbOverride: TempDir;

	beforeEach(() => {
		dbOverride = makeTempDir("@pi-autoresearch-run-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		await Bun.sleep(0);
		await dbOverride.remove();
	});

	it("rejects when no session is active", async () => {
		const dir = freshRepo().dir;
		const runtime = createSessionRuntime();
		const run = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const result = await executeRunExperimentOwner(run, createCtx(dir), {}, undefined, undefined);
		expect(firstTextBlockText(result.content)).toContain("no active autoresearch session");
	});

	it("accepts arbitrary commands, parses METRIC/ASI, and stores a run", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir, "echo METRIC runtime_ms=42; echo METRIC memory_mb=12; echo ASI hypothesis=baseline");
		const runtime = createSessionRuntime();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), {
			name: "speed",
			primary_metric: "runtime_ms",
			metric_unit: "ms",
		});
		const run = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const result = await executeRunExperimentOwner(run, createCtx(dir), { timeout_seconds: 5 }, undefined, undefined);
		const details = result.details as RunDetails;
		expect(details.parsedPrimary).toBe(42);
		expect(details.parsedMetrics).toMatchObject({ runtime_ms: 42, memory_mb: 12 });
		expect(details.parsedAsi).toMatchObject({ hypothesis: "baseline" });
		expect(details.passed).toBe(true);
		expect(details.command).toBe("bash autoresearch.sh");
		expect(fs.existsSync(details.benchmarkLogPath)).toBe(true);

		const storage = await openAutoresearchStorage(dir);
		const session = storage.getActiveSession();
		const runs = storage.listRuns(session!.id);
		expect(runs).toHaveLength(1);
		expect(runs[0].parsedPrimary).toBe(42);
		expect(runs[0].status).toBeNull();
	});

	it("abandons a prior pending run instead of blocking", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const initTool = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		await executeInitExperimentOwner(initTool, createCtx(dir), { name: "x", primary_metric: "m" });
		const run = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		// A seeded pending run stands in for the first executeRunExperimentOwner; the contract
		// under test is that the second run abandons it rather than blocking.
		const storage = await openAutoresearchStorage(dir);
		seedCompletedRun(storage, storage.getActiveSession()!, { parsedPrimary: 1, parsedMetrics: { m: 1 } });
		const result = await executeRunExperimentOwner(run, createCtx(dir), {}, undefined, undefined);
		const details = result.details as RunDetails;
		expect(details.abandonedPriorRun).not.toBeNull();
		expect(details.runNumber).not.toBe(details.abandonedPriorRun);
	});
});

describe("executeLogExperimentOwner", () => {
	let dbOverride: TempDir;

	beforeEach(() => {
		dbOverride = makeTempDir("@pi-autoresearch-log-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		await Bun.sleep(0);
		await dbOverride.remove();
	});

	async function setupRun(dir: string, runtime = createSessionRuntime()) {
		await writeHarnessStub(dir, "echo METRIC runtime_ms=10");
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), {
			name: "speed",
			primary_metric: "runtime_ms",
			metric_unit: "ms",
			scope_paths: ["src"],
			off_limits: ["forbidden"],
		});
		const storage = await openAutoresearchStorage(dir);
		seedCompletedRun(storage, storage.getActiveSession()!, {
			preRunDirtyPaths: ["autoresearch.sh"],
			parsedPrimary: 10,
			parsedMetrics: { runtime_ms: 10 },
		});
		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		return { runtime, log, harness };
	}

	it("rejects when no pending run exists", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), { name: "x", primary_metric: "m" });
		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 1,
			status: "keep",
			description: "x",
		});
		expect(firstTextBlockText(result.content)).toContain("no pending run");
	});

	it("stores keep with metric and updates baseline", async () => {
		const dir = freshRepo().dir;
		const { log, runtime } = await setupRun(dir);
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 10,
			status: "keep",
			description: "baseline",
		});
		const details = result.details as LogDetails;
		expect(details.experiment.status).toBe("keep");
		expect(details.experiment.metric).toBe(10);
		expect(details.state.bestMetric).toBe(10);
		expect(details.state.results).toHaveLength(1);
		expect(runtime.state.bestMetric).toBe(10);
	});

	it("flags scope deviations and warns when justification is missing", async () => {
		const dir = freshRepo().dir;
		const { log } = await setupRun(dir);
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 10,
			status: "keep",
			description: "wrote forbidden",
		});
		const details = result.details as LogDetails;
		expect(details.scopeDeviations.length).toBeGreaterThan(0);
		expect(details.justification).toBeNull();
		expect(firstTextBlockText(result.content)).toContain("unjustified");
	});

	it("records the justification when provided", async () => {
		const dir = freshRepo().dir;
		const { log } = await setupRun(dir);
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 10,
			status: "keep",
			description: "wrote forbidden",
			justification: "this file moved into scope",
		});
		const details = result.details as LogDetails;
		expect(details.scopeDeviations.length).toBeGreaterThan(0);
		expect(details.justification).toBe("this file moved into scope");
	});

	it("flags previously logged runs via flag_runs", async () => {
		// Bare temp dir (no repo): the session is created with `branch: null`, so the
		// tool's branch lookup must also resolve to null to match it.
		const dir = makeTempDir().path();
		const storage = await openAutoresearchStorage(dir);
		const session = storage.openSession({
			name: "speed",
			goal: null,
			primaryMetric: "runtime_ms",
			metricUnit: "ms",
			direction: "lower",
			preferredCommand: "bash autoresearch.sh",
			branch: null,
			baselineCommit: null,
			maxIterations: null,
			scopePaths: ["src"],
			offLimits: ["forbidden"],
			constraints: [],
			secondaryMetrics: [],
		});
		const now = Date.now();
		const firstRun = storage.insertRun({
			sessionId: session.id,
			segment: session.currentSegment,
			command: "bash autoresearch.sh",
			startedAt: now,
			logPath: "",
			preRunDirtyPaths: [],
		});
		const firstLogged = storage.markRunLogged({
			runId: firstRun.id,
			status: "keep",
			description: "baseline",
			metric: 10,
			metrics: {},
			asi: null,
			commitHash: null,
			confidence: null,
			modifiedPaths: [],
			scopeDeviations: [],
			justification: null,
			loggedAt: now,
		});
		const secondRun = storage.insertRun({
			sessionId: session.id,
			segment: session.currentSegment,
			command: "bash autoresearch.sh",
			startedAt: now + 1,
			logPath: "",
			preRunDirtyPaths: [],
		});
		storage.markRunCompleted({
			runId: secondRun.id,
			completedAt: now + 2,
			durationMs: 1,
			exitCode: 0,
			timedOut: false,
			parsedPrimary: 8,
			parsedMetrics: { runtime_ms: 8 },
			parsedAsi: null,
		});
		const runtime = createSessionRuntime();
		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: createPiHarness().api,
		};
		const second = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 8,
			status: "keep",
			description: "improved",
			flag_runs: [{ run_id: firstLogged.id, reason: "reward-hacked" }],
		});
		const details = second.details as LogDetails;
		expect(details.flaggedRuns).toEqual([{ runId: firstLogged.id, reason: "reward-hacked" }]);

		const runs = storage.listLoggedRuns(session.id);
		const flagged = runs.find(r => r.id === firstLogged.id);
		expect(flagged?.flagged).toBe(true);
		expect(flagged?.flaggedReason).toBe("reward-hacked");
	});

	it("on a non-autoresearch branch, discard reverts only run-modified files", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		// Commit `src/edit-me.ts` to baseline so it is tracked, not in pre-run dirty paths.
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		await Bun.write(path.join(dir, "src", "edit-me.ts"), "export const v = 1;\n");
		await $`git add -A && git commit -m seed`.cwd(dir).quiet();
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), { name: "x", primary_metric: "m", scope_paths: ["src"] });
		const run = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		// Pre-existing untracked file (will not be touched by revert because it was dirty before run)
		await Bun.write(path.join(dir, "preexisting.txt"), "leave me\n");
		await executeRunExperimentOwner(run, createCtx(dir), {}, undefined, undefined);
		// Simulate a run-introduced change
		await Bun.write(path.join(dir, "src", "edit-me.ts"), "export const v = 2;\n");
		await Bun.write(path.join(dir, "src", "new.ts"), "export const NEW = true;\n");

		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeLogExperimentOwner(log, createCtx(dir), { metric: 12, status: "discard", description: "regress" });
		// Pre-existing file untouched
		expect(fs.readFileSync(path.join(dir, "preexisting.txt"), "utf8")).toBe("leave me\n");
		// New untracked file removed
		expect(fs.existsSync(path.join(dir, "src", "new.ts"))).toBe(false);
		// Tracked edit reverted to baseline content
		expect(fs.readFileSync(path.join(dir, "src", "edit-me.ts"), "utf8")).toBe("export const v = 1;\n");
	});

	it("on an autoresearch branch, discard reverts uncommitted changes but preserves prior commits", async () => {
		const dir = freshBranchRepo().dir;
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), { name: "x", primary_metric: "m" });
		// Simulate a previously kept iteration by committing it directly on the branch.
		await Bun.write(path.join(dir, "src", "kept.ts"), "export const v = 1;\n");
		await $`git add -A && git commit -m "kept iteration"`.cwd(dir).quiet();
		const headBeforeDiscard = await git.head.sha(dir);

		const storage = await openAutoresearchStorage(dir);
		// On-branch discard resets to HEAD and ignores preRunDirtyPaths, so a
		// seeded pending run drives executeLogExperimentOwner without the run subprocess.
		seedCompletedRun(storage, storage.getActiveSession()!, { parsedPrimary: 1, parsedMetrics: { m: 1 } });
		// Current iteration's uncommitted edits.
		await Bun.write(path.join(dir, "src", "kept.ts"), "export const v = 999;\n");
		await Bun.write(path.join(dir, "scratch.ts"), "// junk\n");

		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeLogExperimentOwner(log, createCtx(dir), { metric: 12, status: "discard", description: "regress" });
		const headAfter = await git.head.sha(dir);
		// Prior commits survive — discard does not rewind history.
		expect(headAfter).toBe(headBeforeDiscard);
		// Uncommitted iteration changes are gone.
		expect(fs.readFileSync(path.join(dir, "src", "kept.ts"), "utf8")).toBe("export const v = 1;\n");
		expect(fs.existsSync(path.join(dir, "scratch.ts"))).toBe(false);
		const status = (await git.status(dir, { porcelainV1: true })).trim();
		expect(status).toBe("");
	});

	it("on an autoresearch branch, keep commits files that were dirty before executeRunExperimentOwner", async () => {
		const dir = freshBranchRepo().dir;
		// Seed a tracked file that the agent will edit during the iteration.
		await Bun.write(path.join(dir, "src", "store.ts"), "export const v = 1;\n");
		await $`git add -A && git commit -m seed`.cwd(dir).quiet();
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), { name: "x", primary_metric: "m", scope_paths: ["src"] });
		// Agent edits BEFORE running the benchmark — the iteration's diff is dirty
		// at executeRunExperimentOwner time.
		await Bun.write(path.join(dir, "src", "store.ts"), "export const v = 2;\n");
		const storage = await openAutoresearchStorage(dir);
		seedCompletedRun(storage, storage.getActiveSession()!, { parsedPrimary: 1, parsedMetrics: { m: 1 } });

		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 42,
			status: "keep",
			description: "improvement",
		});
		const details = result.details as LogDetails;
		expect(details.experiment.modifiedPaths).toContain("src/store.ts");
		const status = (await git.status(dir, { porcelainV1: true })).trim();
		expect(status).toBe("");
		const lastMsg = (await $`git log -1 --pretty=%B`.cwd(dir).text()).trim();
		expect(lastMsg).toContain("improvement");
	});

	it("flags off-scope dirty files even when they were dirty before executeRunExperimentOwner", async () => {
		const dir = freshBranchRepo().dir;
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), {
			name: "x",
			primary_metric: "m",
			scope_paths: ["src"],
			off_limits: ["forbidden"],
		});
		// Off-scope edit BEFORE executeRunExperimentOwner.
		fs.mkdirSync(path.join(dir, "forbidden"), { recursive: true });
		await Bun.write(path.join(dir, "forbidden", "x.ts"), "export const v = 1;\n");
		const storage = await openAutoresearchStorage(dir);
		seedCompletedRun(storage, storage.getActiveSession()!, { parsedPrimary: 1, parsedMetrics: { m: 1 } });

		const log = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		const result = await executeLogExperimentOwner(log, createCtx(dir), {
			metric: 42,
			status: "keep",
			description: "off-scope",
		});
		const details = result.details as LogDetails;
		expect(details.scopeDeviations).toContain("forbidden/x.ts");
	});
});

describe("executeUpdateNotesOwner", () => {
	let dbOverride: TempDir;

	beforeEach(() => {
		dbOverride = makeTempDir("@pi-autoresearch-notes-db-");
		process.env.OMP_AUTORESEARCH_DB_DIR = dbOverride.path();
	});

	afterEach(async () => {
		delete process.env.OMP_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		await Bun.sleep(0);
		await dbOverride.remove().catch(() => {});
	});

	it("replaces session notes and refreshes runtime state", async () => {
		const dir = freshRepo().dir;
		await writeHarnessStub(dir);
		const runtime = createSessionRuntime();
		const harness = createPiHarness();
		const init = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		await executeInitExperimentOwner(init, createCtx(dir), { name: "x", primary_metric: "m" });
		const notes = {
			dashboard: dashboardStub(),
			getRuntime: () => runtime,
			pi: harness.api,
		};
		const result = await executeUpdateNotesOwner(notes, createCtx(dir), { body: "## Plan\n- step one\n" });
		expect(result.details?.notes).toContain("step one");
		expect(runtime.state.notes).toContain("step one");

		const append = await executeUpdateNotesOwner(notes, createCtx(dir), { body: "", append_idea: "try caching" });
		expect(append.details?.notes).toContain("- try caching");
		expect(runtime.state.notes).toContain("- try caching");
	});
});

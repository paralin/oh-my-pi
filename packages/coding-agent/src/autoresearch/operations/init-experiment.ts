import * as path from "node:path";
import type { ExtensionContext } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths } from "../git";
import { dedupeStrings, normalizePathSpec } from "../helpers";
import { buildExperimentState } from "../state";
import { openAutoresearchStorage, type SessionRow } from "../storage";
import type { AutoresearchOperationOptions, AutoresearchOperationResult, ExperimentState } from "../types";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
const HARNESS_COMMIT_TITLE = "autoresearch: harness setup";

export interface InitExperimentParams {
	name: string;
	goal?: string;
	primary_metric: string;
	metric_unit?: string;
	direction?: "lower" | "higher";
	secondary_metrics?: string[];
	scope_paths?: string[];
	off_limits?: string[];
	constraints?: string[];
	max_iterations?: number;
	new_segment?: boolean;
}

interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

export async function executeInitExperimentOwner(
	options: AutoresearchOperationOptions,
	ctx: ExtensionContext,
	params: InitExperimentParams,
): Promise<AutoresearchOperationResult<InitExperimentDetails>> {
	const storage = await openAutoresearchStorage(ctx.cwd);
	const runtime = options.getRuntime(ctx);

	const direction = params.direction ?? "lower";
	const metricUnit = params.metric_unit ?? "";
	const scopePaths = dedupeStrings((params.scope_paths ?? []).map(normalizePathSpec));
	const offLimits = dedupeStrings((params.off_limits ?? []).map(normalizePathSpec));
	const constraints = dedupeStrings(params.constraints ?? []);
	const secondaryMetrics = dedupeStrings(params.secondary_metrics ?? []);
	const goal = params.goal?.trim() || null;
	const maxIterations =
		params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
			? Math.floor(params.max_iterations)
			: null;
	const branch = (await git.branch.current(ctx.cwd)) ?? null;
	const onAutoresearchBranch = branch?.startsWith("autoresearch/") ?? false;

	const existing = storage.getActiveSessionForBranch(branch);
	const isNewSegmentInit = existing !== null && params.new_segment === true;
	const requiresHarness = !existing || isNewSegmentInit;

	if (requiresHarness) {
		const harnessExists = await Bun.file(path.join(ctx.cwd, HARNESS_FILENAME)).exists();
		if (!harnessExists) {
			return {
				content: [
					{
						type: "text",
						text: `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call omp.autoresearch.init again.`,
					},
				],
			};
		}
	}

	let harnessCommitted = false;
	let commitWarning: string | null = null;
	if (requiresHarness && onAutoresearchBranch) {
		const dirty = await detectPendingChanges(ctx.cwd);
		if (dirty) {
			try {
				await git.stage.files(ctx.cwd, []);
				const message = buildHarnessCommitMessage(goal, params.name);
				await git.commit(ctx.cwd, message);
				harnessCommitted = true;
			} catch (err) {
				commitWarning = `Failed to auto-commit harness changes: ${err instanceof Error ? err.message : String(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`;
			}
		}
	}

	const baselineCommit = await tryReadHeadSha(ctx.cwd);

	let session: SessionRow;
	let createdSession = false;
	let bumpedSegment = false;
	let abandonedRuns = 0;

	if (!existing) {
		session = storage.openSession({
			name: params.name,
			goal,
			primaryMetric: params.primary_metric,
			metricUnit,
			direction,
			preferredCommand: DEFAULT_HARNESS_COMMAND,
			branch,
			baselineCommit,
			maxIterations,
			scopePaths,
			offLimits,
			constraints,
			secondaryMetrics,
		});
		createdSession = true;
	} else {
		abandonedRuns = storage.abandonPendingRuns(existing.id);
		const updates: Parameters<typeof storage.updateSession>[1] = {
			goal,
			maxIterations,
			scopePaths,
			offLimits,
			constraints,
			secondaryMetrics,
			primaryMetric: params.primary_metric,
			metricUnit,
			direction,
			branch,
		};
		if (isNewSegmentInit) {
			updates.baselineCommit = baselineCommit;
		}
		let updated = storage.updateSession(existing.id, updates);
		if (isNewSegmentInit) {
			updated = storage.bumpSegment(existing.id);
			bumpedSegment = true;
		}
		session = updated;
	}

	const loggedRuns = storage.listLoggedRuns(session.id);
	const state = buildExperimentState(session, loggedRuns);
	runtime.state = state;
	runtime.goal = session.goal;
	runtime.autoresearchMode = true;
	runtime.autoResumeArmed = true;
	runtime.lastAutoResumePendingRunNumber = null;
	runtime.lastRunDuration = null;
	runtime.lastRunAsi = null;
	runtime.lastRunArtifactDir = null;
	runtime.lastRunNumber = null;
	runtime.lastRunSummary = null;
	options.dashboard.updateWidget(ctx, runtime);
	options.dashboard.requestRender();

	const lines: string[] = [];
	if (abandonedRuns > 0) {
		lines.push(`Abandoned ${abandonedRuns} pending run${abandonedRuns === 1 ? "" : "s"} before reconfiguring.`);
	}
	if (harnessCommitted && session.baselineCommit) {
		lines.push(`Committed harness setup at ${session.baselineCommit.slice(0, 12)}.`);
	}
	if (commitWarning) {
		lines.push(commitWarning);
	}
	if (createdSession) {
		lines.push(`Started session #${session.id}: ${session.name}`);
	} else if (bumpedSegment) {
		lines.push(`Bumped segment to ${session.currentSegment} for session #${session.id}: ${session.name}`);
	} else {
		lines.push(`Updated session #${session.id} (segment ${session.currentSegment}): ${session.name}`);
	}
	lines.push(`Metric: ${session.primaryMetric} (${session.metricUnit || "unitless"}, ${session.direction} is better)`);
	lines.push(`Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`);
	if (session.scopePaths.length > 0) {
		lines.push(`Files in scope: ${session.scopePaths.join(", ")}`);
	}
	if (session.offLimits.length > 0) {
		lines.push(`Off limits: ${session.offLimits.join(", ")}`);
	}
	if (session.maxIterations !== null) {
		lines.push(`Max iterations per segment: ${session.maxIterations}`);
	}
	if (session.branch) {
		lines.push(`Active branch: ${session.branch}`);
	}
	if (session.baselineCommit) {
		lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`);
	}
	if (createdSession) {
		lines.push(
			"Phase 2: iteration loop is active. Run the baseline experiment with `omp.autoresearch.run` and log it with `omp.autoresearch.log`.",
		);
	} else if (bumpedSegment) {
		lines.push("Run a fresh baseline for the new segment.");
	}
	if (requiresHarness && !onAutoresearchBranch) {
		lines.push(
			"Note: not on a dedicated `autoresearch/*` branch — `omp.autoresearch.log` with `status='discard'` will only revert run-modified files, not reset to baseline.",
		);
	}

	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			state,
			createdSession,
			bumpedSegment,
			abandonedRuns,
			harnessCommitted,
			baselineCommit: session.baselineCommit,
		},
	};
}

async function tryReadHeadSha(cwd: string): Promise<string | null> {
	try {
		return (await git.head.sha(cwd)) ?? null;
	} catch {
		return null;
	}
}

async function detectPendingChanges(cwd: string): Promise<boolean> {
	try {
		const statusText = await git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
		const workDirPrefix = await git.show.prefix(cwd).catch(() => "");
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0;
	} catch {
		return false;
	}
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
	const lines = [HARNESS_COMMIT_TITLE, "", `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`];
	if (goal) {
		lines.push(`Goal: ${goal}`);
	} else {
		lines.push(`Session: ${name}`);
	}
	return lines.join("\n");
}

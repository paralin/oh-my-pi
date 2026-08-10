/**
 * Hub jobs half — lifecycle control for async background jobs (bash scripts,
 * subagents) owned by the calling agent: wait/cancel/snapshot plus the
 * running-agents roster for activity with no job entry.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AsyncJob, AsyncJobManager } from "../../async";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { ToolSession } from "../../session/tool-session";
import { formatDuration } from "../render-utils";
import type { AgentActivitySnapshot, CancelOutcome, CoordinationDetails, JobSnapshot } from "./types";

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

/**
 * A wait snapshot where every watched job is still running and nothing was
 * cancelled — pure "still waiting" noise once a newer wait exists. Callers can
 * replace the stale result with a follow-up `wait` instead of stacking it.
 */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

/** Poll window for a job-watching wait: `async.pollWaitDuration` fixed value or smart ladder. */
export function resolvePollWindow(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): { waitMs: number; smart: boolean } {
	const pollSetting = session.settings.get("async.pollWaitDuration");
	const smart = pollSetting === "smart";
	const waitMs = smart
		? manager.nextPollWaitMs(ownerId)
		: ((pollSetting ? WAIT_DURATION_MS[pollSetting] : undefined) ?? WAIT_DURATION_MS["30s"]);
	return { waitMs, smart };
}

/**
 * Resolve a list of job ids to job records visible to the calling agent.
 * Drops missing ids and ids owned by other agents, so cross-agent inspection
 * via the hub is impossible.
 */
export function visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
	const out: AsyncJob[] = [];
	for (const id of ids) {
		const job = manager.getJob(id);
		if (!job) continue;
		if (ownerId && job.ownerId !== ownerId) continue;
		out.push(job);
	}
	return out;
}

/**
 * Running subagents from the registry that are not covered by one of the
 * caller's running jobs. Agents woken via hub messaging (idle wake / park
 * revival) and spawns owned by another agent run with no AsyncJobManager
 * entry, yet the UI's agent badge counts them — a snapshot must account for
 * that activity instead of implying the system is quiet. Existence is
 * already public via the peer roster, so listing ids here leaks nothing new;
 * job *control* stays owner-scoped.
 */
export function runningAgentsOutsideJobs(session: ToolSession): AgentActivitySnapshot[] {
	const registry = session.agentRegistry;
	if (!registry) return [];
	const selfId = session.getAgentId?.() ?? undefined;
	// Cover = the caller's RUNNING jobs only. A settled job still sitting in
	// delivery retention must not hide its agent if that agent was re-woken
	// (e.g. via a hub message) and is running again without a job.
	const covered = new Set<string>();
	const manager = session.asyncJobManager;
	if (manager) {
		for (const job of manager.getRunningJobs(selfId ? { ownerId: selfId } : undefined)) {
			covered.add(job.id);
			if (job.agentId) covered.add(job.agentId);
		}
	}
	const now = Date.now();
	const out: AgentActivitySnapshot[] = [];
	for (const ref of registry.list()) {
		if (ref.kind !== "sub" || ref.status !== "running") continue;
		if (ref.id === selfId || covered.has(ref.id)) continue;
		out.push({
			id: ref.id,
			...(ref.parentId ? { parentId: ref.parentId } : {}),
			...(ref.activity ? { activity: ref.activity } : {}),
			ageMs: Math.max(0, now - ref.createdAt),
		});
	}
	return out;
}

/** Model-facing lines for the running-agents section shared by `jobs` and empty-wait results. */
function describeAgents(agents: AgentActivitySnapshot[]): string[] {
	const lines = [`## Running Agents (${agents.length}) — not job-backed\n`];
	for (const agent of agents) {
		const parent = agent.parentId ? ` (spawned by \`${agent.parentId}\`)` : "";
		const activity = agent.activity ? ` — ${agent.activity}` : "";
		lines.push(`- \`${agent.id}\`${parent} — up ${formatDuration(agent.ageMs)}${activity}`);
	}
	lines.push("", "These agents have no job entry; message them via `hub` send, transcripts at `history://<id>`.");
	return lines;
}

interface TrackedJobLike {
	id: string;
	type: "bash" | "task";
	status: string;
	label: string;
	startTime: number;
	latestDetails?: Record<string, unknown>;
	resultText?: string;
	errorText?: string;
}

export function snapshotJobs(session: ToolSession, jobs: TrackedJobLike[]): JobSnapshot[] {
	const now = Date.now();
	return jobs.map(j => {
		const current = session.asyncJobManager?.getJob(j.id);
		const latest = current ?? j;
		let resolvedModel: string | undefined;
		if (latest.type === "task") {
			const progressValue = latest.latestDetails?.progress;
			if (Array.isArray(progressValue)) {
				let progressRecord: Record<string, unknown> | undefined;
				for (const item of progressValue) {
					if (!item || typeof item !== "object") continue;
					const candidate = item as Record<string, unknown>;
					if (!progressRecord) progressRecord = candidate;
					if (candidate.id === latest.id) {
						progressRecord = candidate;
						break;
					}
				}
				const modelValue = progressRecord?.resolvedModel;
				if (typeof modelValue === "string") {
					const trimmed = modelValue.trim();
					if (trimmed) resolvedModel = trimmed;
				}
			}
		}
		return {
			id: latest.id,
			type: latest.type,
			status: latest.status as JobSnapshot["status"],
			label: latest.label,
			durationMs: Math.max(0, now - latest.startTime),
			...(resolvedModel ? { resolvedModel } : {}),
			...(latest.resultText ? { resultText: latest.resultText } : {}),
			...(latest.errorText ? { errorText: latest.errorText } : {}),
		};
	});
}

export function buildJobResult(
	session: ToolSession,
	manager: AsyncJobManager,
	op: "wait" | "cancel" | "jobs",
	jobs: TrackedJobLike[],
	cancelOutcomes: CancelOutcome[],
	agents: AgentActivitySnapshot[] = [],
): AgentToolResult<CoordinationDetails> {
	// Deduplicate by id (cancelled jobs may also appear in the watched set).
	const seen = new Set<string>();
	const uniqueJobs = jobs.filter(j => {
		if (seen.has(j.id)) return false;
		seen.add(j.id);
		return true;
	});
	const jobResults = snapshotJobs(session, uniqueJobs);

	manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));

	const completed = jobResults.filter(j => j.status !== "running");
	const running = jobResults.filter(j => j.status === "running");

	const lines: string[] = [];

	if (cancelOutcomes.length > 0) {
		lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
		for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
		lines.push("");
	}

	if (completed.length > 0) {
		lines.push(`## Completed (${completed.length})\n`);
		for (const j of completed) {
			lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
			lines.push(`Label: ${j.label}`);
			if (j.resultText) {
				lines.push("```", j.resultText, "```");
			}
			if (j.errorText) {
				lines.push(`Error: ${j.errorText}`);
			}
			lines.push("");
		}
	}

	if (running.length > 0) {
		lines.push(`## Still Running (${running.length})\n`);
		for (const j of running) {
			lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
		}
	}

	if (agents.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(...describeAgents(agents));
	}

	// A tool result must never be empty text — the model cannot tell "no
	// jobs" from a malfunction (reported exactly that way in QA).
	if (lines.length === 0) {
		lines.push("No background jobs.");
	}

	const details: CoordinationDetails = {
		op,
		jobs: jobResults,
		...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
		...(agents.length ? { agents } : {}),
	};
	return {
		content: [{ type: "text", text: lines.join("\n").trimEnd() }],
		details,
		// A wait where everything is still running carries no new information
		// once a later wait exists — same predicate the TUI uses to displace
		// stale waiting frames.
		...(isWaitingPollDetails(details) ? { useless: true } : {}),
	};
}

/** `wait` with explicit ids that matched nothing visible: correct the caller, surface live agents. */
export function noMatchingJobsResult(session: ToolSession, ids: string[]): AgentToolResult<CoordinationDetails> {
	// Zero pollable jobs is not necessarily "nothing running": agents woken
	// via hub messages or owned by another agent run with no job entry.
	// Report them so the snapshot matches the UI's running-agent count
	// (task job ids are agent ids, so a stale id often names one).
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = [`No matching jobs found for IDs: ${ids.join(", ")}`];
	const registry = session.agentRegistry;
	for (const id of ids) {
		const ref = registry?.get(id);
		if (!ref) continue;
		lines.push(
			ref.status === "running"
				? `- \`${id}\` is a running agent with no job entry — message it via \`hub\` send; transcript at history://${id}`
				: `- \`${id}\` is a ${ref.status} agent (its job is gone) — transcript at history://${id}`,
		);
	}
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },
		// Nothing found is noise once consumed — the follow-up call has already
		// corrected course. Running agents are real state the model may act on,
		// so keep those results.
		...(agents.length === 0 ? { useless: true } : {}),
	};
}

/** Bare `wait` with no running jobs and nobody who could message: nothing to block on. */
export function nothingToWaitForResult(session: ToolSession): AgentToolResult<CoordinationDetails> {
	const agents = runningAgentsOutsideJobs(session);
	const lines: string[] = ["No running background jobs to wait for."];
	if (agents.length > 0) {
		lines.push("", ...describeAgents(agents));
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "wait", jobs: [], ...(agents.length ? { agents } : {}) },
		...(agents.length === 0 ? { useless: true } : {}),
	};
}

/** `cancel`: kill the named jobs; returns immediately with outcomes + snapshots. */
export async function executeCancel(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
	ids: string[],
): Promise<AgentToolResult<CoordinationDetails>> {
	const ownerFilter = ownerId ? { ownerId } : undefined;
	const cancelOutcomes: CancelOutcome[] = [];
	for (const id of ids) {
		const existing = manager.getJob(id);
		if (!existing || (ownerId && existing.ownerId !== ownerId)) {
			// No job by this id (or it belongs to another agent): a budget-aborted
			// keep-alive subagent lives on as a jobless registration long after its
			// job row is reaped, so let cancel reach the agent registration too.
			cancelOutcomes.push(await cancelAgentRegistration(session, ownerId, id));
			continue;
		}
		if (existing.status !== "running") {
			// The job row settled but may still be inside the retention window.
			// The agent registration behind it (job id == agent id for task
			// spawns) can outlive the row as an idle/parked zombie — try the
			// registration kill before reporting the row as already done.
			const regOutcome = await cancelAgentRegistration(session, ownerId, id);
			cancelOutcomes.push(
				regOutcome.status === "cancelled"
					? regOutcome
					: {
							id,
							status: "already_completed",
							message: `Background job ${id} is already ${existing.status}.`,
						},
			);
			continue;
		}
		const cancelled = manager.cancel(id, ownerFilter);
		cancelOutcomes.push(
			cancelled
				? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
				: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
		);
	}
	return buildJobResult(session, manager, "cancel", visibleJobs(manager, ids, ownerId), cancelOutcomes);
}

/**
 * Kill a non-job-backed agent registration named by `id`: abort any in-flight
 * turn, then release it from the lifecycle (dispose session + unregister). This
 * is the only kill path for a keep-alive subagent that was budget-aborted, went
 * `idle`/`parked`, and outlived its job row — otherwise it is unstoppable short
 * of a broker restart (issue #6315). Scoped to the caller's own descendants so
 * cross-agent kills stay impossible; a bare test/SDK caller (no owner id) may
 * target any sub. Never touches Main, the caller, or advisor transcripts.
 */
async function cancelAgentRegistration(
	session: ToolSession,
	ownerId: string | undefined,
	id: string,
): Promise<CancelOutcome> {
	const registry = session.agentRegistry;
	const ref = registry?.get(id);
	if (ref?.kind !== "sub") {
		return { id, status: "not_found", message: `Background job not found: ${id}` };
	}
	if (id === ownerId) {
		return { id, status: "not_found", message: `Cannot cancel yourself (${id}).` };
	}
	if (ownerId && ref.parentId !== ownerId) {
		return { id, status: "not_found", message: `Agent ${id} was not spawned by you and cannot be cancelled.` };
	}
	const lifecycle = session.agentLifecycle?.();
	try {
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		if (lifecycle) {
			await lifecycle.release(id, ref);
		} else {
			await ref.session?.dispose();
			registry?.unregister(id, ref);
		}
	} catch (error) {
		return {
			id,
			status: "already_completed",
			message: `Agent ${id} could not be fully cancelled: ${error instanceof Error ? error.message : String(error)}.`,
		};
	}
	return { id, status: "cancelled", message: `Cancelled agent ${id} (killed session, dropped registration).` };
}

/** `jobs`: read-only snapshot of every job plus the jobless running-agent roster. */
export function executeJobsSnapshot(
	session: ToolSession,
	manager: AsyncJobManager,
	ownerId: string | undefined,
): AgentToolResult<CoordinationDetails> {
	const jobs = manager.getAllJobs(ownerId ? { ownerId } : undefined);
	return buildJobResult(session, manager, "jobs", jobs, [], runningAgentsOutsideJobs(session));
}

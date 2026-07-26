/**
 * Token accounting for one walk.
 *
 * A walk's headline total hides the question that decides whether the design
 * works: does context grow with the number of nodes, or does the cached prefix
 * absorb it? That is only visible per request, so the trajectory records each
 * one and this module renders the distribution beside the totals.
 */
import { type RequestRecord, readTrajectory, type WalkUsage } from "./trajectory";

/** Per-request and per-node accounting for one walk. */
export interface WalkReport {
	walkId: string;
	status: string;
	nodesEntered: number;
	requests: number;
	totals: WalkUsage;
	/** One row per provider request, in order. */
	perRequest: RequestRecord[];
}

/** Read a trajectory and total it. */
export async function reportWalk(path: string): Promise<WalkReport> {
	const records = await readTrajectory(path);
	const perRequest = records.filter((record): record is RequestRecord => record.type === "request");
	const end = records.find(record => record.type === "walk_end");
	const totals: WalkUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const request of perRequest) {
		totals.input += request.input;
		totals.output += request.output;
		totals.cacheRead += request.cacheRead;
		totals.cacheWrite += request.cacheWrite;
		totals.totalTokens += request.totalTokens;
		totals.cost += request.cost;
	}
	return {
		walkId: end?.walkId ?? "(unfinished)",
		status: end?.status ?? "(unfinished)",
		nodesEntered: end?.nodesEntered ?? 0,
		requests: perRequest.length,
		totals,
		perRequest,
	};
}

/** Render a report as fixed-width text. */
export function formatReport(report: WalkReport): string {
	const lines = [
		`walk ${report.walkId} status=${report.status} nodes=${report.nodesEntered} requests=${report.requests}`,
		"",
		"node                 cacheRead  cacheWrite     input    output     total",
	];
	for (const request of report.perRequest) {
		lines.push(
			[
				request.nodeId.padEnd(20),
				String(request.cacheRead).padStart(9),
				String(request.cacheWrite).padStart(11),
				String(request.input).padStart(9),
				String(request.output).padStart(9),
				String(request.totalTokens).padStart(9),
			].join(" "),
		);
	}
	const { totals } = report;
	lines.push(
		[
			"TOTAL".padEnd(20),
			String(totals.cacheRead).padStart(9),
			String(totals.cacheWrite).padStart(11),
			String(totals.input).padStart(9),
			String(totals.output).padStart(9),
			String(totals.totalTokens).padStart(9),
		].join(" "),
		"",
		`cost $${totals.cost.toFixed(4)}`,
	);
	return lines.join("\n");
}

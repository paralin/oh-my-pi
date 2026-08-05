import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuccessfulChange } from "@oh-my-pi/pi-agent-core";
import type { TtsrManager } from "../export/ttsr";
import {
	findReferences,
	locationContainsPosition,
	type ReferenceLookupRequest,
	type ReferenceLookupResult,
} from "../lsp/references";
import type { Location, Position } from "../lsp/types";
import type { Rule } from "./rule";
import { evaluateSemanticRule, type SemanticCandidateReport, type SemanticEvaluationReport } from "./rule-semantic";

export interface SuccessfulChangeMatch {
	rule: Rule;
	change: SuccessfulChange;
}

export interface SuccessfulChangeRuleReport {
	rule: Rule;
	change: SuccessfulChange;
	report: SemanticEvaluationReport;
}

export interface SuccessfulChangeAnalysis {
	matches: SuccessfulChangeMatch[];
	reports: SuccessfulChangeRuleReport[];
}

export type ReferenceLookup = (request: ReferenceLookupRequest) => Promise<ReferenceLookupResult>;

export interface SuccessfulChangeAnalysisOptions {
	toolName: string;
	cwd: string;
	signal?: AbortSignal;
	lookupReferences?: ReferenceLookup;
}

function skippedReport(rule: Rule, reason: string): SemanticEvaluationReport {
	return {
		ruleName: rule.name,
		candidates: [],
		skipped: (rule.semanticCondition ?? []).map((_, index) => ({ clause: index + 1, reason })),
	};
}

function cancelledReport(rule: Rule, report?: SemanticEvaluationReport): SemanticEvaluationReport {
	if (!report) return skippedReport(rule, "analysis cancelled");
	const clausesWithCandidates = new Set(report.candidates.map(candidate => candidate.clause));
	return {
		...report,
		candidates: report.candidates.map(candidate => ({
			...candidate,
			status: "skipped",
			reason: "analysis cancelled",
			referenceEvidence: undefined,
		})),
		skipped: [
			...report.skipped,
			...(rule.semanticCondition ?? [])
				.map((_, index) => index + 1)
				.filter(
					clause => !clausesWithCandidates.has(clause) && !report.skipped.some(skip => skip.clause === clause),
				)
				.map(clause => ({ clause, reason: "analysis cancelled" })),
		],
	};
}

function locationKey(location: Location): string {
	const { start, end } = location.range;
	return `${location.uri}:${start.line}:${start.character}:${end.line}:${end.character}`;
}

function countReferences(result: Extract<ReferenceLookupResult, { status: "ok" }>): number {
	const unique = new Set<string>();
	for (const location of result.locations) {
		if (locationContainsPosition(location, result.uri, result.position)) continue;
		unique.add(locationKey(location));
	}
	return unique.size;
}

async function evaluateProjectReferences(
	rule: Rule,
	report: SemanticEvaluationReport,
	filePath: string,
	options: SuccessfulChangeAnalysisOptions,
	cache: Map<string, Promise<ReferenceLookupResult>>,
): Promise<SemanticEvaluationReport> {
	const lookup = options.lookupReferences ?? findReferences;
	const candidates: SemanticCandidateReport[] = [];
	for (const candidate of report.candidates) {
		const predicate = rule.semanticCondition?.[candidate.clause - 1]?.references;
		if (!predicate || candidate.status !== "matched") {
			candidates.push(candidate);
			continue;
		}
		const captureRange = candidate.captureRanges[predicate.capture];
		if (!captureRange) {
			candidates.push({
				...candidate,
				status: "skipped",
				reason: `reference capture ${predicate.capture} has no source position`,
			});
			continue;
		}
		const position: Position = {
			line: captureRange.startLine - 1,
			character: captureRange.startColumn - 1,
		};
		const key = `${filePath}:${position.line}:${position.character}`;
		let pending = cache.get(key);
		if (!pending) {
			pending = lookup({ cwd: options.cwd, filePath, position, signal: options.signal });
			cache.set(key, pending);
		}
		try {
			if (options.signal?.aborted) {
				candidates.push({ ...candidate, status: "skipped", reason: "project reference lookup cancelled" });
				continue;
			}
			const result = await pending;
			if (options.signal?.aborted) {
				candidates.push({ ...candidate, status: "skipped", reason: "project reference lookup cancelled" });
				continue;
			}
			if (result.status === "unavailable") {
				candidates.push({ ...candidate, status: "skipped", reason: result.reason });
				continue;
			}
			const count = countReferences(result);
			const referenceEvidence = { capture: predicate.capture, count, serverName: result.serverName };
			if (predicate.min !== undefined && count < predicate.min) {
				candidates.push({
					...candidate,
					status: "rejected",
					reason: `project reference count ${count} is below minimum ${predicate.min}`,
					referenceEvidence,
				});
				continue;
			}
			if (predicate.max !== undefined && count > predicate.max) {
				candidates.push({
					...candidate,
					status: "rejected",
					reason: `project reference count ${count} exceeds maximum ${predicate.max}`,
					referenceEvidence,
				});
				continue;
			}
			candidates.push({
				...candidate,
				reason: `project reference bounds matched with ${count} call site${count === 1 ? "" : "s"}`,
				referenceEvidence,
			});
		} catch (error) {
			cache.delete(key);
			const reason = options.signal?.aborted
				? "project reference lookup cancelled"
				: `project reference lookup failed: ${error instanceof Error ? error.message : String(error)}`;
			candidates.push({ ...candidate, status: "skipped", reason });
		}
	}
	return { ...report, candidates };
}
/** Apply the existing project-reference predicate service to a semantic report. */
export async function applyProjectReferenceEvidence(
	rule: Rule,
	report: SemanticEvaluationReport,
	filePath: string,
	options: SuccessfulChangeAnalysisOptions,
): Promise<SemanticEvaluationReport> {
	return evaluateProjectReferences(rule, report, filePath, options, new Map());
}

/** Evaluate semantic rules against completed edit/write destinations. */
export async function analyzeSuccessfulChanges(
	manager: TtsrManager,
	changes: readonly SuccessfulChange[],
	options: SuccessfulChangeAnalysisOptions,
): Promise<SuccessfulChangeAnalysis> {
	const destinations = new Map<string, SuccessfulChange>();
	for (const change of changes) {
		if (change.operation === "delete") continue;
		const destination = path.normalize(change.path);
		const normalized = { ...change, path: destination };
		const previous = destinations.get(destination);
		destinations.set(
			destination,
			previous ? { ...normalized, ranges: [...previous.ranges, ...normalized.ranges] } : normalized,
		);
	}
	const matches: SuccessfulChangeMatch[] = [];
	const reports: SuccessfulChangeRuleReport[] = [];
	const referenceCache = new Map<string, Promise<ReferenceLookupResult>>();
	for (const [destination, change] of destinations) {
		const rules = manager.getEligibleSemanticRules(destination, options.toolName);
		if (rules.length === 0) continue;
		if (options.signal?.aborted) {
			for (const rule of rules) reports.push({ rule, change, report: cancelledReport(rule) });
			continue;
		}
		let source: string;
		try {
			source = await fs.readFile(destination, "utf8");
		} catch (error) {
			const reason = `final source unavailable: ${error instanceof Error ? error.message : String(error)}`;
			for (const rule of rules) reports.push({ rule, change, report: skippedReport(rule, reason) });
			continue;
		}
		const extension = path.extname(destination).slice(1).toLowerCase();
		if (!extension) {
			for (const rule of rules)
				reports.push({ rule, change, report: skippedReport(rule, "file language unavailable") });
			continue;
		}
		for (const rule of rules) {
			if (options.signal?.aborted) {
				reports.push({ rule, change, report: skippedReport(rule, "analysis cancelled") });
				continue;
			}
			let report: SemanticEvaluationReport;
			try {
				report = await evaluateSemanticRule(rule, source, extension, change.ranges);
				if (options.signal?.aborted) {
					report = cancelledReport(rule, report);
				} else {
					report = await evaluateProjectReferences(rule, report, destination, options, referenceCache);
					if (options.signal?.aborted) report = cancelledReport(rule, report);
				}
			} catch (error) {
				report = options.signal?.aborted
					? cancelledReport(rule)
					: skippedReport(
							rule,
							`semantic analysis failed: ${error instanceof Error ? error.message : String(error)}`,
						);
			}
			reports.push({ rule, change, report });
			if (report.candidates.some(candidate => candidate.status === "matched")) {
				matches.push({ rule, change });
			}
		}
	}
	return { matches, reports };
}

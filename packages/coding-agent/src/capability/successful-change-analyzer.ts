import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuccessfulChange } from "@oh-my-pi/pi-agent-core";
import type { TtsrManager } from "../export/ttsr";
import type { Rule } from "./rule";
import { evaluateSemanticRule } from "./rule-semantic";

export interface SuccessfulChangeMatch {
	rule: Rule;
	change: SuccessfulChange;
}

/** Evaluate semantic rules against completed edit/write destinations. */
export async function analyzeSuccessfulChanges(
	manager: TtsrManager,
	changes: readonly SuccessfulChange[],
	toolName: string,
	signal?: AbortSignal,
): Promise<SuccessfulChangeMatch[]> {
	const destinations = new Map<string, SuccessfulChange>();
	for (const change of changes) {
		if (change.operation === "delete") continue;
		const destination = path.normalize(change.path);
		const previous = destinations.get(destination);
		destinations.set(destination, previous ? { ...change, ranges: [...previous.ranges, ...change.ranges] } : change);
	}
	const matches: SuccessfulChangeMatch[] = [];
	for (const [destination, change] of destinations) {
		if (signal?.aborted) break;
		let source: string;
		try {
			source = await fs.readFile(destination, "utf8");
		} catch {
			continue;
		}
		const extension = path.extname(destination).slice(1).toLowerCase();
		if (!extension) continue;
		const rules = manager.getEligibleSemanticRules(destination, toolName);
		for (const rule of rules) {
			if (signal?.aborted) break;
			try {
				const report = await evaluateSemanticRule(rule, source, extension, change.ranges);
				if (report.candidates.some(candidate => candidate.status === "matched")) {
					matches.push({ rule, change });
				}
			} catch {
				// Read, parse, stale-path, and abort failures are no matches.
			}
		}
	}
	return matches;
}

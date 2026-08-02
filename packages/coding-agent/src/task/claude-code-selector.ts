/**
 * Task-runtime selection for the `claude-code/{model-name}` namespace.
 *
 * `claude-code` is a task-runtime namespace, not a pi-ai provider: the prefix
 * names the Claude Agent SDK runtime and everything after it is the model
 * handed to that runtime verbatim. Selection therefore happens on the raw
 * selector set, before Pi model resolution, and nothing here consults the model
 * registry. Selector sets without the prefix resolve to `undefined` so every Pi
 * path is untouched.
 */

import { Effort } from "@oh-my-pi/pi-ai";
import { parseEffort } from "../thinking";

/** Selector prefix that routes a subagent to the Claude Agent SDK runtime. */
export const CLAUDE_CODE_RUNTIME_PREFIX = "claude-code/";

/** Provider effort values accepted by the Claude Agent SDK. */
export const CLAUDE_CODE_EFFORTS = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];

function isClaudeCodeEffort(effort: Effort | undefined): effort is ClaudeCodeEffort {
	return effort !== undefined && (CLAUDE_CODE_EFFORTS as readonly Effort[]).includes(effort);
}

/** A resolved Claude runtime selection. */
export interface ClaudeCodeSelection {
	/** Selector suffix without its optional effort, passed to the SDK as its model. */
	model: string;
	/** Explicit provider effort parsed from the selector suffix. */
	effort?: ClaudeCodeEffort;
}

/**
 * Resolve a subagent's model selector set into a Claude runtime selection, or
 * `undefined` when the set selects Pi.
 *
 * A selector set mixing both runtimes names no single execution and throws;
 * callers translate that into their own preflight failure so it lands before
 * any registration or worktree work.
 */
export function resolveClaudeCodeSelection(patterns: string | string[] | undefined): ClaudeCodeSelection | undefined {
	const selectors = (Array.isArray(patterns) ? patterns : patterns ? [patterns] : [])
		.map(pattern => pattern.trim())
		.filter(Boolean);
	const claudeSelectors = selectors.filter(selector => selector.startsWith(CLAUDE_CODE_RUNTIME_PREFIX));
	if (claudeSelectors.length === 0) return undefined;
	if (claudeSelectors.length !== selectors.length) {
		throw new Error(
			`Mixed subagent runtimes in model selector set "${selectors.join(", ")}". ` +
				"Use only claude-code/ selectors or only Pi selectors.",
		);
	}
	const rawModel = claudeSelectors[0].slice(CLAUDE_CODE_RUNTIME_PREFIX.length).trim();
	if (!rawModel) {
		throw new Error(`Claude runtime selector "${claudeSelectors[0]}" names no model.`);
	}
	const colon = rawModel.lastIndexOf(":");
	const parsedEffort = colon > 0 ? parseEffort(rawModel.slice(colon + 1)) : undefined;
	const effort = isClaudeCodeEffort(parsedEffort) ? parsedEffort : undefined;
	const model = effort ? rawModel.slice(0, colon).trim() : rawModel;
	if (!model) {
		throw new Error(`Claude runtime selector "${claudeSelectors[0]}" names no model.`);
	}
	return { model, ...(effort ? { effort } : {}) };
}

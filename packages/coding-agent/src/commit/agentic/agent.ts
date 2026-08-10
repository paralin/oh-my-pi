import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Markdown } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { getMarkdownTheme } from "../../modes/theme/theme";
import { createAgentSession } from "../../sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { AuthStorage } from "../../session/auth-storage";
import * as git from "../../utils/git";
import { validateAnalysis, validateScope } from "../analysis/validation";
import typesDescriptionPrompt from "../prompts/types-description.md" with { type: "text" };
import { CHANGELOG_CATEGORIES, type ChangelogCategory, type CommitType, type ConventionalAnalysis } from "../types";
import { normalizeDetails, parseJsonPayload } from "../utils";
import agentUserPrompt from "./prompts/session-user.md" with { type: "text" };
import agentSystemPrompt from "./prompts/system.md" with { type: "text" };
import type { ChangelogProposal, CommitAgentState, HunkSelector, SplitCommitGroup, SplitCommitPlan } from "./state";
import { computeDependencyOrder } from "./topo-sort";
import { capDetails, normalizeSummary, validateSummaryRules, validateTypeConsistency } from "./validation";

export interface CommitAgentInput {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	userContext?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	changelogTargets: string[];
	requireChangelog: boolean;
	diffText?: string;
	existingChangelogEntries?: ExistingChangelogEntries[];
	onComplete?: (state: CommitAgentState) => Promise<void> | void;
}

export interface ExistingChangelogEntries {
	path: string;
	sections: Array<{ name: string; items: string[] }>;
}

interface CommitProposalJson {
	type: CommitType;
	scope: string | null;
	summary: string;
	details: CommitDetailJson[];
	issue_refs: string[];
}

interface CommitDetailJson {
	text: string;
	changelog_category?: ChangelogCategory;
	user_visible?: boolean;
}

interface SplitCommitJson {
	commits: SplitCommitGroupJson[];
}

interface SplitCommitGroupJson {
	changes: FileChangeJson[];
	type: CommitType;
	scope: string | null;
	summary: string;
	details: CommitDetailJson[];
	issue_refs: string[];
	rationale: string | null;
	dependencies: number[];
}

interface FileChangeJson {
	path: string;
	hunks: HunkSelector;
}

interface ChangelogProposalJson {
	entries: ChangelogEntryJson[];
}

interface ChangelogEntryJson {
	path: string;
	entries: Record<string, string[]>;
	deletions?: Record<string, string[]>;
}

interface CommitProposalEnvelope {
	proposal: CommitProposalJson | null;
	split_proposal: SplitCommitJson | null;
	changelog_proposal: ChangelogProposalJson | null;
}

const commitTypes: readonly CommitType[] = [
	"feat",
	"fix",
	"refactor",
	"perf",
	"docs",
	"test",
	"build",
	"ci",
	"chore",
	"style",
	"revert",
];

const changelogCategories = new Set<ChangelogCategory>(CHANGELOG_CATEGORIES);

export async function runCommitAgentSession(input: CommitAgentInput): Promise<CommitAgentState> {
	const typesDescription = prompt.render(typesDescriptionPrompt);
	const systemPrompt = prompt.render(agentSystemPrompt, {
		types_description: typesDescription,
	});
	const state: CommitAgentState = { diffText: input.diffText };
	const spawns = "sonic";
	const { session } = await createAgentSession({
		cwd: input.cwd,
		authStorage: input.authStorage,
		modelRegistry: input.modelRegistry,
		settings: input.settings,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		systemPrompt: [systemPrompt],
		enableLsp: false,
		enableMCP: false,
		hasUI: false,
		spawns,
		contextFiles: input.contextFiles,
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
	});
	let thinkingLineActive = false;
	let latestAssistantText: string | undefined;
	const writeThinkingLine = (text: string) => {
		if (!process.stdout.isTTY) return;
		const line = chalk.dim(`… ${text}`);
		process.stdout.write(`\r\x1b[2K${line}`);
		thinkingLineActive = true;
	};
	const clearThinkingLine = () => {
		if (!thinkingLineActive) return;
		if (!process.stdout.isTTY) return;
		process.stdout.write("\r\x1b[2K");
		thinkingLineActive = false;
	};
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					thinkingLineActive = false;
				}
				break;
			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const preview = extractMessagePreview(event.message?.content ?? []);
				if (!preview) break;
				writeThinkingLine(preview);
				break;
			}
			case "message_end": {
				const role = event.message?.role;
				if (role === "assistant") {
					clearThinkingLine();
					const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
					if (assistantMessage.stopReason === "error" && assistantMessage.errorMessage) {
						process.stdout.write(`● Error: ${assistantMessage.errorMessage}\n`);
					}
					const messageText = extractMessageText(event.message?.content ?? []);
					latestAssistantText = messageText ?? undefined;
					if (messageText) {
						writeAssistantMessage(messageText);
					}
				}
				break;
			}
			case "agent_end":
				clearThinkingLine();
				process.stdout.write("● agent finished\n");
				break;
			default:
				break;
		}
	});

	try {
		const agentUserMessage = prompt.render(agentUserPrompt, {
			user_context: input.userContext,
			changelog_targets: input.changelogTargets.length > 0 ? input.changelogTargets.join("\n") : undefined,
			existing_changelog_entries: input.existingChangelogEntries,
		});
		const maxRetries = 3;
		let retryCount = 0;
		let proposalError: string | undefined;
		const needsChangelog = input.requireChangelog && input.changelogTargets.length > 0;
		const promptAndPopulate = async (message: string, synthetic = false) => {
			latestAssistantText = undefined;
			await session.prompt(message, {
				attribution: "agent",
				expandPromptTemplates: false,
				...(synthetic ? { synthetic: true } : {}),
			});
			proposalError = await populateCommitState(latestAssistantText, state, input);
		};

		await promptAndPopulate(agentUserMessage);
		while (retryCount < maxRetries && !isProposalComplete(state, needsChangelog)) {
			retryCount += 1;
			await promptAndPopulate(
				buildReminderMessage(state, needsChangelog, proposalError, retryCount, maxRetries),
				true,
			);
		}

		if (input.onComplete) {
			await input.onComplete(state);
		}
		return state;
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

function extractMessagePreview(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text?.trim())
		.filter((value): value is string => Boolean(value));
	if (textBlocks.length === 0) return null;
	const combined = textBlocks.join(" ").replace(/\s+/g, " ").trim();
	return truncateMessage(combined);
}

function extractMessageText(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.filter(value => value.trim().length > 0);
	if (textBlocks.length === 0) return null;
	return textBlocks.join("\n").trim();
}

function writeAssistantMessage(message: string): void {
	const lines = renderMarkdownLines(message);
	if (lines.length === 0) return;
	let firstContentIndex = lines.findIndex(line => line.trim().length > 0);
	if (firstContentIndex === -1) {
		firstContentIndex = 0;
	}
	for (const [index, line] of lines.entries()) {
		const prefix = index === firstContentIndex ? "● " : "  ";
		process.stdout.write(`${`${prefix}${line}`.trimEnd()}\n`);
	}
}

function renderMarkdownLines(message: string): readonly string[] {
	const width = Math.max(40, process.stdout.columns ?? 100);
	const markdown = new Markdown(message, 0, 0, getMarkdownTheme());
	return markdown.render(width);
}

async function populateCommitState(
	text: string | undefined,
	state: CommitAgentState,
	input: CommitAgentInput,
): Promise<string | undefined> {
	if (!text) return "No JSON proposal appeared in the final assistant response.";
	try {
		const proposal = parseCommitProposalEnvelope(text);
		const stagedFiles = state.overview?.files ?? (await git.diff.changedFiles(input.cwd, { cached: true }));
		const diffText = state.diffText ?? (await git.diff(input.cwd, { cached: true }));

		const singleProposal = proposal.proposal
			? validateSingleProposal(proposal.proposal, stagedFiles, diffText)
			: undefined;
		const splitProposal = proposal.split_proposal
			? await validateSplitProposal(
					proposal.split_proposal,
					stagedFiles,
					diffText,
					input.cwd,
					input.changelogTargets,
				)
			: undefined;
		const changelogProposal = proposal.changelog_proposal
			? validateChangelogProposal(proposal.changelog_proposal, input.changelogTargets)
			: undefined;

		state.proposal = singleProposal;
		state.splitProposal = splitProposal;
		state.changelogProposal = changelogProposal;
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function parseCommitProposalEnvelope(text: string): CommitProposalEnvelope {
	const parsed = parseJsonPayload(text);
	const envelope = asRecord(parsed, "proposal");
	assertExactKeys(envelope, ["proposal", "split_proposal", "changelog_proposal"], "proposal");
	const proposal = parseSingleProposal(readRequired(envelope, "proposal", "proposal"));
	const splitProposal = parseSplitProposal(readRequired(envelope, "split_proposal", "proposal"));
	if (Boolean(proposal) === Boolean(splitProposal)) {
		throw new Error("Proposal must include exactly one of proposal or split_proposal.");
	}
	return {
		proposal,
		split_proposal: splitProposal,
		changelog_proposal: parseChangelogProposal(readRequired(envelope, "changelog_proposal", "proposal")),
	};
}

function parseSingleProposal(value: unknown): CommitProposalJson | null {
	if (value === null) return null;
	const proposal = asRecord(value, "proposal");
	assertExactKeys(proposal, ["type", "scope", "summary", "details", "issue_refs"], "proposal");
	return {
		type: parseCommitType(readRequired(proposal, "type", "proposal.type"), "proposal.type"),
		scope: parseNullableString(readRequired(proposal, "scope", "proposal.scope"), "proposal.scope"),
		summary: parseString(readRequired(proposal, "summary", "proposal.summary"), "proposal.summary"),
		details: parseDetails(readRequired(proposal, "details", "proposal.details"), "proposal.details"),
		issue_refs: parseStringArray(readRequired(proposal, "issue_refs", "proposal.issue_refs"), "proposal.issue_refs"),
	};
}

function parseSplitProposal(value: unknown): SplitCommitJson | null {
	if (value === null) return null;
	const proposal = asRecord(value, "split_proposal");
	assertExactKeys(proposal, ["commits"], "split_proposal");
	const commits = parseArray(readRequired(proposal, "commits", "split_proposal"), "split_proposal.commits");
	return {
		commits: commits.map((commit, index) => parseSplitCommitGroup(commit, `split_proposal.commits[${index}]`)),
	};
}

function parseSplitCommitGroup(value: unknown, field: string): SplitCommitGroupJson {
	const commit = asRecord(value, field);
	assertExactKeys(
		commit,
		["changes", "type", "scope", "summary", "details", "issue_refs", "rationale", "dependencies"],
		field,
	);
	const changes = parseArray(readRequired(commit, "changes", field), `${field}.changes`);
	return {
		changes: changes.map((change, index) => parseFileChange(change, `${field}.changes[${index}]`)),
		type: parseCommitType(readRequired(commit, "type", field), `${field}.type`),
		scope: parseNullableString(readRequired(commit, "scope", field), `${field}.scope`),
		summary: parseString(readRequired(commit, "summary", field), `${field}.summary`),
		details: parseDetails(readRequired(commit, "details", field), `${field}.details`),
		issue_refs: parseStringArray(readRequired(commit, "issue_refs", field), `${field}.issue_refs`),
		rationale: parseNullableString(readRequired(commit, "rationale", field), `${field}.rationale`),
		dependencies: parseNumberArray(readRequired(commit, "dependencies", field), `${field}.dependencies`),
	};
}

function parseFileChange(value: unknown, field: string): FileChangeJson {
	const change = asRecord(value, field);
	assertExactKeys(change, ["path", "hunks"], field);
	return {
		path: parseString(readRequired(change, "path", field), `${field}.path`),
		hunks: parseHunkSelector(readRequired(change, "hunks", field), `${field}.hunks`),
	};
}

function parseHunkSelector(value: unknown, field: string): HunkSelector {
	const selector = asRecord(value, field);
	const type = parseString(readRequired(selector, "type", field), `${field}.type`);
	if (type === "all") {
		assertExactKeys(selector, ["type"], field);
		return { type };
	}
	if (type === "indices") {
		assertExactKeys(selector, ["type", "indices"], field);
		return { type, indices: parseNumberArray(readRequired(selector, "indices", field), `${field}.indices`) };
	}
	if (type === "lines") {
		assertExactKeys(selector, ["type", "start", "end"], field);
		return {
			type,
			start: parseNumber(readRequired(selector, "start", field), `${field}.start`),
			end: parseNumber(readRequired(selector, "end", field), `${field}.end`),
		};
	}
	throw new Error(`${field}.type must be all, indices, or lines.`);
}

function parseDetails(value: unknown, field: string): CommitDetailJson[] {
	return parseArray(value, field).map((item, index) => {
		const detailField = `${field}[${index}]`;
		const detail = asRecord(item, detailField);
		assertExactKeys(detail, ["text", "changelog_category", "user_visible"], detailField, true);
		const category = detail.changelog_category;
		return {
			text: parseString(readRequired(detail, "text", detailField), `${detailField}.text`),
			...(category === undefined
				? {}
				: { changelog_category: parseChangelogCategory(category, `${detailField}.changelog_category`) }),
			...(detail.user_visible === undefined
				? {}
				: { user_visible: parseBoolean(detail.user_visible, `${detailField}.user_visible`) }),
		};
	});
}

function parseChangelogProposal(value: unknown): ChangelogProposalJson | null {
	if (value === null) return null;
	const proposal = asRecord(value, "changelog_proposal");
	assertExactKeys(proposal, ["entries"], "changelog_proposal");
	const entries = parseArray(readRequired(proposal, "entries", "changelog_proposal"), "changelog_proposal.entries");
	return {
		entries: entries.map((entry, index) => parseChangelogEntry(entry, `changelog_proposal.entries[${index}]`)),
	};
}

function parseChangelogEntry(value: unknown, field: string): ChangelogEntryJson {
	const entry = asRecord(value, field);
	assertExactKeys(entry, ["path", "entries", "deletions"], field, true);
	return {
		path: parseString(readRequired(entry, "path", field), `${field}.path`),
		entries: parseChangelogEntries(readRequired(entry, "entries", field), `${field}.entries`),
		...(entry.deletions === undefined
			? {}
			: { deletions: parseChangelogEntries(entry.deletions, `${field}.deletions`) }),
	};
}

function parseChangelogEntries(value: unknown, field: string): Record<string, string[]> {
	const entries = asRecord(value, field);
	const result: Record<string, string[]> = {};
	for (const [category, values] of Object.entries(entries)) {
		if (!changelogCategories.has(category as ChangelogCategory)) {
			throw new Error(`${field} has unknown changelog category: ${category}.`);
		}
		result[category] = parseStringArray(values, `${field}.${category}`);
	}
	return result;
}

function validateSingleProposal(
	proposal: CommitProposalJson,
	stagedFiles: string[],
	diffText: string,
): { analysis: ConventionalAnalysis; summary: string; warnings: string[] } {
	const scope = proposal.scope?.trim() || null;
	const summary = normalizeSummary(proposal.summary, proposal.type, scope);
	const detailResult = capDetails(normalizeDetails(proposal.details));
	const analysis: ConventionalAnalysis = {
		type: proposal.type,
		scope,
		details: detailResult.details,
		issueRefs: proposal.issue_refs,
	};
	const summaryValidation = validateSummaryRules(summary);
	const analysisValidation = validateAnalysis(analysis);
	const typeValidation = validateTypeConsistency(proposal.type, stagedFiles, {
		diffText,
		summary,
		details: detailResult.details,
	});
	const errors = [...summaryValidation.errors, ...analysisValidation.errors, ...typeValidation.errors];
	if (errors.length > 0) {
		throw new Error(errors.join(" "));
	}
	return {
		analysis,
		summary,
		warnings: [...summaryValidation.warnings, ...detailResult.warnings, ...typeValidation.warnings],
	};
}

async function validateSplitProposal(
	proposal: SplitCommitJson,
	stagedFiles: string[],
	diffText: string,
	cwd: string,
	changelogTargets: string[],
): Promise<SplitCommitPlan> {
	const stagedSet = new Set(stagedFiles);
	const changelogSet = new Set(changelogTargets);
	const usedFiles = new Set<string>();
	const errors: string[] = [];
	const warnings: string[] = [];
	const validateHunksForDiff = git.createHunkSelectionValidator(await git.diff(cwd, { cached: true }));
	const commits: SplitCommitGroup[] = proposal.commits.map((commit, index) => {
		const scope = commit.scope?.trim() || null;
		const summary = normalizeSummary(commit.summary, commit.type, scope);
		const detailResult = capDetails(normalizeDetails(commit.details));
		warnings.push(...detailResult.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
		const dependencies = commit.dependencies.map(dependency => Math.floor(dependency));
		const changes = commit.changes.map(change => ({ path: change.path, hunks: change.hunks }));
		const files = changes.map(change => change.path);
		const summaryValidation = validateSummaryRules(summary);
		const scopeValidation = validateScope(scope);
		const typeValidation = validateTypeConsistency(commit.type, files, {
			diffText,
			summary,
			details: detailResult.details,
		});

		if (summaryValidation.errors.length > 0) {
			errors.push(...summaryValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
		}
		if (!scopeValidation.valid) {
			errors.push(...scopeValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
		}
		if (typeValidation.errors.length > 0) {
			errors.push(...typeValidation.errors.map(error => `Commit ${index + 1}: ${error}`));
		}
		warnings.push(...summaryValidation.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
		warnings.push(...typeValidation.warnings.map(warning => `Commit ${index + 1}: ${warning}`));
		const hunkValidation = validateHunkSelectors(index, changes, files, validateHunksForDiff);
		warnings.push(...hunkValidation.warnings);
		errors.push(...hunkValidation.errors);
		errors.push(...validateDependencies(index, dependencies, proposal.commits.length));

		return {
			changes,
			type: commit.type,
			scope,
			summary,
			details: detailResult.details,
			issueRefs: commit.issue_refs,
			rationale: commit.rationale?.trim() || undefined,
			dependencies,
		};
	});

	for (const commit of commits) {
		const seen = new Set<string>();
		for (const change of commit.changes) {
			if (!stagedSet.has(change.path) && !changelogSet.has(change.path)) {
				errors.push(`File not staged: ${change.path}`);
				continue;
			}
			if (seen.has(change.path)) {
				errors.push(`File listed multiple times in commit ${commit.summary}: ${change.path}`);
				continue;
			}
			if (usedFiles.has(change.path)) {
				errors.push(`File appears in multiple commits: ${change.path}`);
				continue;
			}
			seen.add(change.path);
			usedFiles.add(change.path);
		}
	}
	for (const file of stagedFiles) {
		if (!usedFiles.has(file)) {
			errors.push(`Staged file missing from split plan: ${file}`);
		}
	}
	const dependencyCheck = computeDependencyOrder(commits);
	if ("error" in dependencyCheck) {
		errors.push(dependencyCheck.error);
	}
	if (errors.length > 0) {
		throw new Error(errors.join(" "));
	}
	return { commits, warnings };
}

function validateHunkSelectors(
	commitIndex: number,
	changes: SplitCommitGroup["changes"],
	files: string[],
	validateHunksForDiff: (changes: SplitCommitGroup["changes"]) => git.HunkSelectionValidationError[],
): { errors: string[]; warnings: string[] } {
	const errors: string[] = [];
	const warnings: string[] = [];
	const prefix = `Commit ${commitIndex + 1}`;
	if (files.length === 0) {
		errors.push(`${prefix}: no files specified`);
		return { errors, warnings };
	}
	for (const change of changes) {
		if (change.hunks.type === "indices") {
			const invalid = change.hunks.indices.filter(
				value => !Number.isFinite(value) || Math.floor(value) !== value || value < 1,
			);
			if (invalid.length > 0) {
				errors.push(`${prefix}: invalid hunk indices for ${change.path}`);
			}
			continue;
		}
		if (change.hunks.type === "lines") {
			const { start, end } = change.hunks;
			if (!Number.isFinite(start) || !Number.isFinite(end)) {
				errors.push(`${prefix}: invalid line range for ${change.path}`);
				continue;
			}
			if (Math.floor(start) !== start || Math.floor(end) !== end || start < 1 || end < start) {
				errors.push(`${prefix}: invalid line range for ${change.path}`);
			}
		}
	}
	if (errors.length === 0) {
		for (const error of validateHunksForDiff(changes)) {
			errors.push(`${prefix}: ${error.message}`);
		}
	}
	return { errors, warnings };
}

function validateDependencies(commitIndex: number, dependencies: number[], totalCommits: number): string[] {
	const errors: string[] = [];
	const prefix = `Commit ${commitIndex + 1}`;
	for (const dependency of dependencies) {
		if (!Number.isFinite(dependency) || Math.floor(dependency) !== dependency) {
			errors.push(`${prefix}: dependency index must be an integer`);
			continue;
		}
		if (dependency === commitIndex) {
			errors.push(`${prefix}: cannot depend on itself`);
			continue;
		}
		if (dependency < 0 || dependency >= totalCommits) {
			errors.push(`${prefix}: dependency index out of range (${dependency})`);
		}
	}
	return errors;
}

function validateChangelogProposal(proposal: ChangelogProposalJson, changelogTargets: string[]): ChangelogProposal {
	const errors: string[] = [];
	const targets = new Set(changelogTargets);
	const seen = new Set<string>();
	const entries = proposal.entries.map(entry => {
		const normalizedEntries = normalizeChangelogEntries(entry.entries, true);
		const deletions = entry.deletions ? normalizeChangelogEntries(entry.deletions, false) : undefined;
		return {
			path: entry.path,
			entries: normalizedEntries,
			...(deletions && Object.keys(deletions).length > 0 ? { deletions } : {}),
		};
	});
	for (const entry of entries) {
		if (targets.size > 0 && !targets.has(entry.path)) {
			errors.push(`Changelog not expected: ${entry.path}`);
			continue;
		}
		if (seen.has(entry.path)) {
			errors.push(`Duplicate changelog entry for ${entry.path}`);
			continue;
		}
		seen.add(entry.path);
	}
	for (const target of targets) {
		if (!seen.has(target)) {
			errors.push(`Missing changelog entries for ${target}`);
		}
	}
	if (errors.length > 0) {
		throw new Error(errors.join(" "));
	}
	return { entries };
}

function normalizeChangelogEntries(entries: Record<string, string[]>, stripPeriods: boolean): Record<string, string[]> {
	const normalized: Record<string, string[]> = {};
	for (const [category, values] of Object.entries(entries)) {
		const items = values
			.map(value => {
				const trimmed = value.trim();
				return stripPeriods ? trimmed.replace(/\.$/, "") : trimmed;
			})
			.filter(value => value.length > 0);
		if (items.length > 0) {
			normalized[category] = Array.from(new Set(items));
		}
	}
	return normalized;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: string[], field: string, allowOptional = false): void {
	const unknown = Object.keys(value).filter(key => !keys.includes(key));
	if (unknown.length > 0) {
		throw new Error(`${field} has unknown fields: ${unknown.join(", ")}.`);
	}
	if (allowOptional) return;
	const missing = keys.filter(key => value[key] === undefined);
	if (missing.length > 0) {
		throw new Error(`${field} is missing fields: ${missing.join(", ")}.`);
	}
}

function readRequired(value: Record<string, unknown>, key: string, field: string): unknown {
	const result = value[key];
	if (result === undefined) {
		throw new Error(`${field} is missing ${key}.`);
	}
	return result;
}

function parseArray(value: unknown, field: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${field} must be an array.`);
	}
	return value;
}

function parseString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		throw new Error(`${field} must be a string.`);
	}
	return value;
}

function parseNullableString(value: unknown, field: string): string | null {
	if (value === null) return null;
	return parseString(value, field);
}

function parseBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${field} must be a boolean.`);
	}
	return value;
}

function parseNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${field} must be a finite number.`);
	}
	return value;
}

function parseStringArray(value: unknown, field: string): string[] {
	return parseArray(value, field).map((item, index) => parseString(item, `${field}[${index}]`));
}

function parseNumberArray(value: unknown, field: string): number[] {
	return parseArray(value, field).map((item, index) => parseNumber(item, `${field}[${index}]`));
}

function parseCommitType(value: unknown, field: string): CommitType {
	if (typeof value !== "string" || !commitTypes.includes(value as CommitType)) {
		throw new Error(`${field} must be a conventional commit type.`);
	}
	return value as CommitType;
}

function parseChangelogCategory(value: unknown, field: string): ChangelogCategory {
	if (typeof value !== "string" || !changelogCategories.has(value as ChangelogCategory)) {
		throw new Error(`${field} must be a changelog category.`);
	}
	return value as ChangelogCategory;
}

function isProposalComplete(state: CommitAgentState, requireChangelog: boolean): boolean {
	const hasCommit = Boolean(state.proposal ?? state.splitProposal);
	const hasChangelog = !requireChangelog || Boolean(state.changelogProposal);
	return hasCommit && hasChangelog;
}

function buildReminderMessage(
	state: CommitAgentState,
	requireChangelog: boolean,
	proposalError: string | undefined,
	retryCount: number,
	maxRetries: number,
): string {
	const missing: string[] = [];
	if (!state.proposal && !state.splitProposal) {
		missing.push("a valid single or split proposal");
	}
	if (requireChangelog && !state.changelogProposal) {
		missing.push("changelog entries");
	}
	return `<system-reminder>
CRITICAL: Finish with the exact JSON proposal defined in the system prompt.

Missing: ${missing.join(", ") || "none"}.
${proposalError ? `Last proposal was rejected: ${truncateMessage(proposalError, 400)}.\n` : ""}Reminder ${retryCount} of ${maxRetries}.

Inspect staged Git state with ipython if needed, then return a complete JSON proposal now.
</system-reminder>`;
}

function truncateMessage(value: string, maxLength = 40): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

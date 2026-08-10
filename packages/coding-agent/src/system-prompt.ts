/** System prompt construction and project context loading. */

import * as path from "node:path";
import { $env, getProjectDir, hasFsCode, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { contextFileCapability } from "./capability/context-file";
import { systemPromptCapability } from "./capability/system-prompt";
import { findConfigFile } from "./config";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "./discovery";
import { expandAtImports } from "./discovery/at-imports";
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import runtimeNoticeTemplate from "./prompts/system/runtime-notice.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { formatLocalCalendarDate } from "./utils/local-date";
import { normalizePromptPath } from "./utils/prompt-path";

interface AlwaysApplyRule {
	content: string;
	name: string;
	path: string;
}

type ContextFileEntry = { path: string; content: string; depth?: number };

function firstNonEmpty(...values: Array<string | null | undefined>): string | null {
	for (const value of values) {
		if (value?.trim()) return value;
	}
	return null;
}

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = firstNonEmpty(content);
	if (!normalized) return [];

	return normalizePromptBlock(normalized)
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(Boolean);
}

function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	const sourceBlocks = splitComparablePromptBlocks(source);
	const ruleBlocks = splitComparablePromptBlocks(ruleContent);
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) return false;

	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}
	return false;
}

function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules?.length) return [];
	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

function dedupePromptSource(source: string | null | undefined, otherSources: Array<string | null | undefined>): string {
	const resolvedSource = firstNonEmpty(source);
	if (!resolvedSource) return "";
	return otherSources.some(otherSource => promptSourceContainsRule(otherSource, resolvedSource)) ? "" : resolvedSource;
}

function sortContextFiles(contextFiles: ContextFileEntry[]): ContextFileEntry[] {
	return [...contextFiles].sort((a, b) => {
		const depth = (b.depth ?? -1) - (a.depth ?? -1);
		return depth !== 0 ? depth : a.path.localeCompare(b.path);
	});
}

function dedupeExactContextFiles(contextFiles: ContextFileEntry[]): ContextFileEntry[] {
	const lastIndexByContent = new Map<string, number>();
	for (const [index, file] of contextFiles.entries()) lastIndexByContent.set(file.content, index);
	return contextFiles.filter((file, index) => lastIndexByContent.get(file.content) === index);
}

/** Discover TITLE_SYSTEM.md file for automatic session-title prompt overrides. */
export function discoverTitleSystemPromptFile(cwd?: string): string | undefined {
	return (
		findConfigFile("TITLE_SYSTEM.md", { user: false, cwd }) ?? findConfigFile("TITLE_SYSTEM.md", { user: true, cwd })
	);
}

/** Resolve input as file path or literal string. */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input || input.includes("\n")) return input;

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	cwd?: string;
	disabledExtensions?: string[];
}

/** Load project instructions from the capability discovery path. */
export async function loadProjectContextFiles(options: LoadContextFilesOptions = {}): Promise<ContextFileEntry[]> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const result = await loadCapability(contextFileCapability.id, {
		cwd: resolvedCwd,
		disabledExtensions: options.disabledExtensions,
	});
	const files = await Promise.all(
		result.items.map(async item => {
			const contextFile = item as ContextFile;
			return {
				path: contextFile.path,
				content: await expandAtImports(contextFile.content, contextFile.path),
				depth: contextFile.depth,
			};
		}),
	);
	return dedupeExactContextFiles(sortContextFiles(files));
}

/** Load the effective SYSTEM.md customization, preferring the project copy. */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });
	return (
		result.items.find(item => item.level === "project")?.content ??
		result.items.find(item => item.level === "user")?.content ??
		null
	);
}

export interface BuildSystemPromptOptions {
	/** Custom system text. It takes precedence over discovered SYSTEM.md text. */
	customPrompt?: string;
	/** Already-loaded custom text; bypasses path resolution. */
	resolvedCustomPrompt?: string;
	/** Already-loaded SYSTEM.md text; null bypasses discovery. */
	resolvedSystemPromptCustomization?: string | null;
	/** Additional system text. */
	appendSystemPrompt?: string;
	/** Already-loaded appended text; bypasses path resolution. */
	resolvedAppendSystemPrompt?: string;
	/** Working directory. Defaults to getProjectDir(). */
	cwd?: string;
	/** Additional workspace roots whose applicable context files are included. */
	additionalWorkspaceRoots?: string[];
	/** Preloaded context files; skips discovery when supplied. */
	contextFiles?: ContextFileEntry[];
	/** Full always-apply project rules. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Pre-resolved calendar date for deterministic prompt capture. */
	calendarDate?: string;
	/** Volatile session log location shown after project and operator context. */
	sessionLogLocation?: string;
	/** Volatile session status shown after project and operator context. */
	sessionNotice?: string;
	/** Recursive task depth shown after project and operator context. */
	recursiveDepth?: number;
}

export interface BuildSystemPromptResult {
	systemPrompt: string[];
}

/** Build fixed IPython ABI, stable project context, then volatile runtime notices. */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") return { systemPrompt: [] };

	const resolvedCwd = options.cwd ?? getProjectDir();
	const callerControlsCustomPrompt =
		(typeof options.resolvedCustomPrompt === "string" && options.resolvedCustomPrompt.length > 0) ||
		(typeof options.customPrompt === "string" && options.customPrompt.length > 0);
	const systemPromptCustomization =
		options.resolvedSystemPromptCustomization !== undefined
			? options.resolvedSystemPromptCustomization
			: callerControlsCustomPrompt
				? null
				: await loadSystemPromptFiles({ cwd: resolvedCwd });
	const [resolvedCustomPrompt, resolvedAppendPrompt, primaryContextFiles] = await Promise.all([
		options.resolvedCustomPrompt !== undefined
			? Promise.resolve(options.resolvedCustomPrompt)
			: resolvePromptInput(options.customPrompt, "system prompt"),
		options.resolvedAppendSystemPrompt !== undefined
			? Promise.resolve(options.resolvedAppendSystemPrompt)
			: resolvePromptInput(options.appendSystemPrompt, "append system prompt"),
		options.contextFiles !== undefined
			? Promise.resolve(options.contextFiles)
			: loadProjectContextFiles({ cwd: resolvedCwd }),
	]);
	const additionalRoots = (options.additionalWorkspaceRoots ?? []).filter(
		root => path.resolve(root) !== path.resolve(resolvedCwd),
	);
	const additionalContextFiles = await Promise.all(
		additionalRoots.map(root => loadProjectContextFiles({ cwd: root }).catch(() => [])),
	);
	const contextFiles = dedupeExactContextFiles(
		sortContextFiles([...primaryContextFiles, ...additionalContextFiles.flat()]),
	);
	const effectiveSystemPromptCustomization = dedupePromptSource(systemPromptCustomization, [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
	]);
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(options.alwaysApplyRules, [
		effectiveSystemPromptCustomization,
		resolvedCustomPrompt,
		resolvedAppendPrompt,
		...contextFiles.map(file => file.content),
	]).sort((a, b) => a.path.localeCompare(b.path));
	const stableContext = prompt
		.render(projectPromptTemplate, {
			alwaysApplyRules: injectedAlwaysApplyRules,
			appendPrompt: resolvedAppendPrompt ?? "",
			contextFiles,
			customPrompt: resolvedCustomPrompt ?? "",
			systemPromptCustomization: effectiveSystemPromptCustomization,
		})
		.trim();
	const volatileNotice = prompt
		.render(runtimeNoticeTemplate, {
			cwd: normalizePromptPath(resolvedCwd),
			date: options.calendarDate ?? formatLocalCalendarDate(),
			hasRecursiveDepth: options.recursiveDepth !== undefined,
			recursiveDepth: options.recursiveDepth ?? 0,
			sessionLogLocation: options.sessionLogLocation ?? "",
			sessionNotice: options.sessionNotice ?? "",
		})
		.trim();

	return {
		systemPrompt: [systemPromptTemplate.trim(), stableContext, volatileNotice].filter(Boolean),
	};
}

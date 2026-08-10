/** TTSR CLI command handlers. */
import * as path from "node:path";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { BUILTIN_DEFAULTS_PROVIDER_ID, compileRuleCondition, type Rule, ruleCapability } from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import { Settings } from "../config/settings";
import type { TtsrSettings } from "../config/settings-schema";
import { initializeWithSettings, loadCapability } from "../discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import { TtsrManager, type TtsrMatchContext, type TtsrMatchSource } from "../export/ttsr";

interface RuleMatchDetail {
	name: string;
	path: string;
	sourceProvider?: string;
	status: "matched" | "rejected" | "out-of-scope";
	scope: string[];
	interruptMode?: Rule["interruptMode"];
	matched: string[];
	defined: string[];
	reason?: string;
}

export type TtsrAction = "test" | "list";
export const TTSR_ACTIONS: TtsrAction[] = ["test", "list"];
export const TTSR_SOURCES: TtsrMatchSource[] = ["text", "thinking", "tool"];

export interface TtsrTestArgs {
	/** Inline snippet text. */
	snippet?: string;
	/** Snippet file path, or `-` for stdin. */
	file?: string;
	/** Path to a rule markdown file to test in isolation. */
	rule?: string;
	/** TTSR match source. Defaults to text. */
	source?: TtsrMatchSource;
	/** Tool name when source is tool. Only `ipython` is a live tool stream. */
	tool?: string;
	/** Show every evaluated rule, not just triggered ones. */
	verbose?: boolean;
}

export interface TtsrCommandArgs {
	action: TtsrAction;
	test?: TtsrTestArgs;
	json?: boolean;
}

interface TestReport {
	source: TtsrMatchSource;
	tool?: string;
	snippetPreview: string;
	snippetBytes: number;
	evaluated: number;
	triggered: RuleMatchDetail[];
	notTriggered: RuleMatchDetail[];
}

const STDIN_MARKER = "-";

async function readSnippet(opts: Pick<TtsrTestArgs, "snippet" | "file">): Promise<string> {
	if (opts.file) {
		if (opts.file === STDIN_MARKER) return await Bun.stdin.text();
		const resolved = path.resolve(opts.file);
		const file = Bun.file(resolved);
		if (!(await file.exists())) throw new Error(`Snippet file not found: ${resolved}`);
		return await file.text();
	}
	if (opts.snippet !== undefined) return opts.snippet;
	return await Bun.stdin.text();
}

function previewSnippet(snippet: string): string {
	return snippet.replaceAll(/\s+/g, " ").trim().slice(0, 120);
}

function ruleMatchesContext(rule: Rule, context: TtsrMatchContext): boolean {
	const scopes = rule.scope ?? [];
	if (scopes.length === 0) return context.source === "text" || context.source === "tool";
	for (const rawScope of scopes) {
		const scope = rawScope.trim().toLowerCase();
		if (scope === context.source || (scope === "toolcall" && context.source === "tool")) return true;
		if (context.source === "tool" && scope === `tool:${context.toolName?.toLowerCase()}`) return true;
	}
	return false;
}

function matchedConditions(rule: Rule, snippet: string): string[] {
	const matches: string[] = [];
	for (const pattern of rule.condition ?? []) {
		try {
			const regex = compileRuleCondition(pattern);
			if (regex.test(snippet)) matches.push(pattern);
		} catch {
			// The manager already omitted invalid conditions during registration.
		}
	}
	return matches;
}

function evaluate(manager: TtsrManager, rules: readonly Rule[], snippet: string, context: TtsrMatchContext) {
	const hitNames = new Set(manager.checkDelta(snippet, context).map(rule => rule.name));
	const triggered: RuleMatchDetail[] = [];
	const notTriggered: RuleMatchDetail[] = [];
	for (const rule of rules) {
		const inScope = ruleMatchesContext(rule, context);
		const detail: RuleMatchDetail = {
			name: rule.name,
			path: rule.path,
			sourceProvider: rule._source?.provider,
			scope: rule.scope ?? [],
			interruptMode: rule.interruptMode,
			status: !inScope ? "out-of-scope" : hitNames.has(rule.name) ? "matched" : "rejected",
			matched: hitNames.has(rule.name) ? matchedConditions(rule, snippet) : [],
			defined: rule.condition ?? [],
			reason: !inScope ? "stream source is outside the rule scope" : undefined,
		};
		(hitNames.has(rule.name) && inScope ? triggered : notTriggered).push(detail);
	}
	return { triggered, notTriggered };
}

function createTtsrManager(settings?: TtsrSettings): TtsrManager {
	return new TtsrManager(settings);
}

async function loadProjectTtsrRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = createTtsrManager(ttsrSettings);
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	bucketRules(result.items, manager, {
		builtinRules: ttsrSettings.builtinRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	return { rules: manager.getRules(), manager };
}

async function readIsolatedRule(rulePath: string): Promise<Rule> {
	const resolved = path.resolve(rulePath);
	const file = Bun.file(resolved);
	if (!(await file.exists())) throw new Error(`Rule file not found: ${resolved}`);
	const name = path.basename(resolved).replace(/\.(md|mdc)$/, "");
	return buildRuleFromMarkdown(name, await file.text(), resolved, createSourceMeta("ttsr-cli", resolved, "project"), {
		ruleName: name,
	});
}

async function loadIsolatedRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const rule = await readIsolatedRule(rulePath);
	const manager = createTtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		disabledRules: [],
	});
	if (!manager.addRule(rule)) throw new Error(`Rule "${rule.name}" has no usable regex \`condition\`.`);
	return { rules: manager.getRules(), manager };
}

async function runTest(args: TtsrTestArgs, json: boolean, cwd: string): Promise<void> {
	if (args.source && !TTSR_SOURCES.includes(args.source)) {
		throw new Error(`Invalid --source: ${args.source}. Expected one of: ${TTSR_SOURCES.join(", ")}`);
	}
	const source = args.source ?? "text";
	const tool = source === "tool" ? (args.tool ?? "ipython") : undefined;
	if (source === "tool" && tool !== "ipython") {
		throw new Error("Only --tool ipython is streamed by the runtime");
	}
	const snippet = await readSnippet(args);
	const context: TtsrMatchContext = { source, toolName: tool };
	const { rules, manager } = args.rule ? await loadIsolatedRule(args.rule) : await loadProjectTtsrRules(cwd);
	if (rules.length === 0) {
		const message = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No regex TTSR rules registered for this project.";
		if (json) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
		else process.stderr.write(`${chalk.yellow(message)}\n`);
		process.exitCode = 1;
		return;
	}
	const { triggered, notTriggered } = evaluate(manager, rules, snippet, context);
	const report: TestReport = {
		source,
		tool,
		snippetPreview: previewSnippet(snippet),
		snippetBytes: snippet.length,
		evaluated: rules.length,
		triggered,
		notTriggered,
	};
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	renderTestReport(report, args.verbose ?? false, args.rule !== undefined);
}

function renderTestReport(report: TestReport, verbose: boolean, isolated: boolean): void {
	const context = report.source === "tool" ? `tool:${report.tool}` : report.source;
	process.stdout.write(
		`${chalk.bold("TTSR test")} — source=${chalk.cyan(context)} snippet=${chalk.dim(`${report.snippetBytes}b`)}\n`,
	);
	process.stdout.write(`${chalk.dim(`  "${report.snippetPreview}"`)}\n\n`);
	if (report.triggered.length === 0)
		process.stdout.write(`${chalk.red("No rules triggered.")} (evaluated ${report.evaluated})\n`);
	else {
		process.stdout.write(`${chalk.green.bold(`Triggered (${report.triggered.length})`)}\n`);
		for (const detail of report.triggered) renderRuleDetail(detail, true);
	}
	if (verbose && report.notTriggered.length > 0) {
		process.stdout.write(`\n${chalk.dim(`Not triggered (${report.notTriggered.length})`)}\n`);
		for (const detail of report.notTriggered) renderRuleDetail(detail, false);
	}
	if (isolated && report.triggered.length === 0) process.exitCode = 1;
}

function renderRuleDetail(detail: RuleMatchDetail, hit: boolean): void {
	const conditions = hit ? detail.matched : detail.defined;
	const conditionLabel =
		conditions.length > 0
			? `condition: ${conditions.map(condition => `/${condition}/`).join(", ")}`
			: "no conditions";
	const scope = detail.scope.length > 0 ? `  scope: ${detail.scope.join(", ")}` : "";
	const provider = detail.sourceProvider ? ` [${detail.sourceProvider}]` : "";
	process.stdout.write(
		`  ${detail.status === "matched" ? chalk.green("✓") : chalk.red("✗")} ${chalk.bold(detail.name)}  status=${detail.status}  ${conditionLabel}${scope}${provider}\n`,
	);
	if (detail.reason) process.stdout.write(`    reason: ${detail.reason}\n`);
}

async function runList(json: boolean, cwd: string): Promise<void> {
	const { rules, manager } = await loadProjectTtsrRules(cwd);
	const settings = manager.getSettings();
	const report = rules.map(rule => {
		const provider = rule._source?.provider;
		const disabled = settings.disabledRules.includes(rule.name);
		const enabled =
			settings.enabled && !disabled && (provider !== BUILTIN_DEFAULTS_PROVIDER_ID || settings.builtinRules);
		return {
			name: rule.name,
			path: rule.path,
			provider: provider ?? null,
			enabled,
			builtinRules: settings.builtinRules,
			disabled,
			condition: rule.condition ?? [],
			scope: rule.scope ?? [],
			interruptMode: rule.interruptMode ?? settings.interruptMode,
			description: rule.description ?? null,
		};
	});
	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	if (report.length === 0) {
		process.stdout.write(`${chalk.yellow("No TTSR rules registered for this project.")}\n`);
		return;
	}
	process.stdout.write(`${chalk.bold(`TTSR rules (${report.length})`)}\n`);
	for (const rule of report) {
		const fields = [`condition: ${rule.condition.join(", ")}`];
		if (rule.scope.length > 0) fields.push(`scope: ${rule.scope.join(", ")}`);
		process.stdout.write(
			`  ${chalk.bold(rule.name)} enabled=${rule.enabled} builtin=${rule.builtinRules} disabled=${rule.disabled} interruptMode=${rule.interruptMode} ${chalk.dim(fields.join("  "))}\n`,
		);
		if (rule.description) process.stdout.write(`${chalk.dim(`    ${rule.description}`)}\n`);
	}
}

export async function runTtsrCommand(cmd: TtsrCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	if (cmd.action === "test") {
		if (!cmd.test) throw new Error("`ttsr test` requires a snippet, --file, or piped stdin");
		await runTest(cmd.test, cmd.json ?? false, cwd);
		return;
	}
	if (cmd.action === "list") {
		await runList(cmd.json ?? false, cwd);
		return;
	}
	throw new Error(`Unknown TTSR action: ${cmd.action}`);
}

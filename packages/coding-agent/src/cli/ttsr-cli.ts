/**
 * TTSR CLI command handlers.
 *
 * `omp ttsr test` — feed a snippet (inline text, `--file`, or stdin) through the
 * real TTSR matching pipeline and evaluate semantic-only rules against the
 * supplied whole source. Project-reference evidence is only used for an actual
 * `--file` source; candidate reports retain ranges, captures, clauses, and reasons.
 *
 * `omp ttsr list` — show every TTSR-registered rule with conditions, semantic
 * clauses, scope, provider attribution, effective gates, and interrupt mode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { AstMatchStrictness, astMatch, FileType, type GlobMatch, glob } from "@oh-my-pi/pi-natives";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import chalk from "@oh-my-pi/pi-utils/chalk";
import {
	APERTURE_DEFAULTS_PROVIDER_ID,
	BUILTIN_DEFAULTS_PROVIDER_ID,
	compileRuleCondition,
	type Rule,
	ruleCapability,
} from "../capability/rule";
import { bucketRules } from "../capability/rule-buckets";
import { evaluateSemanticRule, type SemanticEvaluationReport } from "../capability/rule-semantic";
import { applyProjectReferenceEvidence } from "../capability/successful-change-analyzer";
import { Settings } from "../config/settings";
import type { TtsrSettings } from "../config/settings-schema";
import { initializeWithSettings, loadCapability } from "../discovery";
import { buildRuleFromMarkdown, createSourceMeta } from "../discovery/helpers";
import type { TtsrManager } from "../export/ttsr";
import { shutdownAll as shutdownLspClients } from "../lsp/client";

type TtsrRuleStatus = "matched" | "rejected" | "skipped" | "out-of-scope";

interface RuleMatchDetail {
	name: string;
	path: string;
	sourceProvider?: string;
	status: TtsrRuleStatus;
	scope: string[];
	interruptMode?: Rule["interruptMode"];
	/** Conditions that matched the snippet. */
	matched: { regex: string[]; ast: string[] };
	/** All conditions defined on the rule (for verbose display). */
	defined: { regex: string[]; ast: string[] };
	skippedAst?: string;
	semantic?: SemanticEvaluationReport;
	reason?: string;
}

export type TtsrAction = "test" | "list" | "scan";

export const TTSR_ACTIONS: TtsrAction[] = ["test", "list", "scan"];
export const TTSR_SOURCES: TtsrMatchSource[] = ["text", "thinking", "tool"];

export type TtsrMatchSource = "text" | "thinking" | "tool";

interface TtsrMatchContext {
	source: TtsrMatchSource;
	toolName?: string;
	filePaths?: string[];
	streamKey?: string;
	/** Real file used as the project-reference lookup target, when applicable. */
	semanticReferenceFile?: string;
	/** Project references are safe only when the snippet is that file's contents. */
	allowSemanticReferences?: boolean;
	projectCwd?: string;
}

export interface TtsrTestArgs {
	/** Inline snippet text. */
	snippet?: string;
	/** Snippet file path, or `-` for stdin. */
	file?: string;
	/** Path to a rule markdown file to test in isolation (skips project loading). */
	rule?: string;
	/** TTSR match source; when omitted, inferred from --file (tool for source files, text otherwise). */
	source?: TtsrMatchSource;
	/** Tool name when `source === "tool"` (e.g. "edit", "write"). */
	tool?: string;
	/** Candidate file path used for scope/glob matching and AST language inference. */
	filePath?: string;
	/** Show every evaluated rule, not just triggered ones. */
	verbose?: boolean;
}

export interface TtsrScanArgs {
	/** Directory to glob and scan files in. */
	directory?: string;
	/** Path to a rule markdown file to test in isolation (skips project loading). */
	rule?: string;
	/** Respect gitignore files while discovering scan candidates. Defaults to true. */
	gitignore?: boolean;
	/** Maximum file size to scan in bytes; 0 disables the limit. */
	maxBytes?: number;
	/** Show details. */
	verbose?: boolean;
}

export interface TtsrCommandArgs {
	action: TtsrAction;
	test?: TtsrTestArgs;
	scan?: TtsrScanArgs;
	json?: boolean;
}

interface TestReport {
	source: TtsrMatchSource;
	tool?: string;
	filePath?: string;
	snippetPreview: string;
	snippetBytes: number;
	evaluated: number;
	triggered: RuleMatchDetail[];
	notTriggered: RuleMatchDetail[];
	/**
	 * Set when a file path was supplied but the match source was inferred as
	 * `text` (extension absent from {@link SOURCE_FILE_EXT}), so callers can
	 * surface why a source file was evaluated against a prose context.
	 */
	inferenceNote?: string;
}

const STDIN_MARKER = "-";
/** Extensions treated as source files for default tool-context inference. */
const SOURCE_FILE_EXT =
	/^\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|swift|c|cc|cpp|h|hpp|rb|php|lua|css|scss|html|json|ya?ml|toml|md|mdc|cs|razor|cshtml|fs|fsx|vb|sh|bash|sql|zig|dart|scala|ex|exs|proto|tf)$/i;

const BINARY_PROBE_BYTES = 8192;
const DEFAULT_MAX_SCAN_BYTES = 5 * 1024 * 1024;

type ReadSkipReason = "binary" | "large" | "unreadable";

interface ScanSkipSummary {
	binary: number;
	large: number;
	unreadable: number;
	noRelevantRules: number;
}

interface ScanSemanticSummary {
	rejected: number;
	skipped: number;
}

interface ScanRegexCondition {
	pattern: string;
	regex: RegExp;
}

interface ScanScopePlan {
	toolName?: string;
	pathGlob?: Bun.Glob;
}

interface ScanRulePlan {
	rule: Rule;
	globalPathGlobs?: Bun.Glob[];
	defaultToolScope: boolean;
	scopes: ScanScopePlan[];
	regexConditions: ScanRegexCondition[];
	astConditions: string[];
	astPrefilters: RegExp[];
	astRequiresFullScan: boolean;
}

interface ScanFileCandidate {
	path: string;
	size?: number;
}

async function readSnippet(opts: { snippet?: string; file?: string }): Promise<string> {
	if (opts.file) {
		if (opts.file === STDIN_MARKER) {
			return await Bun.stdin.text();
		}
		const resolved = path.resolve(opts.file);
		const file = Bun.file(resolved);
		if (!(await file.exists())) {
			throw new Error(`Snippet file not found: ${resolved}`);
		}
		return await file.text();
	}
	if (opts.snippet !== undefined) return opts.snippet;
	if (process.stdin.isTTY === false) return await Bun.stdin.text();
	throw new Error("No snippet provided. Pass inline text, --file <path>, or pipe via --file -.");
}

function previewSnippet(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > 80 ? `${single.slice(0, 77)}…` : single;
}

function deriveLang(filePaths: string[] | undefined): string | undefined {
	for (const filePath of filePaths ?? []) {
		const ext = path.extname(filePath.replaceAll("\\", "/"));
		if (ext.length > 1) return ext.slice(1).toLowerCase();
	}
	return undefined;
}

async function regexMatches(rule: Rule, snippet: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.condition ?? []) {
		try {
			if (compileRuleCondition(pattern).test(snippet)) out.push(pattern);
		} catch {
			// Invalid regex — skip; the manager already warned at registration.
		}
	}
	return out;
}

async function astMatches(rule: Rule, snippet: string, lang: string): Promise<string[]> {
	const out: string[] = [];
	for (const pattern of rule.astCondition ?? []) {
		try {
			const result = await astMatch({
				patterns: [pattern],
				source: snippet,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			if (result.totalMatches > 0) out.push(pattern);
		} catch {
			// Treat as no match (manager logs at runtime).
		}
	}
	return out;
}

function ruleMatchesCliContext(rule: Rule, context: TtsrMatchContext): boolean {
	if (rule.globs && rule.globs.length > 0 && !matchesScanGlob(new Bun.Glob(rule.globs[0]!), context.filePaths)) {
		if (!rule.globs.slice(1).some(pattern => matchesScanGlob(new Bun.Glob(pattern), context.filePaths))) return false;
	}
	const scopes = rule.scope ?? [];
	if (scopes.length === 0) return true;
	for (const rawScope of scopes) {
		const token = rawScope.trim().toLowerCase();
		if (token === context.source) return true;
		if (context.source !== "tool") continue;
		const parsed = parseScanToolScopeToken(rawScope.trim());
		if (!parsed) continue;
		if (parsed.toolName && parsed.toolName !== (context.toolName ?? "").toLowerCase()) continue;
		if (parsed.pathGlob && !matchesScanGlob(parsed.pathGlob, context.filePaths)) continue;
		return true;
	}
	return false;
}

async function evaluate(
	manager: TtsrManager,
	rules: readonly Rule[],
	snippet: string,
	context: TtsrMatchContext,
): Promise<{ triggered: RuleMatchDetail[]; notTriggered: RuleMatchDetail[] }> {
	const regexHit = manager.checkSnapshot(snippet, context);
	const astHit =
		context.source === "tool" && context.filePaths && context.filePaths.length > 0
			? await manager.checkAstSnapshot(snippet, context)
			: [];
	const hitNames = new Set<string>([...regexHit, ...astHit].map(r => r.name));
	const lang = deriveLang(context.filePaths);
	const astEligible = context.source === "tool" && !!lang;
	const triggered: RuleMatchDetail[] = [];
	const notTriggered: RuleMatchDetail[] = [];
	for (const rule of rules) {
		const regex = await regexMatches(rule, snippet);
		const ast = astEligible ? await astMatches(rule, snippet, lang!) : [];
		const streamHit = hitNames.has(rule.name);
		const detail: RuleMatchDetail = {
			name: rule.name,
			path: rule.path,
			sourceProvider: rule._source?.provider,
			scope: rule.scope ?? [],
			interruptMode: rule.interruptMode,
			status: streamHit ? "matched" : "rejected",
			matched: { regex, ast },
			defined: { regex: rule.condition ?? [], ast: rule.astCondition ?? [] },
		};
		if (!astEligible && (rule.astCondition ?? []).length > 0) {
			detail.skippedAst = "astCondition requires --source tool and a --path with a file extension";
			if (!streamHit && (rule.condition ?? []).length === 0) {
				detail.status = "skipped";
				detail.reason = detail.skippedAst;
			}
		}
		if (!ruleMatchesCliContext(rule, context)) {
			detail.status = "out-of-scope";
			detail.reason = "context or candidate path is outside the rule scope";
		} else if ((rule.semanticCondition?.length ?? 0) > 0) {
			if (!lang) {
				detail.status = streamHit ? "matched" : "skipped";
				detail.reason = streamHit ? undefined : "semantic evaluation requires a file extension in --path";
				detail.semantic = {
					ruleName: rule.name,
					candidates: [],
					skipped: (rule.semanticCondition ?? []).map((_, index) => ({
						clause: index + 1,
						reason: "file language unavailable",
					})),
				};
			} else {
				let semantic = await evaluateSemanticRule(rule, snippet, lang);
				if (context.semanticReferenceFile && context.allowSemanticReferences) {
					semantic = await applyProjectReferenceEvidence(rule, semantic, context.semanticReferenceFile, {
						toolName: context.toolName ?? "edit",
						cwd: context.projectCwd ?? path.dirname(context.semanticReferenceFile),
					});
				} else if (!context.allowSemanticReferences) {
					const hasReferenceCandidates = semantic.candidates.some(
						candidate => rule.semanticCondition?.[candidate.clause - 1]?.references,
					);
					if (hasReferenceCandidates) {
						semantic = {
							...semantic,
							candidates: semantic.candidates.map(candidate =>
								rule.semanticCondition?.[candidate.clause - 1]?.references && candidate.status === "matched"
									? {
											...candidate,
											status: "skipped",
											reason: "project reference evidence is only available for an actual edit/write file",
										}
									: candidate,
							),
						};
					}
				}
				detail.semantic = semantic;
				const semanticMatched = semantic.candidates.some(candidate => candidate.status === "matched");
				const semanticRejected = semantic.candidates.some(candidate => candidate.status === "rejected");
				const semanticSkipped =
					semantic.candidates.some(candidate => candidate.status === "skipped") || semantic.skipped.length > 0;
				if (semanticMatched) detail.status = "matched";
				else if (!streamHit)
					detail.status = semanticSkipped ? "skipped" : semanticRejected ? "rejected" : "rejected";
				if (!streamHit && detail.status !== "matched")
					detail.reason =
						semantic.candidates[0]?.reason ?? semantic.skipped[0]?.reason ?? "no semantic candidate matched";
			}
		}
		(streamHit || detail.status === "matched" ? triggered : notTriggered).push(detail);
	}
	return { triggered, notTriggered };
}

async function createTtsrManager(settings?: TtsrSettings): Promise<TtsrManager> {
	const { TtsrManager } = await import("../export/ttsr");
	return new TtsrManager(settings);
}
function filterTtsrRulesForScan(
	rules: readonly Rule[],
	options: { builtinRules?: boolean; apertureRules?: boolean; disabledRules?: readonly string[] } = {},
): Rule[] {
	const includeBuiltin = options.builtinRules !== false;
	const includeAperture = options.apertureRules === true;
	const disabled = new Set<string>();
	for (const raw of options.disabledRules ?? []) {
		const name = raw.trim();
		if (name.length > 0) disabled.add(name);
	}
	return rules.filter(rule => {
		if (disabled.has(rule.name)) return false;
		if (!includeBuiltin && rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return false;
		if (!includeAperture && rule._source?.provider === APERTURE_DEFAULTS_PROVIDER_ID) return false;
		return (
			(rule.condition && rule.condition.length > 0) ||
			(rule.astCondition && rule.astCondition.length > 0) ||
			(rule.semanticCondition && rule.semanticCondition.length > 0)
		);
	});
}

async function loadProjectTtsrRules(cwd: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	const manager = await createTtsrManager(ttsrSettings);
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	bucketRules(result.items, manager, {
		builtinRules: ttsrSettings.builtinRules,
		apertureRules: ttsrSettings.apertureRules,
		disabledRules: ttsrSettings.disabledRules,
	});
	return { rules: manager.getRules(), manager };
}

async function loadProjectScanRules(cwd: string): Promise<Rule[]> {
	const settingsInstance = await Settings.init({ cwd });
	initializeWithSettings(settingsInstance);
	const ttsrSettings = settingsInstance.getGroup("ttsr");
	if (!ttsrSettings.enabled) {
		return [];
	}
	const result = await loadCapability<Rule>(ruleCapability.id, { cwd });
	return filterTtsrRulesForScan(result.items, {
		builtinRules: ttsrSettings.builtinRules,
		apertureRules: ttsrSettings.apertureRules,
		disabledRules: ttsrSettings.disabledRules,
	});
}

async function readIsolatedRule(rulePath: string): Promise<Rule> {
	const resolved = path.resolve(rulePath);
	const file = Bun.file(resolved);
	if (!(await file.exists())) {
		throw new Error(`Rule file not found: ${resolved}`);
	}
	const content = await file.text();
	const name = path.basename(resolved).replace(/\.(md|mdc)$/, "");
	return buildRuleFromMarkdown(name, content, resolved, createSourceMeta("ttsr-cli", resolved, "project"), {
		ruleName: name,
	});
}

async function loadIsolatedRule(rulePath: string): Promise<{ rules: Rule[]; manager: TtsrManager }> {
	const rule = await readIsolatedRule(rulePath);
	const manager = await createTtsrManager({
		enabled: true,
		contextMode: "discard",
		interruptMode: "always",
		repeatMode: "once",
		repeatGap: 10,
		builtinRules: true,
		apertureRules: false,
		disabledRules: [],
	});
	if (!manager.addRule(rule)) {
		throw new Error(
			`Rule "${rule.name}" has no usable TTSR condition. Add a \`condition\`, \`astCondition\`, or \`semanticCondition\` to its frontmatter.`,
		);
	}
	return { rules: manager.getRules(), manager };
}

async function loadIsolatedScanRule(rulePath: string): Promise<Rule[]> {
	const rule = await readIsolatedRule(rulePath);
	return filterTtsrRulesForScan([rule]);
}

async function runTest(args: TtsrTestArgs, json: boolean, cwd: string): Promise<void> {
	if (args.source && !TTSR_SOURCES.includes(args.source)) {
		throw new Error(`Invalid --source: ${args.source}. Expected one of: ${TTSR_SOURCES.join(", ")}`);
	}

	const snippet = await readSnippet(args);

	// Infer match context: when the user points --file at a source file and
	// doesn't pick a source, default to tool/edit with that path so tool-scoped
	// rules (the common case, e.g. tool:edit(*.ts)) match like they would live.
	const actualFilePath = args.file && args.file !== STDIN_MARKER ? path.resolve(args.file) : undefined;
	const filePath = args.filePath ?? actualFilePath;
	const source: TtsrMatchSource =
		args.source ?? (filePath && SOURCE_FILE_EXT.test(path.extname(filePath)) ? "tool" : "text");
	const tool = args.tool ?? (source === "tool" ? "edit" : undefined);
	const allowSemanticReferences =
		actualFilePath !== undefined && source === "tool" && (tool === "edit" || tool === "write");

	// A supplied source file whose extension is unknown falls through to the
	// text (prose) context, where tool-scoped rules can never match. Surface
	// that so a false negative reads as a context mismatch, not a bad regex.
	const inferenceNote =
		!args.source && filePath && source === "text"
			? `inferred --source text from '${path.extname(filePath) || filePath}' (not in the source-file extension set); pass --source tool --tool edit to evaluate tool-scoped rules`
			: undefined;

	const context: TtsrMatchContext = {
		source,
		toolName: tool,
		filePaths: filePath ? [filePath] : undefined,
		semanticReferenceFile: allowSemanticReferences ? actualFilePath : undefined,
		allowSemanticReferences,
		projectCwd: cwd,
	};

	const { rules, manager } = args.rule ? await loadIsolatedRule(args.rule) : await loadProjectTtsrRules(cwd);

	if (rules.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No TTSR rules registered for this project. Add a `condition`, `astCondition`, or `semanticCondition` to a rule file, then re-run.";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const { triggered, notTriggered } = await evaluate(manager, rules, snippet, context);

	const report: TestReport = {
		source,
		tool,
		filePath,
		snippetPreview: previewSnippet(snippet),
		snippetBytes: snippet.length,
		evaluated: rules.length,
		triggered,
		notTriggered,
		inferenceNote,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}

	renderTestReport(report, args.verbose ?? false, args.rule !== undefined);
}

function renderTestReport(report: TestReport, verbose: boolean, isolated: boolean): void {
	const ctxLabel = report.source === "tool" ? `tool:${report.tool ?? "?"}` : report.source;
	const pathLabel = report.filePath ? ` path=${report.filePath}` : "";
	process.stdout.write(
		`${chalk.bold("TTSR test")} — source=${chalk.cyan(ctxLabel)}${pathLabel} snippet=${chalk.dim(`${report.snippetBytes}b`)}\n`,
	);
	process.stdout.write(`${chalk.dim(`  "${report.snippetPreview}"`)}\n\n`);
	if (report.inferenceNote) {
		process.stdout.write(`${chalk.yellow(`note: ${report.inferenceNote}`)}\n\n`);
	}

	if (report.triggered.length === 0) {
		process.stdout.write(`${chalk.red("No rules triggered.")} (evaluated ${report.evaluated})\n`);
	} else {
		process.stdout.write(`${chalk.green.bold(`Triggered (${report.triggered.length})`)}\n`);
		for (const detail of report.triggered) renderRuleDetail(detail, true);
	}

	if (verbose && report.notTriggered.length > 0) {
		process.stdout.write(`\n${chalk.dim(`Not triggered (${report.notTriggered.length})`)}\n`);
		for (const detail of report.notTriggered) renderRuleDetail(detail, false);
	}
	if (isolated && report.triggered.length === 0) {
		process.exitCode = 1;
	}
}

function renderRuleDetail(detail: RuleMatchDetail, hit: boolean): void {
	const effectiveHit = detail.status === "matched";
	const mark = effectiveHit ? chalk.green("✓") : chalk.red("✗");
	const condParts: string[] = [];
	const regex = hit ? detail.matched.regex : detail.defined.regex;
	const ast = hit ? detail.matched.ast : detail.defined.ast;
	if (regex.length > 0) condParts.push(`condition: ${regex.map(c => chalk.yellow(`/${c}/`)).join(", ")}`);
	if (ast.length > 0) condParts.push(`astCondition: ${ast.map(c => chalk.magenta(c)).join(", ")}`);
	if (detail.skippedAst) condParts.push(chalk.dim(`astCondition: ${detail.skippedAst}`));
	if (detail.scope.length > 0) condParts.push(`scope: ${detail.scope.join(", ")}`);
	if (detail.interruptMode) condParts.push(`interruptMode: ${detail.interruptMode}`);
	const condLabel = condParts.length > 0 ? condParts.join("  ") : chalk.dim("no active conditions");
	const provider = detail.sourceProvider ? chalk.dim(` [${detail.sourceProvider}]`) : "";
	process.stdout.write(`  ${mark} ${chalk.bold(detail.name)}  status=${detail.status}  ${condLabel}${provider}\n`);
	if (detail.reason) process.stdout.write(`    reason: ${detail.reason}\n`);
	for (const candidate of detail.semantic?.candidates ?? []) {
		process.stdout.write(
			`    semantic clause=${candidate.clause} status=${candidate.status} range=${candidate.range.startLine}:${candidate.range.startColumn}-${candidate.range.endLine}:${candidate.range.endColumn} captures=${JSON.stringify(candidate.captures)}${candidate.referenceEvidence ? ` references=${JSON.stringify(candidate.referenceEvidence)}` : ""} reason=${candidate.reason}\n`,
		);
	}
	for (const skipped of detail.semantic?.skipped ?? []) {
		process.stdout.write(`    semantic clause=${skipped.clause} status=skipped reason=${skipped.reason}\n`);
	}
}

async function runList(json: boolean, cwd: string): Promise<void> {
	const { rules, manager } = await loadProjectTtsrRules(cwd);
	const settings = manager.getSettings();
	const projectRules = rules.map(r => {
		const provider = r._source?.provider;
		const disabled = settings.disabledRules.includes(r.name);
		const builtinGate = provider !== BUILTIN_DEFAULTS_PROVIDER_ID || settings.builtinRules;
		const apertureGate = provider !== APERTURE_DEFAULTS_PROVIDER_ID || settings.apertureRules;
		const enabled = settings.enabled && !disabled && builtinGate && apertureGate;
		return {
			name: r.name,
			path: r.path,
			provider: provider ?? null,
			enabled,
			effectiveEnabled: enabled,
			builtinRules: settings.builtinRules,
			apertureRules: settings.apertureRules,
			disabled,
			condition: r.condition ?? [],
			astCondition: r.astCondition ?? [],
			semanticCondition: r.semanticCondition ?? [],
			scope: r.scope ?? [],
			globs: r.globs ?? [],
			interruptMode: r.interruptMode ?? settings.interruptMode,
			description: r.description ?? null,
		};
	});

	if (json) {
		process.stdout.write(`${JSON.stringify(projectRules)}\n`);
		return;
	}
	if (rules.length === 0) {
		process.stdout.write(`${chalk.yellow("No TTSR rules registered for this project.")}\n`);
		return;
	}
	process.stdout.write(`${chalk.bold(`TTSR rules (${rules.length})`)}\n`);
	for (const rule of projectRules) {
		const condParts: string[] = [];
		if (rule.condition.length > 0) condParts.push(`condition: ${rule.condition.join(", ")}`);
		if (rule.astCondition.length > 0) condParts.push(`astCondition: ${rule.astCondition.join(", ")}`);
		if (rule.semanticCondition.length > 0)
			condParts.push(`semanticCondition: ${JSON.stringify(rule.semanticCondition)}`);
		if (rule.scope.length > 0) condParts.push(`scope: ${rule.scope.join(", ")}`);
		if (rule.globs.length > 0) condParts.push(`globs: ${rule.globs.join(", ")}`);
		const provider = rule.provider ? chalk.dim(` provider=${rule.provider}`) : "";
		process.stdout.write(
			`  ${chalk.bold(rule.name)}${provider} enabled=${rule.enabled} builtin=${rule.builtinRules} aperture=${rule.apertureRules} disabled=${rule.disabled} interruptMode=${rule.interruptMode} ${chalk.dim(condParts.join("  ") || "no conditions")}\n`,
		);
		if (rule.description) process.stdout.write(`${chalk.dim(`    ${rule.description}`)}\n`);
	}
}

function normalizeScanPath(pathValue: string): string {
	return pathValue.replaceAll("\\", "/");
}

function isWithinDirectory(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function matchesScanGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
	if (!filePaths || filePaths.length === 0) {
		return false;
	}
	for (const filePath of filePaths) {
		const normalized = normalizeScanPath(filePath);
		if (glob.match(normalized)) {
			return true;
		}
		const slashIndex = normalized.lastIndexOf("/");
		const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
		if (basename !== normalized && glob.match(basename)) {
			return true;
		}
	}
	return false;
}

function compileScanPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
	if (!globs || globs.length === 0) {
		return undefined;
	}
	const compiled = globs
		.map(globPattern => globPattern.trim())
		.filter(globPattern => globPattern.length > 0)
		.map(globPattern => new Bun.Glob(globPattern));
	return compiled.length > 0 ? compiled : undefined;
}

function parseScanToolScopeToken(token: string): ScanScopePlan | undefined {
	const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
		token,
	);
	if (!match) {
		return undefined;
	}
	const groups = match.groups;
	const hasToolPrefix = groups?.prefix !== undefined;
	const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
	const pathPattern = groups?.path?.trim();
	return {
		toolName,
		pathGlob: pathPattern ? new Bun.Glob(pathPattern) : undefined,
	};
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function compileAstPrefilter(pattern: string): RegExp | undefined {
	if (/\bas\s*\{/.test(pattern)) {
		return /\bas\b(?:\s|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*\{/;
	}
	const ignored = new Set(["if", "as", "const", "let", "var", "return", "true", "false", "null", "undefined"]);
	const tokens = pattern
		.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)
		?.filter(token => !ignored.has(token) && !/^[A-Z_]+$/.test(token))
		.sort((a, b) => b.length - a.length);
	const token = tokens?.[0];
	return token ? new RegExp(`\\b${escapeRegexLiteral(token)}\\b`) : undefined;
}

function compileScanRulePlans(rules: Rule[]): ScanRulePlan[] {
	return rules.map(rule => {
		const scopes: ScanScopePlan[] = [];
		let defaultToolScope = !rule.scope || rule.scope.length === 0;
		for (const rawScope of rule.scope ?? []) {
			const token = rawScope.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0 || normalizedToken === "text" || normalizedToken === "thinking") {
				continue;
			}
			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scopes.push({});
				continue;
			}
			const scope = parseScanToolScopeToken(token);
			if (!scope) {
				continue;
			}
			if (!scope.toolName && !scope.pathGlob) {
				defaultToolScope = true;
				continue;
			}
			scopes.push(scope);
		}
		const regexConditions: ScanRegexCondition[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				regexConditions.push({ pattern, regex: compileRuleCondition(pattern) });
			} catch {
				// Same behavior as TtsrManager: invalid regex conditions are unusable.
			}
		}
		const astConditions = (rule.astCondition ?? [])
			.map(pattern => pattern.trim())
			.filter(pattern => pattern.length > 0);
		const astPrefilters: RegExp[] = [];
		let astRequiresFullScan = false;
		for (const pattern of astConditions) {
			const prefilter = compileAstPrefilter(pattern);
			if (prefilter) {
				astPrefilters.push(prefilter);
			} else {
				astRequiresFullScan = true;
			}
		}
		return {
			rule,
			globalPathGlobs: compileScanPathGlobs(rule.globs),
			defaultToolScope,
			scopes,
			regexConditions,
			astConditions,
			astPrefilters,
			astRequiresFullScan,
		};
	});
}

function scanRulePlanMatchesPath(plan: ScanRulePlan, filePaths: string[]): boolean {
	return !plan.globalPathGlobs || plan.globalPathGlobs.some(pathGlob => matchesScanGlob(pathGlob, filePaths));
}

function scanRulePlanMatchesToolScope(plan: ScanRulePlan, filePaths: string[]): boolean {
	if (!scanRulePlanMatchesPath(plan, filePaths)) {
		return false;
	}
	if (plan.defaultToolScope) {
		return true;
	}
	for (const scope of plan.scopes) {
		if (scope.pathGlob && !matchesScanGlob(scope.pathGlob, filePaths)) {
			continue;
		}
		if (!scope.toolName || scope.toolName === "edit" || scope.toolName === "write") {
			return true;
		}
	}
	return false;
}

function scanRulePlanMayMatchAst(plan: ScanRulePlan, fileContent: string): boolean {
	return (
		plan.astConditions.length > 0 &&
		(plan.astRequiresFullScan || plan.astPrefilters.some(prefilter => prefilter.test(fileContent)))
	);
}

async function scanRulePlanMatchesContent(
	plan: ScanRulePlan,
	fileContent: string,
	lang: string | undefined,
	includeDetails: boolean,
): Promise<RuleMatchDetail | undefined> {
	let regexHit = false;
	const matchedRegex: string[] = [];
	for (const condition of plan.regexConditions) {
		condition.regex.lastIndex = 0;
		if (condition.regex.test(fileContent)) {
			regexHit = true;
			if (includeDetails) {
				matchedRegex.push(condition.pattern);
			}
		}
	}

	const matchedAst: string[] = [];
	let astHit = false;
	if ((includeDetails || !regexHit) && lang && plan.astConditions.length > 0) {
		if (includeDetails) {
			matchedAst.push(...(await astMatches(plan.rule, fileContent, lang)));
			astHit = matchedAst.length > 0;
		} else {
			try {
				const result = await astMatch({
					patterns: plan.astConditions,
					source: fileContent,
					lang,
					strictness: AstMatchStrictness.Smart,
					limit: 1,
				});
				astHit = result.matches.length > 0;
			} catch {
				astHit = false;
			}
		}
	}

	if (!regexHit && !astHit) {
		return undefined;
	}
	return {
		name: plan.rule.name,
		path: plan.rule.path,
		sourceProvider: plan.rule._source?.provider,
		scope: plan.rule.scope ?? [],
		interruptMode: plan.rule.interruptMode,
		status: "matched",
		matched: { regex: matchedRegex, ast: matchedAst },
		defined: { regex: plan.rule.condition ?? [], ast: plan.rule.astCondition ?? [] },
	};
}

async function scanAnyAstConditionMatches(
	plans: ScanRulePlan[],
	fileContent: string,
	lang: string | undefined,
): Promise<boolean | undefined> {
	if (!lang) {
		return false;
	}
	const patterns = plans.flatMap(plan => plan.astConditions);
	if (patterns.length === 0) {
		return false;
	}
	try {
		const result = await astMatch({
			patterns,
			source: fileContent,
			lang,
			strictness: AstMatchStrictness.Smart,
			limit: 1,
		});
		if (result.matches.length > 0) {
			return true;
		}
		return result.parseErrors && result.parseErrors.length > 0 ? undefined : false;
	} catch {
		return undefined;
	}
}

async function discoverScanFiles(scanDir: string, cwd: string, gitignore: boolean): Promise<ScanFileCandidate[]> {
	const globRoot = isWithinDirectory(scanDir, cwd) ? cwd : scanDir;
	const relativeScanDir = normalizeScanPath(path.relative(globRoot, scanDir));
	const pattern = relativeScanDir === "" ? "**/*" : `${relativeScanDir}/**/*`;
	try {
		const result = await glob({
			pattern,
			path: globRoot,
			gitignore,
			hidden: true,
			fileType: FileType.File,
		});
		const candidates: ScanFileCandidate[] = [];
		for (const match of result.matches as GlobMatch[]) {
			const absPath = path.resolve(globRoot, match.path);
			const filePath = normalizeScanPath(path.relative(scanDir, absPath));
			if (
				filePath.length === 0 ||
				filePath.startsWith("..") ||
				path.isAbsolute(filePath) ||
				filePath === ".git" ||
				filePath.startsWith(".git/")
			) {
				continue;
			}
			candidates.push({ path: filePath, size: match.size });
		}
		candidates.sort((a, b) => a.path.localeCompare(b.path));
		return candidates;
	} catch {
		return [];
	}
}

async function readScanFileText(
	absPath: string,
	maxBytes: number,
	knownSize: number | undefined,
): Promise<{ content: string } | { skip: ReadSkipReason }> {
	const file = Bun.file(absPath);
	try {
		const fileSize = knownSize ?? file.size;
		if (maxBytes > 0 && fileSize > maxBytes) {
			return { skip: "large" };
		}
		const probeBytes = Math.min(fileSize, BINARY_PROBE_BYTES);
		if (probeBytes > 0) {
			const prefix = new Uint8Array(await file.slice(0, probeBytes).arrayBuffer());
			if (prefix.includes(0)) {
				return { skip: "binary" };
			}
		}
		return { content: await file.text() };
	} catch {
		return { skip: "unreadable" };
	}
}

function countSkipped(skipped: ScanSkipSummary): number {
	return skipped.binary + skipped.large + skipped.unreadable + skipped.noRelevantRules;
}

function scanRuleDetail(rule: Rule, status: TtsrRuleStatus, reason?: string): RuleMatchDetail {
	return {
		name: rule.name,
		path: rule.path,
		sourceProvider: rule._source?.provider,
		scope: rule.scope ?? [],
		interruptMode: rule.interruptMode,
		status,
		matched: { regex: [], ast: [] },
		defined: { regex: rule.condition ?? [], ast: rule.astCondition ?? [] },
		...(reason ? { reason } : {}),
	};
}

async function runScan(args: TtsrScanArgs, json: boolean, cwd: string): Promise<void> {
	const scanDir = args.directory ? path.resolve(cwd, args.directory) : cwd;
	if (!fs.existsSync(scanDir)) {
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: `Directory not found: ${scanDir}` })}\n`);
		} else {
			process.stderr.write(`${chalk.red(`error: scan directory not found: ${scanDir}`)}\n`);
		}
		process.exit(1);
	}

	const rules = args.rule ? await loadIsolatedScanRule(args.rule) : await loadProjectScanRules(cwd);

	if (rules.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no TTSR entry."
			: "No TTSR rules registered for this project.";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const scanRulePlans = compileScanRulePlans(rules).filter(
		plan =>
			plan.regexConditions.length > 0 ||
			plan.astConditions.length > 0 ||
			(plan.rule.semanticCondition?.length ?? 0) > 0,
	);
	if (scanRulePlans.length === 0) {
		const msg = args.rule
			? "Rule registered but produced no usable TTSR condition."
			: "No usable TTSR rules registered for this project.";
		if (json) {
			process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
		} else {
			process.stderr.write(`${chalk.yellow(msg)}\n`);
		}
		process.exit(1);
	}

	const gitignore = args.gitignore ?? true;
	const maxBytes = Math.max(0, args.maxBytes ?? DEFAULT_MAX_SCAN_BYTES);
	const includeDetails = json || (args.verbose ?? false);
	const files = await discoverScanFiles(scanDir, cwd, gitignore);
	const emptySkipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	const emptySemantic: ScanSemanticSummary = { rejected: 0, skipped: 0 };
	if (files.length === 0) {
		const msg = `No files found to scan in ${scanDir}`;
		if (json) {
			process.stdout.write(
				`${JSON.stringify({
					mode: "whole-file",
					files: [],
					evaluations: [],
					summary: {
						totalFiles: 0,
						scannedFiles: 0,
						matchedFiles: 0,
						totalMatches: 0,
						evaluatedRules: scanRulePlans.length,
						skippedFiles: 0,
						skipped: emptySkipped,
						semantic: emptySemantic,
						gitignore,
						maxBytes,
					},
				})}\n`,
			);
		} else {
			process.stdout.write(`${chalk.yellow(msg)}\n`);
		}
		return;
	}

	const fileResults: Array<{ file: string; matches: RuleMatchDetail[] }> = [];
	const evaluationResults: Array<{ file: string; evaluations: RuleMatchDetail[] }> = [];
	const skipped: ScanSkipSummary = { binary: 0, large: 0, unreadable: 0, noRelevantRules: 0 };
	const semanticSummary: ScanSemanticSummary = { rejected: 0, skipped: 0 };
	let scannedFiles = 0;
	let matchedFiles = 0;
	let totalMatches = 0;

	for (const candidate of files) {
		const file = candidate.path;
		const absPath = path.resolve(scanDir, file);
		const relToProj = path.relative(cwd, absPath).replaceAll("\\", "/");
		const basename = path.basename(absPath);
		const filePaths = [absPath.replaceAll("\\", "/"), relToProj, basename];
		const relevantPlans = scanRulePlans.filter(plan => scanRulePlanMatchesToolScope(plan, filePaths));
		const fileEvaluations = includeDetails
			? scanRulePlans
					.filter(plan => !relevantPlans.includes(plan))
					.map(plan => scanRuleDetail(plan.rule, "out-of-scope", "candidate path is outside the rule scope"))
			: [];
		if (relevantPlans.length === 0) {
			skipped.noRelevantRules++;
			if (fileEvaluations.length > 0) evaluationResults.push({ file: relToProj, evaluations: fileEvaluations });
			continue;
		}

		const readResult = await readScanFileText(absPath, maxBytes, candidate.size);
		if ("skip" in readResult) {
			skipped[readResult.skip]++;
			if (fileEvaluations.length > 0) evaluationResults.push({ file: relToProj, evaluations: fileEvaluations });
			continue;
		}
		const fileContent = readResult.content;
		const lang = deriveLang(filePaths);
		scannedFiles++;

		const fileTriggeredDetails: RuleMatchDetail[] = [];
		let fileMatchCount = 0;
		const pendingAstPlans: ScanRulePlan[] = [];
		const matchedPlans = new Set<ScanRulePlan>();
		for (const plan of relevantPlans) {
			let detail = includeDetails
				? await scanRulePlanMatchesContent(plan, fileContent, lang, true)
				: await scanRulePlanMatchesContent(plan, fileContent, undefined, false);
			const streamMatched = detail !== undefined;
			let semanticRuleMatched = false;
			if (!includeDetails && !streamMatched && scanRulePlanMayMatchAst(plan, fileContent))
				pendingAstPlans.push(plan);

			if ((plan.rule.semanticCondition?.length ?? 0) > 0) {
				let semantic: SemanticEvaluationReport;
				if (!lang) {
					semantic = {
						ruleName: plan.rule.name,
						candidates: [],
						skipped: (plan.rule.semanticCondition ?? []).map((_, index) => ({
							clause: index + 1,
							reason: "file language unavailable",
						})),
					};
				} else {
					semantic = await evaluateSemanticRule(plan.rule, fileContent, lang);
					semantic = await applyProjectReferenceEvidence(plan.rule, semantic, absPath, { toolName: "edit", cwd });
				}
				semanticRuleMatched = semantic.candidates.some(candidate => candidate.status === "matched");
				const semanticSkipped =
					semantic.candidates.some(candidate => candidate.status === "skipped") || semantic.skipped.length > 0;
				if (!semanticRuleMatched) {
					if (semanticSkipped) semanticSummary.skipped++;
					else semanticSummary.rejected++;
				}

				if (includeDetails) {
					const semanticStatus: TtsrRuleStatus = semanticRuleMatched
						? "matched"
						: semanticSkipped
							? "skipped"
							: "rejected";
					const reason =
						semantic.candidates.find(candidate => candidate.status === semanticStatus)?.reason ??
						semantic.skipped[0]?.reason ??
						"no semantic candidate matched";
					detail ??= scanRuleDetail(plan.rule, semanticStatus, reason);
					detail.semantic = semantic;
					if (streamMatched || semanticRuleMatched) {
						detail.status = "matched";
						fileTriggeredDetails.push(detail);
					} else {
						detail.status = semanticStatus;
						detail.reason = reason;
						fileEvaluations.push(detail);
					}
				}
			} else if (detail && includeDetails) {
				fileTriggeredDetails.push(detail);
			}

			if ((streamMatched || semanticRuleMatched) && !matchedPlans.has(plan)) {
				matchedPlans.add(plan);
				fileMatchCount++;
			}
		}
		if (!includeDetails && (await scanAnyAstConditionMatches(pendingAstPlans, fileContent, lang)) !== false) {
			for (const plan of pendingAstPlans) {
				const detail = await scanRulePlanMatchesContent(plan, fileContent, lang, false);
				if (detail && !matchedPlans.has(plan)) {
					matchedPlans.add(plan);
					fileMatchCount++;
				}
			}
		}

		if (fileMatchCount > 0) {
			matchedFiles++;
			totalMatches += fileMatchCount;
			if (includeDetails) {
				fileResults.push({
					file: relToProj,
					matches: fileTriggeredDetails,
				});
			}
		}
		if (fileEvaluations.length > 0) evaluationResults.push({ file: relToProj, evaluations: fileEvaluations });
	}

	if (json) {
		process.stdout.write(
			`${JSON.stringify({
				mode: "whole-file",
				files: fileResults.map(fr => ({
					filePath: fr.file,
					matches: fr.matches.map(m => ({
						name: m.name,
						path: m.path,
						provider: m.sourceProvider,
						status: m.status,
						scope: m.scope,
						interruptMode: m.interruptMode,
						matched: m.matched,
						semantic: m.semantic,
						reason: m.reason,
					})),
				})),
				evaluations: evaluationResults.map(fr => ({
					filePath: fr.file,
					evaluations: fr.evaluations.map(evaluation => ({
						name: evaluation.name,
						path: evaluation.path,
						provider: evaluation.sourceProvider,
						status: evaluation.status,
						scope: evaluation.scope,
						interruptMode: evaluation.interruptMode,
						matched: evaluation.matched,
						semantic: evaluation.semantic,
						reason: evaluation.reason,
					})),
				})),
				summary: {
					totalFiles: files.length,
					scannedFiles,
					matchedFiles,
					totalMatches,
					evaluatedRules: scanRulePlans.length,
					skippedFiles: countSkipped(skipped),
					skipped,
					semantic: semanticSummary,
					gitignore,
					maxBytes,
				},
			})}\n`,
		);
	} else {
		process.stdout.write(
			`${chalk.bold("TTSR scan")} — mode=whole-file directory=${chalk.cyan(scanDir)} files=${chalk.dim(files.length)} scanned=${chalk.dim(scannedFiles)} rules=${chalk.dim(scanRulePlans.length)} gitignore=${chalk.dim(gitignore ? "on" : "off")} max-bytes=${chalk.dim(maxBytes === 0 ? "off" : String(maxBytes))}\n`,
		);
		if (countSkipped(skipped) > 0) {
			process.stdout.write(
				`${chalk.dim(`  skipped files: binary=${skipped.binary} large=${skipped.large} unreadable=${skipped.unreadable} no-relevant-rules=${skipped.noRelevantRules}`)}\n`,
			);
		}
		if (semanticSummary.rejected > 0 || semanticSummary.skipped > 0) {
			process.stdout.write(
				`${chalk.dim(`  semantic evidence: rejected=${semanticSummary.rejected} skipped=${semanticSummary.skipped}`)}\n`,
			);
		}

		if (matchedFiles === 0) {
			process.stdout.write(
				`${chalk.green.bold("No rule matches found.")} (evaluated ${rules.length} rules on ${scannedFiles}/${files.length} files)\n`,
			);
		} else {
			process.stdout.write(
				`${chalk.red.bold("Found violations/matches:")} (${totalMatches} matches across ${matchedFiles} files)\n`,
			);
			if (!includeDetails) {
				process.stdout.write(`${chalk.dim("  rerun with --verbose to list matched files and conditions")}\n`);
				return;
			}

			process.stdout.write("\n");
			for (const fr of fileResults) {
				process.stdout.write(`${chalk.bold.underline(fr.file)}\n`);
				for (const detail of fr.matches) {
					renderRuleDetail(detail, true);
				}
				process.stdout.write("\n");
			}
		}
		if (includeDetails && evaluationResults.length > 0) {
			process.stdout.write(`\n${chalk.dim("Evaluation details")}\n`);
			for (const fr of evaluationResults) {
				process.stdout.write(`${chalk.bold.underline(fr.file)}\n`);
				for (const detail of fr.evaluations) renderRuleDetail(detail, false);
			}
		}
	}
}

export async function runTtsrCommand(cmd: TtsrCommandArgs): Promise<void> {
	const cwd = getProjectDir();
	try {
		if (cmd.action === "test") {
			if (!cmd.test) {
				process.stderr.write(`${chalk.red("error: `ttsr test` requires a snippet, --file, or piped stdin")}\n`);
				process.exit(1);
			}
			await runTest(cmd.test, cmd.json ?? false, cwd);
			return;
		}
		if (cmd.action === "list") {
			await runList(cmd.json ?? false, cwd);
			return;
		}
		if (cmd.action === "scan") {
			if (!cmd.scan) {
				process.stderr.write(`${chalk.red("error: scan arguments missing")}\n`);
				process.exit(1);
			}
			await runScan(cmd.scan, cmd.json ?? false, cwd);
			return;
		}
		process.stderr.write(`${chalk.red(`error: unknown ttsr action: ${cmd.action}`)}\n`);
		process.exit(1);
	} finally {
		await shutdownLspClients();
	}
}

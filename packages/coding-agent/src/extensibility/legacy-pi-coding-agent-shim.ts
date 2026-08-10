/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@oh-my-pi/pi-coding-agent` (or one of its aliased scopes like
 * `@earendil-works/pi-coding-agent` or `@mariozechner/pi-coding-agent`).
 *
 * The coding-agent package's own barrel (`./src/index.ts`) cannot be listed
 * as a `bun --compile` extra entrypoint alongside the CLI entry without
 * silently breaking the main binary's startup (see issue #1474 follow-up).
 * Routing legacy plugin imports through this sibling shim sidesteps that
 * conflict: bun bundles a distinct entry whose path differs from the CLI
 * entry, while still re-exporting the canonical surface so plugins observe
 * the same module identity as a direct `@oh-my-pi/pi-coding-agent` import.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getKeybindings, type Keybinding } from "@oh-my-pi/pi-tui";
import {
	getAgentDbPath,
	getAgentDir,
	getProjectDir,
	isCompiledBinary,
	parseFrontmatter as parseOmpFrontmatter,
} from "@oh-my-pi/pi-utils";
import { getPackageDir as getOmpPackageDir } from "../config";
import { formatKeyHints } from "../config/keybindings";
import type { PromptTemplate } from "../config/prompt-templates";
import { Settings } from "../config/settings";
import type { CreateAgentSessionOptions, CreateAgentSessionResult, LoadExtensionsResult } from "../sdk";
import {
	discoverContextFiles,
	discoverPromptTemplates,
	discoverSessionExtensionPaths,
	discoverSkills,
	createAgentSession as ompCreateAgentSession,
} from "../sdk";
import { EventBus } from "../utils/event-bus";
import { convertImageToPng } from "../utils/image-loading";
import { discoverExtensionPaths, loadExtensionFromFactory, loadExtensions } from "./extensions";
import { ExtensionRuntime } from "./extensions/loader";
import type { ExtensionFactory } from "./extensions/types";
import { getEnabledPlugins, resolvePluginExtensionPaths, type ScopedInstalledPlugin } from "./plugins/loader";
import type { Skill } from "./skills";
import { loadSkillsFromDir } from "./skills";

/**
 * Convert an image attachment to PNG using the legacy package-root contract.
 *
 * Invalid or unsupported image data returns `null`, matching Pi's historical
 * helper instead of surfacing Bun's decoder error to extensions.
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	try {
		const converted = await convertImageToPng({ type: "image", data: base64Data, mimeType });
		return { data: converted.data, mimeType: converted.mimeType };
	} catch {
		return null;
	}
}

/** Format the active shortcut for legacy extensions that render keybinding hints. */
export function keyText(action: Keybinding): string {
	return formatKeyHints(getKeybindings().getKeys(action));
}

/** Parse frontmatter using the historical Pi package-root helper. */
export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

/** Parse YAML frontmatter and throw on invalid metadata. */
export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> {
	const { frontmatter, body } = parseOmpFrontmatter(content, { level: "fatal" });
	return { frontmatter: frontmatter as T, body };
}

/** Return content without YAML frontmatter. */
export function stripFrontmatter(content: string): string {
	return parseFrontmatter(content).body;
}

export const SettingsManager = {
	create(cwd: string, agentDir?: string): Promise<Settings> {
		return Settings.init({ cwd, agentDir });
	},

	inMemory(): Settings {
		return Settings.isolated();
	},
} as const;

/** Scope used by the legacy package manager for discovered resources. */
export type SourceScope = "user" | "project" | "temporary";

/** Discovery metadata exposed alongside a legacy package resource path. */
export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
}

/** One extension, skill, prompt, or theme resolved by the legacy package manager. */
export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

/** Resource groups returned by {@link DefaultPackageManager.resolve}. */
export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
	themes: ResolvedResource[];
}

/** Action a legacy caller requests when a configured package is unavailable. */
export type MissingSourceAction = "install" | "skip" | "error";

/** Construction inputs accepted by the legacy package manager. */
export interface DefaultPackageManagerOptions {
	cwd: string;
	agentDir: string;
	settingsManager: Settings | Promise<Settings>;
}

/**
 * Enumerates the extensions OMP would load through the historical package
 * manager surface used by legacy extensions.
 */
export class DefaultPackageManager {
	#cwd: string;
	#agentDir: string;
	#settingsManager: Settings | Promise<Settings>;

	constructor(options: DefaultPackageManagerOptions) {
		this.#cwd = options.cwd;
		this.#agentDir = options.agentDir;
		this.#settingsManager = options.settingsManager;
	}

	/** Resolve enabled extension paths with their OMP plugin provenance. */
	async resolve(_onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const settings = await this.#settingsManager;
		const configuredPaths = settings.get("extensions") ?? [];
		const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
		const [extensionPaths, plugins] = await Promise.all([
			discoverExtensionPaths(configuredPaths, this.#cwd, disabledExtensionIds),
			getEnabledPlugins(this.#cwd),
		]);
		const pluginByExtensionPath = new Map<string, ScopedInstalledPlugin>();
		for (const plugin of plugins) {
			for (const extensionPath of resolvePluginExtensionPaths(plugin)) {
				pluginByExtensionPath.set(path.resolve(extensionPath), plugin);
			}
		}

		const extensions = extensionPaths.map(extensionPath => {
			const resolvedPath = path.resolve(extensionPath);
			const plugin = pluginByExtensionPath.get(resolvedPath);
			const agentDirRelative = path.relative(path.resolve(this.#agentDir), resolvedPath);
			const metadata: PathMetadata = plugin
				? {
						source: `npm:${plugin.name}`,
						scope: plugin.scope,
						origin: "package",
						baseDir: plugin.path,
					}
				: {
						source: "auto",
						scope:
							agentDirRelative === "" ||
							(!agentDirRelative.startsWith("..") && !path.isAbsolute(agentDirRelative))
								? "user"
								: "project",
						origin: "top-level",
					};
			return { path: resolvedPath, enabled: true, metadata };
		});

		return { extensions, skills: [], prompts: [], themes: [] };
	}
}

/**
 * Resource-loader compatibility layer for legacy pi extensions.
 *
 * Upstream `@earendil-works/pi-coding-agent` centralizes extension / skill /
 * prompt / theme / AGENTS.md discovery inside a `DefaultResourceLoader`
 * instance that the caller constructs, `reload()`s, and hands to
 * `createAgentSession({ resourceLoader })`. Every published version of
 * pi-schedule-prompt (≥0.2.0) and other pi extensions that spawn subagents
 * import the class at module scope; a missing export takes the whole
 * extension down at parse time (issue #4567).
 *
 * OMP does the same discovery inline inside `createAgentSession()`, so this
 * shim intentionally does NOT re-implement pi's ResourceLoader plumbing.
 * Instead the loader captures the caller's intent (`no*` flags, `*Override`
 * callbacks, `additional*Paths`, `extensionFactories`, `settingsManager`,
 * `eventBus`) plus the discovery results, and the sibling `createAgentSession`
 * override below translates them into OMP's native session options
 * (`disableExtensionDiscovery`, `preloadedExtensionPaths`, `extensions`,
 * `skills`, `promptTemplates`, `contextFiles`, `settings`, `eventBus`,
 * `systemPrompt`) before delegating to `../sdk`.
 *
 * The pi surface it emulates is the intersection actually used by real
 * extensions in the wild — themes are silently dropped (OMP has no
 * session-level themes surface); `extendResources`, `loadProjectTrustExtensions`,
 * and provider-trust hooks are omitted.
 */

export type ResourceDiagnostic = {
	type: "error" | "warning" | "info";
	message: string;
	path?: string;
};

export interface AgentsFile {
	path: string;
	content: string;
}

/** Marker interface preserved for pi extensions that type against upstream. */
export interface Theme {
	name: string;
}

export interface DefaultResourceLoaderOptions {
	cwd?: string;
	agentDir?: string;
	settingsManager?: Settings | Promise<Settings>;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: ExtensionFactory[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string | string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: AgentsFile[] }) => { agentsFiles: AgentsFile[] };
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

/**
 * The subset of {@link DefaultResourceLoader} state consumed by the
 * {@link createAgentSession} adapter. Kept as an explicit interface so tests
 * (and any future third-party ResourceLoader passed to `createAgentSession`)
 * only need to satisfy the read surface — not the reload lifecycle.
 */
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: AgentsFile[] };
	getSystemPrompt(): string | undefined;
	getAppendSystemPrompt(): string[];
	reload(): Promise<void>;
	/** @internal — used by the shim's createAgentSession to detect its own loaders. */
	readonly __ompLegacyPiLoader?: true;
}

/** Create a pre-initialization runtime for legacy extension resource loaders. */
export function createExtensionRuntime(): ExtensionRuntime {
	return new ExtensionRuntime();
}

/**
 * Loader-owned inputs that {@link createAgentSession} needs regardless of
 * whether the caller provided extra options. `cwd`/`agentDir` fall back to
 * `getProjectDir()`/`getAgentDir()` at construction time so subsequent
 * `reload()` and `createAgentSession()` calls read the same directories the
 * caller thought they were configuring.
 */
interface ResolvedLoaderState {
	cwd: string;
	agentDir: string;
	settingsPromise?: Promise<Settings>;
	eventBus: EventBus;
	extensionFactories: ExtensionFactory[];
	noExtensions: boolean;
	additionalExtensionPaths: string[];
	additionalSkillPaths: string[];
	additionalPromptTemplatePaths: string[];
}

interface AdditionalSkillLoadResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

interface AdditionalPromptLoadResult {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
}

export class DefaultResourceLoader implements ResourceLoader {
	readonly __ompLegacyPiLoader = true as const;
	#state: ResolvedLoaderState;
	#options: DefaultResourceLoaderOptions;
	#extensionsResult: LoadExtensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	#skills: Skill[] = [];
	#skillDiagnostics: ResourceDiagnostic[] = [];
	#prompts: PromptTemplate[] = [];
	#promptDiagnostics: ResourceDiagnostic[] = [];
	#themes: Theme[] = [];
	#themeDiagnostics: ResourceDiagnostic[] = [];
	#agentsFiles: AgentsFile[] = [];
	#systemPrompt: string | undefined;
	#appendSystemPrompt: string[] = [];
	#loaded = false;

	constructor(options: DefaultResourceLoaderOptions = {}) {
		this.#options = options;
		const cwd = options.cwd ?? getProjectDir();
		const agentDir = options.agentDir ?? getAgentDir();
		this.#state = {
			cwd,
			agentDir,
			settingsPromise: options.settingsManager ? Promise.resolve(options.settingsManager) : undefined,
			eventBus: options.eventBus ?? new EventBus(),
			extensionFactories: options.extensionFactories ?? [],
			noExtensions: options.noExtensions ?? false,
			additionalExtensionPaths: options.additionalExtensionPaths ?? [],
			additionalSkillPaths: options.additionalSkillPaths ?? [],
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths ?? [],
		};
	}

	getExtensions(): LoadExtensionsResult {
		return this.#extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.#skills, diagnostics: this.#skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.#prompts, diagnostics: this.#promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.#themes, diagnostics: this.#themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: AgentsFile[] } {
		return { agentsFiles: this.#agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.#systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.#appendSystemPrompt;
	}

	/**
	 * Discovery snapshot used to seed the session. Emulates upstream pi's
	 * `reload()` lifecycle: run every enabled discovery arm against the
	 * resolved cwd/agentDir, then thread each result through the caller's
	 * `*Override` callback. Discovery arms guarded by an `no*` flag start from
	 * an empty base — callers that flipped the flag off still get the override
	 * hook, so overrides can inject synthetic entries without triggering a
	 * filesystem scan they explicitly opted out of.
	 */
	async reload(): Promise<void> {
		const { cwd, agentDir } = this.#state;
		const options = this.#options;

		let settingsPromise = this.#state.settingsPromise;
		if (!settingsPromise) {
			settingsPromise = Settings.init({ cwd, agentDir });
			this.#state.settingsPromise = settingsPromise;
		}
		const settings = await settingsPromise;

		const [extensionsResult, skillsBase, additionalSkills, prompts, additionalPrompts, agentsFiles] =
			await Promise.all([
				this.#loadExtensions(settings),
				options.noSkills
					? Promise.resolve({ skills: [], warnings: [] })
					: discoverSkills(cwd, agentDir, {
							...settings.getGroup("skills"),
							disabledExtensions: settings.get("disabledExtensions") ?? [],
						}),
				this.#loadAdditionalSkills(),
				options.noPromptTemplates ? Promise.resolve([]) : discoverPromptTemplates(cwd, agentDir),
				this.#loadAdditionalPromptTemplates(),
				options.noContextFiles ? Promise.resolve([]) : discoverContextFiles(cwd, agentDir),
			]);

		this.#extensionsResult = options.extensionsOverride
			? options.extensionsOverride(extensionsResult)
			: extensionsResult;

		const skillsBaseResult = {
			skills: [...skillsBase.skills, ...additionalSkills.skills],
			diagnostics: [
				...skillsBase.warnings.map(w => ({
					type: "warning" as const,
					message: w.message,
					path: w.skillPath,
				})),
				...additionalSkills.diagnostics,
			],
		};
		const skillsFinal = options.skillsOverride ? options.skillsOverride(skillsBaseResult) : skillsBaseResult;
		this.#skills = skillsFinal.skills;
		this.#skillDiagnostics = skillsFinal.diagnostics;

		const promptsBase = {
			prompts: [...prompts, ...additionalPrompts.prompts],
			diagnostics: additionalPrompts.diagnostics,
		};
		const promptsFinal = options.promptsOverride ? options.promptsOverride(promptsBase) : promptsBase;
		this.#prompts = promptsFinal.prompts;
		this.#promptDiagnostics = promptsFinal.diagnostics;

		const themesBase = { themes: [] as Theme[], diagnostics: [] as ResourceDiagnostic[] };
		const themesFinal = options.themesOverride ? options.themesOverride(themesBase) : themesBase;
		this.#themes = themesFinal.themes;
		this.#themeDiagnostics = themesFinal.diagnostics;

		const agentsFilesBase = { agentsFiles };
		const agentsFilesFinal = options.agentsFilesOverride
			? options.agentsFilesOverride(agentsFilesBase)
			: agentsFilesBase;
		this.#agentsFiles = agentsFilesFinal.agentsFiles;

		const baseSystemPrompt = options.systemPrompt;
		this.#systemPrompt = options.systemPromptOverride
			? options.systemPromptOverride(baseSystemPrompt)
			: baseSystemPrompt;

		const appendSource = options.appendSystemPrompt;
		const baseAppend =
			typeof appendSource === "string" ? [appendSource] : Array.isArray(appendSource) ? appendSource : [];
		this.#appendSystemPrompt = options.appendSystemPromptOverride
			? options.appendSystemPromptOverride(baseAppend)
			: baseAppend;

		this.#loaded = true;
	}

	async #loadExtensions(settings: Settings): Promise<LoadExtensionsResult> {
		const { cwd, noExtensions, additionalExtensionPaths, extensionFactories, eventBus } = this.#state;

		if (noExtensions && additionalExtensionPaths.length === 0 && extensionFactories.length === 0) {
			return { extensions: [], errors: [], runtime: createExtensionRuntime() };
		}

		const paths = await discoverSessionExtensionPaths(
			{
				disableExtensionDiscovery: noExtensions,
				additionalExtensionPaths,
			},
			cwd,
			settings,
		);

		const result = await loadExtensions(paths, cwd, eventBus);
		for (let i = 0; i < extensionFactories.length; i++) {
			const loaded = await loadExtensionFromFactory(
				extensionFactories[i],
				cwd,
				eventBus,
				result.runtime,
				`<inline-loader-${i}>`,
			);
			result.extensions.push(loaded);
		}
		return result;
	}

	async #loadAdditionalSkills(): Promise<AdditionalSkillLoadResult> {
		const skills: Skill[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalSkillPaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const skillDir =
				path.basename(resolvedPath).toLowerCase() === "skill.md" ? path.dirname(resolvedPath) : resolvedPath;
			try {
				const result = await loadSkillsFromDir({
					dir: skillDir,
					source: "legacy-resource-loader",
				});
				skills.push(...result.skills);
				diagnostics.push(
					...result.warnings.map(w => ({
						type: "warning" as const,
						message: w.message,
						path: w.skillPath,
					})),
				);
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to load additional skill path: ${err instanceof Error ? err.message : String(err)}`,
					path: resolvedPath,
				});
			}
		}

		return { skills, diagnostics };
	}

	async #loadAdditionalPromptTemplates(): Promise<AdditionalPromptLoadResult> {
		const prompts: PromptTemplate[] = [];
		const diagnostics: ResourceDiagnostic[] = [];

		for (const resourcePath of this.#state.additionalPromptTemplatePaths) {
			const resolvedPath = path.isAbsolute(resourcePath)
				? resourcePath
				: path.resolve(this.#state.cwd, resourcePath);
			const files: string[] = [];
			try {
				const stat = await fs.promises.stat(resolvedPath);
				if (stat.isDirectory()) {
					const glob = new Bun.Glob("**/*.md");
					for await (const entry of glob.scan({ cwd: resolvedPath, absolute: false, onlyFiles: true })) {
						files.push(path.join(resolvedPath, entry));
					}
					files.sort();
				} else if (resolvedPath.toLowerCase().endsWith(".md")) {
					files.push(resolvedPath);
				} else {
					diagnostics.push({
						type: "warning",
						message: "Additional prompt template path is neither a directory nor a Markdown file",
						path: resolvedPath,
					});
				}
			} catch (err) {
				diagnostics.push({
					type: "warning",
					message: `Failed to inspect additional prompt template path: ${err instanceof Error ? err.message : String(err)}`,
					path: resolvedPath,
				});
				continue;
			}

			for (const filePath of files) {
				try {
					const raw = await Bun.file(filePath).text();
					const { frontmatter, body } = parseFrontmatter(raw);
					const rawDescription = frontmatter.description;
					let description = typeof rawDescription === "string" ? rawDescription : "";
					if (!description) {
						const firstLine = body.split("\n").find(line => line.trim());
						if (firstLine) {
							description = firstLine.slice(0, 60);
							if (firstLine.length > 60) {
								description += "...";
							}
						}
					}

					const source = "(legacy-resource-loader)";
					prompts.push({
						name: path.basename(filePath, path.extname(filePath)),
						description: description ? `${description} ${source}` : source,
						content: body,
						source,
					});
				} catch (err) {
					diagnostics.push({
						type: "warning",
						message: `Failed to load additional prompt template: ${err instanceof Error ? err.message : String(err)}`,
						path: filePath,
					});
				}
			}
		}

		return { prompts, diagnostics };
	}

	/** Test seam: whether `reload()` has completed at least once. */
	get loaded(): boolean {
		return this.#loaded;
	}

	/** @internal — used by the shim's createAgentSession to translate options. */
	__getResolverState(): {
		cwd: string;
		agentDir: string;
		settingsPromise?: Promise<Settings>;
		eventBus: EventBus;
		extensionsResult: LoadExtensionsResult;
		skills: Skill[];
		prompts: PromptTemplate[];
		agentsFiles: AgentsFile[];
		systemPrompt: string | undefined;
		appendSystemPrompt: string[];
		extensionFactories: ExtensionFactory[];
	} {
		return {
			cwd: this.#state.cwd,
			agentDir: this.#state.agentDir,
			settingsPromise: this.#state.settingsPromise,
			eventBus: this.#state.eventBus,
			extensionsResult: this.#extensionsResult,
			skills: this.#skills,
			prompts: this.#prompts,
			agentsFiles: this.#agentsFiles,
			systemPrompt: this.#systemPrompt,
			appendSystemPrompt: this.#appendSystemPrompt,
			extensionFactories: this.#state.extensionFactories,
		};
	}
}

/**
 * Legacy pi extensions call `createAgentSession({ resourceLoader })`. OMP's
 * native option surface has no such field — extension / skill / prompt /
 * context-file discovery are configured directly on the session options — so
 * an untranslated call would silently ignore the loader (including its
 * `noExtensions`/`noSkills` opt-outs), re-run OMP's own discovery, and
 * happily re-load the calling extension into the subagent. That's exactly
 * the recursion the caller passed the loader to prevent.
 *
 * Translate the loader's captured state into OMP's option fields, then
 * delegate to the underlying SDK. Explicit fields on `options` override the
 * loader (matches upstream pi semantics — a caller can partially override a
 * shared loader).
 *
 * `resourceLoader` is not part of {@link CreateAgentSessionOptions}, so it's
 * accepted through a widened alias and stripped before the underlying call.
 */
export type LegacyPiCreateAgentSessionOptions = CreateAgentSessionOptions & {
	resourceLoader?: ResourceLoader;
};

export async function createAgentSession(
	options: LegacyPiCreateAgentSessionOptions = {},
): Promise<CreateAgentSessionResult> {
	const loader = options.resourceLoader;
	if (!loader) {
		return ompCreateAgentSession(options);
	}

	if (loader instanceof DefaultResourceLoader && !loader.loaded) {
		await loader.reload();
	}

	const state =
		loader instanceof DefaultResourceLoader
			? loader.__getResolverState()
			: {
					cwd: options.cwd ?? getProjectDir(),
					agentDir: options.agentDir ?? getAgentDir(),
					settingsPromise: undefined,
					eventBus: undefined,
					extensionsResult: loader.getExtensions(),
					skills: loader.getSkills().skills,
					prompts: loader.getPrompts().prompts,
					agentsFiles: loader.getAgentsFiles().agentsFiles,
					systemPrompt: loader.getSystemPrompt(),
					appendSystemPrompt: loader.getAppendSystemPrompt(),
					extensionFactories: [] as ExtensionFactory[],
				};

	const { resourceLoader: _, ...rest } = options;
	const forwarded: CreateAgentSessionOptions = {
		...rest,
		cwd: rest.cwd ?? state.cwd,
		agentDir: rest.agentDir ?? state.agentDir,
	};

	if (rest.eventBus === undefined && state.eventBus !== undefined) {
		forwarded.eventBus = state.eventBus;
	}
	if (rest.settings === undefined && rest.settingsManager === undefined && state.settingsPromise !== undefined) {
		forwarded.settingsManager = state.settingsPromise;
	}

	// Route the loader's already-loaded extension result through the SDK's
	// `preloadedExtensions` seam. Skipping this branch would let
	// `createAgentSession` re-run its own discovery and undo the caller's
	// `noExtensions: true`.
	if (rest.preloadedExtensions === undefined && rest.preloadedExtensionPaths === undefined) {
		forwarded.preloadedExtensions = state.extensionsResult;
	}

	if (rest.skills === undefined) {
		forwarded.skills = state.skills;
	}
	if (rest.promptTemplates === undefined) {
		forwarded.promptTemplates = state.prompts;
	}
	if (rest.contextFiles === undefined) {
		forwarded.contextFiles = state.agentsFiles;
	}

	if (rest.systemPrompt === undefined && state.systemPrompt !== undefined) {
		forwarded.systemPrompt = state.systemPrompt;
	}
	if (rest.appendSystemPrompt === undefined && state.appendSystemPrompt.length > 0) {
		forwarded.appendSystemPrompt = state.appendSystemPrompt.join("\n\n");
	}

	return ompCreateAgentSession(forwarded);
}

/**
 * Synchronous auth storage surface retained for legacy extensions.
 *
 * Modern OMP auth storage is asynchronous, while older provider extensions
 * call `AuthStorage.create().get()` during module initialization.
 */
export class AuthStorage {
	constructor() {
		fs.mkdirSync(path.dirname(getAgentDbPath()), { recursive: true, mode: 0o700 });
	}

	static create(): AuthStorage {
		return new AuthStorage();
	}

	get(provider: string): AuthCredential | undefined {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			return store.listAuthCredentials(provider)[0]?.credential;
		} finally {
			store.close();
		}
	}

	set(provider: string, credential: AuthCredential): void {
		const store = new SqliteAuthCredentialStore(new Database(getAgentDbPath()));
		try {
			store.upsertAuthCredentialForProvider(provider, credential);
		} finally {
			store.close();
		}
	}
}

/** Read the first active credential for a legacy extension provider. */
export function readStoredCredential(provider: string): AuthCredential | undefined {
	const storage = AuthStorage.create();
	return storage.get(provider);
}

// Pi SDK path helpers. `export * from "../index"` above only forwards
// `getAgentDir`; `getProjectDir` (a `@oh-my-pi/pi-utils` helper) and
// `getPackageDir` are absent from that barrel, so legacy extensions importing
// either fail Bun's static export check during validation (issue #5968).
export { getProjectDir } from "@oh-my-pi/pi-utils";

/**
 * Coding-agent package install directory, matching pi's string-valued
 * `getPackageDir()` contract (extensions do `path.join(getPackageDir(), ...)`
 * to auto-allow bundled docs/resources).
 *
 * omp's canonical `getPackageDir()` (`../config`) returns `undefined` inside a
 * `bun --compile` binary — `import.meta.dir` is `/$bunfs/root` and no owning
 * `package.json` exists (issue #1423). Returning `undefined` there would crash
 * every legacy `path.join(getPackageDir(), ...)` at runtime in the shipped
 * binary, the primary distribution. So fall back to the executable's own
 * directory in compiled mode, where the binary *is* the install root. The
 * `PI_PACKAGE_DIR` override and dev/source/npm-dist walk-up still win via the
 * canonical helper.
 */
export function getPackageDir(): string {
	return getOmpPackageDir() ?? (isCompiledBinary() ? path.dirname(process.execPath) : process.cwd());
}

// Legacy pi's `@earendil-works/pi-coding-agent` re-exported `estimateTokens`,
// `compact`, and `serializeConversation` from its package root (via
// `./core/compaction/index.ts`). In omp they live in
// `@oh-my-pi/pi-agent-core/compaction`, and the coding-agent barrel below does
// not forward them, so legacy extensions importing them fail Bun's static
// export check during validation (issues #6583, #7174, #7403).
export { compact, estimateTokens, serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";

// Same barrel gap for two more legacy package-root exports: pi re-exported the
// `CONFIG_DIR_NAME` constant and the CLI parser `parseArgs`. In omp
// `CONFIG_DIR_NAME` lives in `@oh-my-pi/pi-utils` and `parseArgs` in
// `../cli/args`, neither of which the barrel below forwards, so legacy
// extensions importing either fail Bun's static export check during validation.
export { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
export { parseArgs } from "../cli/args";

export * from "../index";
export { formatBytes as formatSize } from "../tools/render-utils";
export { copyToClipboard } from "../utils/clipboard";
export { Type } from "./legacy-typebox";

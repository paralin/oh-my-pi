/**
 * OMP extension-package sub-discovery provider.
 *
 * When a user configures an extension via `extensions:` (in settings) or
 * `--extension`/`-e` (on the CLI), the docs promise that the package's
 * sibling directories — `skills/`, `hooks/pre|post/`, `commands/`, `rules/`,
 * `prompts/`, and `.mcp.json` — are picked up by omp's standard
 * discovery surfaces. The native `omp` provider in `builtin.ts` only walks
 * `.omp/` and `~/.omp/agent/`, so without this provider those sub-trees are
 * silently ignored.
 *
 * Provider priority is set below the native `omp` provider (100) so an
 * extension package never shadows the user's own `.omp/` configuration on
 * dedup.
 *
 * @see ./omp-extension-roots.ts
 * @see ../../docs/extension-loading.md
 */
import * as path from "node:path";
import { logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Prompt, promptCapability } from "../capability/prompt";
import { type Rule, ruleCapability } from "../capability/rule";
import { type Skill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import type { LoadContext, LoadResult } from "../capability/types";
import {
	buildRuleFromMarkdown,
	createSourceMeta,
	loadFilesFromDir,
	parseRequestIdFormat,
	scanSkillsFromDir,
} from "./helpers";
import { listOmpExtensionRoots, type OmpExtensionRoot } from "./omp-extension-roots";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";

const PROVIDER_ID = "omp-plugins";
const DISPLAY_NAME = "OMP Extension Packages";
const DESCRIPTION = "Sub-discovery (skills, hooks, commands, rules, prompts, .mcp.json) inside extension packages";
const PRIORITY = 90;

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	const roots = await listOmpExtensionRoots(ctx);
	const results = await Promise.all(
		roots.map(root =>
			scanSkillsFromDir(ctx, {
				dir: path.join(root.path, "skills"),
				providerId: PROVIDER_ID,
				level: root.level,
				requireDescription: true,
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// =============================================================================
// Slash Commands
// =============================================================================

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const roots = await listOmpExtensionRoots(ctx);
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<SlashCommand>(ctx, path.join(root.path, "commands"), PROVIDER_ID, root.level, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					level: root.level,
					_source: source,
				}),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// =============================================================================
// Rules
// =============================================================================

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const roots = await listOmpExtensionRoots(ctx);
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<Rule>(ctx, path.join(root.path, "rules"), PROVIDER_ID, root.level, {
				extensions: ["md", "mdc"],
				transform: (name, content, filePath, source) =>
					buildRuleFromMarkdown(name, content, filePath, source, { stripNamePattern: /\.(md|mdc)$/ }),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// =============================================================================
// Prompts
// =============================================================================

async function loadPrompts(ctx: LoadContext): Promise<LoadResult<Prompt>> {
	const roots = await listOmpExtensionRoots(ctx);
	const results = await Promise.all(
		roots.map(root =>
			loadFilesFromDir<Prompt>(ctx, path.join(root.path, "prompts"), PROVIDER_ID, root.level, {
				extensions: ["md"],
				transform: (name, content, filePath, source) => ({
					name: name.replace(/\.md$/, ""),
					path: filePath,
					content,
					_source: source,
				}),
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// =============================================================================
// Hooks
// =============================================================================

const HOOK_TYPES: ReadonlyArray<"pre" | "post"> = ["pre", "post"];

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const roots = await listOmpExtensionRoots(ctx);
	const tasks: Array<{ root: OmpExtensionRoot; hookType: "pre" | "post" }> = [];
	for (const root of roots) {
		for (const hookType of HOOK_TYPES) {
			tasks.push({ root, hookType });
		}
	}
	const results = await Promise.all(
		tasks.map(({ root, hookType }) =>
			loadFilesFromDir<Hook>(ctx, path.join(root.path, "hooks", hookType), PROVIDER_ID, root.level, {
				transform: (name, _content, filePath, source) => {
					const baseName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
					const tool = baseName === "*" ? "*" : baseName;
					return {
						name,
						path: filePath,
						type: hookType,
						tool,
						level: root.level,
						_source: source,
					};
				},
			}),
		),
	);
	return {
		items: results.flatMap(r => r.items),
		warnings: results.flatMap(r => r.warnings ?? []),
	};
}

// =============================================================================
// MCP Servers
// =============================================================================

const MCP_FILENAMES = [".mcp.json", "mcp.json"] as const;

interface RawMcpServer {
	enabled?: boolean;
	timeout?: number;
	requestIdFormat?: unknown;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: MCPServer["auth"];
	oauth?: MCPServer["oauth"];
	type?: MCPServer["transport"];
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const roots = await listOmpExtensionRoots(ctx);
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const tasks: Array<{ root: OmpExtensionRoot; mcpPath: string }> = [];
	for (const root of roots) {
		for (const filename of MCP_FILENAMES) {
			tasks.push({ root, mcpPath: path.join(root.path, filename) });
		}
	}
	const contents = await Promise.all(tasks.map(({ mcpPath }) => readFile(mcpPath)));

	for (let i = 0; i < tasks.length; i++) {
		const raw = contents[i];
		if (raw === null) continue;
		const { root, mcpPath } = tasks[i];

		const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(raw);
		if (!parsed) {
			warnings.push(`[omp-plugins] Invalid JSON in ${mcpPath}`);
			logger.warn(`[omp-plugins] Invalid JSON in ${mcpPath}`);
			continue;
		}
		const servers = parsed.mcpServers;
		if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;

		for (const [serverName, serverCfg] of Object.entries(servers)) {
			if (!serverCfg || typeof serverCfg !== "object" || Array.isArray(serverCfg)) continue;
			const cfg = serverCfg as RawMcpServer;
			if (typeof cfg.command !== "string" && typeof cfg.url !== "string") {
				warnings.push(`[omp-plugins] Skipping MCP server "${serverName}" in ${mcpPath}: missing command or url`);
				continue;
			}
			// Root relative command/cwd at the plugin's config directory, not the
			// session cwd (MCP stdio spawning resolves relative values there).
			const rooted = resolvePluginStdioPaths({ command: cfg.command, cwd: cfg.cwd }, root.path);
			const requestIdFormat = parseRequestIdFormat(cfg.requestIdFormat);
			items.push({
				name: serverName,
				...(cfg.enabled !== undefined && { enabled: cfg.enabled }),
				...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
				...(requestIdFormat !== undefined && { requestIdFormat }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(cfg.args !== undefined && { args: cfg.args }),
				...(cfg.env !== undefined && { env: cfg.env }),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(cfg.url !== undefined && { url: cfg.url }),
				...(cfg.headers !== undefined && { headers: cfg.headers }),
				...(cfg.auth !== undefined && { auth: cfg.auth }),
				...(cfg.oauth !== undefined && { oauth: cfg.oauth }),
				...(cfg.type !== undefined && { transport: cfg.type }),
				_source: createSourceMeta(PROVIDER_ID, mcpPath, root.level),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadRules,
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadPrompts,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});

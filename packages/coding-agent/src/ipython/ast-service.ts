import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AstFindOptions,
	AstMatchStrictness,
	type AstReplaceOptions,
	astEdit,
	astGrep,
} from "@oh-my-pi/pi-natives";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_PATH_CHARS = 4_096;
const MAX_PATTERN_COUNT = 32;
const MAX_PATTERN_CHARS = 16_384;
const MAX_GLOB_CHARS = 1_024;
const MAX_MATCHES = 500;
const MAX_OFFSET = 10_000;
const MAX_REPLACEMENTS = 1_000;
const MAX_FILES = 500;
const MAX_TIMEOUT_MS = 120_000;

export interface IpythonAstServiceOptions {
	readonly cwd: string;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function requiredString(data: Readonly<Record<string, unknown>>, name: string, max: number): string {
	const value = data[name];
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalString(data: Readonly<Record<string, unknown>>, name: string, max: number): string | undefined {
	const value = data[name];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
	if (value.length > max) throw new RangeError(`${name} is too large`);
	return value;
}

function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const value = data[name] ?? fallback;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function patternsValue(data: Readonly<Record<string, unknown>>): string[] {
	const value = data.patterns;
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATTERN_COUNT) {
		throw new RangeError(`patterns must contain from 1 through ${MAX_PATTERN_COUNT} strings`);
	}
	return value.map((pattern, index) => {
		if (typeof pattern !== "string" || pattern.trim().length === 0) {
			throw new TypeError(`patterns[${index}] must be a nonempty string`);
		}
		if (pattern.length > MAX_PATTERN_CHARS) throw new RangeError(`patterns[${index}] is too large`);
		return pattern;
	});
}

function rewritesValue(data: Readonly<Record<string, unknown>>): Record<string, string> {
	const value = data.rewrites;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("rewrites must be an object");
	const entries = Object.entries(value);
	if (entries.length === 0 || entries.length > MAX_PATTERN_COUNT) {
		throw new RangeError(`rewrites must contain from 1 through ${MAX_PATTERN_COUNT} entries`);
	}
	for (const [pattern, replacement] of entries) {
		if (pattern.trim().length === 0) throw new TypeError("rewrites keys must be nonempty strings");
		if (pattern.length > MAX_PATTERN_CHARS) throw new RangeError("rewrites pattern is too large");
		if (typeof replacement !== "string") throw new TypeError("rewrites values must be strings");
		if (replacement.length > MAX_PATTERN_CHARS) throw new RangeError("rewrites value is too large");
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

function strictnessValue(
	data: Readonly<Record<string, unknown>>,
): AstFindOptions["strictness"] | AstReplaceOptions["strictness"] {
	const value = data.strictness ?? AstMatchStrictness.Smart;
	if (!Object.values(AstMatchStrictness).includes(value as AstMatchStrictness)) {
		throw new RangeError("strictness must be one of cst, smart, ast, relaxed, signature, or template");
	}
	return value as AstFindOptions["strictness"];
}

async function workspacePath(cwd: string, input: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const absolute = await fs.realpath(path.resolve(root, input));
	const relative = path.relative(root, absolute);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absolute;
	throw new RangeError(`path is outside the active workspace: ${input}`);
}

function searchOptions(request: IpythonHostRequest, target: string): AstFindOptions {
	const data = request.data;
	return {
		path: target,
		patterns: patternsValue(data),
		lang: optionalString(data, "language", 128),
		glob: optionalString(data, "glob", MAX_GLOB_CHARS),
		selector: optionalString(data, "selector", MAX_PATTERN_CHARS),
		strictness: strictnessValue(data),
		limit: integerValue(data, "limit", 50, 1, MAX_MATCHES),
		offset: integerValue(data, "offset", 0, 0, MAX_OFFSET),
		includeMeta: booleanValue(data, "include_meta", false),
		timeoutMs: integerValue(data, "timeout_ms", 0, 0, MAX_TIMEOUT_MS) || undefined,
		signal: request.signal,
	};
}

function rewriteOptions(request: IpythonHostRequest, target: string): AstReplaceOptions {
	const data = request.data;
	return {
		path: target,
		rewrites: rewritesValue(data),
		lang: optionalString(data, "language", 128),
		glob: optionalString(data, "glob", MAX_GLOB_CHARS),
		selector: optionalString(data, "selector", MAX_PATTERN_CHARS),
		strictness: strictnessValue(data),
		dryRun: booleanValue(data, "dry_run", true),
		maxReplacements: integerValue(data, "max_replacements", MAX_REPLACEMENTS, 1, MAX_REPLACEMENTS),
		maxFiles: integerValue(data, "max_files", MAX_FILES, 1, MAX_FILES),
		failOnParseError: booleanValue(data, "fail_on_parse_error", false),
		timeoutMs: integerValue(data, "timeout_ms", 0, 0, MAX_TIMEOUT_MS) || undefined,
		signal: request.signal,
	};
}

/** Creates bounded structural-search and rewrite handlers backed by pi-natives. */
export function createIpythonAstHostHandlers(options: IpythonAstServiceOptions): IpythonHostHandlers {
	return {
		"ast.search": async request => {
			strict(request.data, [
				"path",
				"patterns",
				"language",
				"glob",
				"selector",
				"strictness",
				"limit",
				"offset",
				"include_meta",
				"timeout_ms",
			]);
			const input = requiredString(request.data, "path", MAX_PATH_CHARS);
			const target = await workspacePath(options.cwd, input);
			await request.publishProgress("Searching syntax trees", { path: input });
			const result = await astGrep(searchOptions(request, target));
			await request.publishProgress("Syntax-tree search completed", {
				path: input,
				count: result.totalMatches,
				unit: "matches",
			});
			return result as unknown as Readonly<Record<string, unknown>>;
		},
		"ast.rewrite": async request => {
			strict(request.data, [
				"path",
				"rewrites",
				"language",
				"glob",
				"selector",
				"strictness",
				"dry_run",
				"max_replacements",
				"max_files",
				"fail_on_parse_error",
				"timeout_ms",
			]);
			const input = requiredString(request.data, "path", MAX_PATH_CHARS);
			const target = await workspacePath(options.cwd, input);
			const settings = rewriteOptions(request, target);
			await request.publishProgress("Rewriting syntax trees", { path: input, dryRun: settings.dryRun });
			const result = await astEdit(settings);
			await request.publishProgress("Syntax-tree rewrite completed", {
				path: input,
				count: result.totalReplacements,
				unit: "replacements",
				dryRun: settings.dryRun,
			});
			return result as unknown as Readonly<Record<string, unknown>>;
		},
	};
}

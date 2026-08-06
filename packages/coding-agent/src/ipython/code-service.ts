import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { formatHashlineHeader, type InMemorySnapshotStore } from "@oh-my-pi/hashline";
import { astEdit, astGrep, FileType, glob } from "@oh-my-pi/pi-natives";
import { withFileLock } from "@oh-my-pi/pi-utils";
import { generateDiffString } from "../edit/diff";
import { recordFileSnapshot } from "../edit/file-snapshot-store";
import { ensureFileOpen, getActiveClients, getOrCreateClient, refreshFile, sendRequest } from "../lsp/client";
import { getServersForFile, loadConfig } from "../lsp/config";
import { applyWorkspaceEdit } from "../lsp/edits";
import { getDiagnosticsForFile } from "../lsp/index";
import { requestReferences } from "../lsp/references";
import type {
	CodeAction,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	SymbolInformation,
	WorkspaceEdit,
} from "../lsp/types";
import { fileToUri, resolveSymbolColumn, uriToFile } from "../lsp/utils";
import type { IpythonDisplayEvent, IpythonHostArtifact, IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_READ_CHARS = 1024 * 1024;
const MAX_WRITE_CHARS = 8 * 1024 * 1024;
const MAX_GLOB_RESULTS = 500;
const MAX_AST_RESULTS = 200;
const MAX_AST_OPERATIONS = 20;
const DIFF_DISPLAY_MIME = "application/vnd.omp.diff+json";

export type IpythonLspAction =
	| "definition"
	| "type_definition"
	| "implementation"
	| "references"
	| "hover"
	| "symbols"
	| "diagnostics"
	| "rename"
	| "code_actions";

export interface IpythonLspQuery {
	readonly action: IpythonLspAction;
	readonly file: string;
	readonly line?: number;
	readonly symbol?: string;
	readonly newName?: string;
	readonly apply?: boolean;
}

export interface IpythonLspOwner {
	status(): Readonly<Record<string, unknown>>;
	query(input: IpythonLspQuery, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
}

export interface IpythonCodeServiceOptions {
	readonly cwd: string;
	readonly snapshotOwner: { fileSnapshotStore?: InMemorySnapshotStore };
	readonly lsp?: IpythonLspOwner;
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
	return value as Readonly<Record<string, unknown>>;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string {
	const value = data[name];
	if (value === undefined && options.optional) return "";
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? 16_384)) throw new RangeError(`${name} is too large`);
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

function safeRelative(cwd: string, absolute: string): string {
	const relative = path.relative(realpathSync(cwd), absolute).replaceAll("\\", "/");
	return relative || ".";
}

async function canonicalExistingPath(cwd: string, input: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const absolute = await fs.realpath(path.resolve(cwd, input));
	const relative = path.relative(root, absolute);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return absolute;
	throw new RangeError(`path is outside the active workspace: ${input}`);
}

async function canonicalWritePath(cwd: string, input: string): Promise<string> {
	const root = await fs.realpath(cwd);
	const requested = path.resolve(cwd, input);
	const parent = await fs.realpath(path.dirname(requested));
	const canonical = path.join(parent, path.basename(requested));
	const relative = path.relative(root, canonical);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new RangeError(`path is outside the active workspace: ${input}`);
	}
	try {
		const existing = await fs.lstat(requested);
		if (existing.isSymbolicLink()) throw new RangeError(`refusing to write through a symbolic link: ${input}`);
		if (!existing.isFile()) throw new TypeError(`path is not a regular file: ${input}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return canonical;
}

function richDisplay(mime: string, payload: Readonly<Record<string, unknown>>, text: string): IpythonDisplayEvent {
	return {
		kind: "display",
		data: { [mime]: payload, "text/plain": text },
		metadata: {},
		transient: {},
		update: false,
		text,
	};
}

async function boundedJsonResult(
	request: IpythonHostRequest,
	label: string,
	value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const encoded = JSON.stringify(value, null, 2);
	if (encoded.length <= MAX_READ_CHARS) return value;
	const artifact = await request.allocateArtifact({ label, mimeType: "application/json", suffix: ".json" });
	await fs.writeFile(artifact.path, encoded, "utf8");
	return {
		truncated: true,
		artifact: { ...artifact, bytes: Buffer.byteLength(encoded), mime_type: "application/json" },
		summary: Object.fromEntries(
			Object.entries(value).filter(([, item]) => typeof item === "number" || typeof item === "boolean"),
		),
	};
}

function normalizeLspLocation(cwd: string, location: Location | LocationLink): Readonly<Record<string, unknown>> {
	if ("targetUri" in location) {
		return {
			path: safeRelative(cwd, uriToFile(location.targetUri)),
			range: location.targetSelectionRange,
			origin_range: location.originSelectionRange ?? null,
		};
	}
	return { path: safeRelative(cwd, uriToFile(location.uri)), range: location.range };
}

function normalizeLspLocations(
	cwd: string,
	value: Location | Location[] | LocationLink | LocationLink[] | null,
): Readonly<Record<string, unknown>>[] {
	if (!value) return [];
	return (Array.isArray(value) ? value : [value]).slice(0, 500).map(location => normalizeLspLocation(cwd, location));
}

/** Adapts reusable LSP clients and edits without invoking the legacy LSP tool. */
export function createIpythonLspOwner(options: { cwd: string; readOnly?: boolean }): IpythonLspOwner {
	const { cwd } = options;
	return {
		status: () => {
			const config = loadConfig(cwd);
			return { configured: Object.keys(config.servers), active: getActiveClients() };
		},
		query: async (input, signal) => {
			signal.throwIfAborted();
			if (options.readOnly && (input.action === "rename" || input.apply)) {
				throw new Error(`LSP action ${input.action} is disabled in this read-only session`);
			}
			const absolute = await canonicalExistingPath(cwd, input.file);
			const config = loadConfig(cwd);
			const server = getServersForFile(config, absolute)[0];
			if (!server) throw new Error(`no language server is configured for ${input.file}`);
			const [serverName, serverConfig] = server;
			if (serverConfig.createClient) {
				throw new Error(`${serverName} is a linter service and does not support ${input.action}`);
			}
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			await ensureFileOpen(client, absolute, signal);
			const uri = fileToUri(absolute);
			const line = input.line ?? 1;
			if (!Number.isInteger(line) || line < 1) throw new RangeError("line must be a positive integer");
			const character = await resolveSymbolColumn(absolute, line, input.symbol);
			const position = { line: line - 1, character };
			const params = { textDocument: { uri }, position };
			switch (input.action) {
				case "definition": {
					const result = (await sendRequest(client, "textDocument/definition", params, signal)) as
						| Location
						| Location[]
						| LocationLink
						| LocationLink[]
						| null;
					return { action: input.action, server: serverName, locations: normalizeLspLocations(cwd, result) };
				}
				case "type_definition": {
					const result = (await sendRequest(client, "textDocument/typeDefinition", params, signal)) as
						| Location
						| Location[]
						| LocationLink
						| LocationLink[]
						| null;
					return { action: input.action, server: serverName, locations: normalizeLspLocations(cwd, result) };
				}
				case "implementation": {
					const result = (await sendRequest(client, "textDocument/implementation", params, signal)) as
						| Location
						| Location[]
						| LocationLink
						| LocationLink[]
						| null;
					return { action: input.action, server: serverName, locations: normalizeLspLocations(cwd, result) };
				}
				case "references": {
					const result = await requestReferences(client, serverConfig, uri, position, signal);
					return { action: input.action, server: serverName, locations: normalizeLspLocations(cwd, result) };
				}
				case "hover": {
					const hover = (await sendRequest(client, "textDocument/hover", params, signal)) as Hover | null;
					return { action: input.action, server: serverName, hover };
				}
				case "symbols": {
					const symbols = (await sendRequest(
						client,
						"textDocument/documentSymbol",
						{ textDocument: { uri } },
						signal,
					)) as (DocumentSymbol | SymbolInformation)[] | null;
					return { action: input.action, server: serverName, symbols: symbols?.slice(0, 500) ?? [] };
				}
				case "diagnostics": {
					try {
						const report = await sendRequest(
							client,
							"textDocument/diagnostic",
							{ textDocument: { uri } },
							signal,
						);
						return { action: input.action, server: serverName, report };
					} catch {
						signal.throwIfAborted();
						const servers = getServersForFile(config, absolute);
						const minVersions = new Map<string, number>();
						const expectedDocumentVersions = new Map<string, number>();
						for (const [name, candidate] of servers) {
							if (candidate.createClient) continue;
							const candidateClient =
								name === serverName ? client : await getOrCreateClient(candidate, cwd, undefined, signal);
							minVersions.set(name, candidateClient.diagnosticsVersion);
							await refreshFile(candidateClient, absolute, signal);
							const version = candidateClient.openFiles.get(uri)?.version;
							if (version !== undefined) expectedDocumentVersions.set(name, version);
						}
						const report = await getDiagnosticsForFile(absolute, cwd, servers, {
							signal,
							minVersions,
							expectedDocumentVersions,
						});
						return { action: input.action, server: serverName, report };
					}
				}
				case "rename": {
					if (!input.newName?.trim()) throw new TypeError("new_name must be a nonempty string");
					const edit = (await sendRequest(
						client,
						"textDocument/rename",
						{ ...params, newName: input.newName },
						signal,
					)) as WorkspaceEdit | null;
					const applied = input.apply && edit ? await applyWorkspaceEdit(edit, cwd) : [];
					return { action: input.action, server: serverName, edit, applied };
				}
				case "code_actions": {
					const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
					const actions = (await sendRequest(
						client,
						"textDocument/codeAction",
						{
							textDocument: { uri },
							range: { start: position, end: position },
							context: { diagnostics: diagnostics.slice(0, 500), triggerKind: 1 },
						},
						signal,
					)) as CodeAction[] | null;
					return { action: input.action, server: serverName, actions: actions?.slice(0, 200) ?? [] };
				}
			}
		},
	};
}

async function readFile(
	cwd: string,
	snapshotOwner: { fileSnapshotStore?: InMemorySnapshotStore },
	request: IpythonHostRequest,
): Promise<Record<string, unknown>> {
	request.signal.throwIfAborted();
	const data = request.data;
	strict(data, ["path", "offset", "limit"]);
	const input = stringValue(data, "path", { max: 4_096 });
	const offset = integerValue(data, "offset", 1, 1, Number.MAX_SAFE_INTEGER);
	const limit = integerValue(data, "limit", 2_000, 1, 20_000);
	const absolute = await canonicalExistingPath(cwd, input);
	const stat = await fs.stat(absolute);
	if (!stat.isFile()) throw new TypeError(`path is not a regular file: ${input}`);
	if (stat.size > MAX_FILE_BYTES) throw new RangeError(`file exceeds ${MAX_FILE_BYTES} bytes`);
	const bytes = await fs.readFile(absolute);
	if (bytes.includes(0))
		throw new TypeError("binary files must be inspected through an image or format-specific service");
	const allLines = bytes.toString("utf8").split("\n");
	const visible = allLines.slice(offset - 1, offset - 1 + limit);
	const selected = visible.join("\n");
	let content = selected;
	let truncated = offset - 1 + visible.length < allLines.length;
	let artifact: IpythonHostArtifact | undefined;
	if (content.length > MAX_READ_CHARS) {
		artifact = await request.allocateArtifact({
			label: path.basename(absolute),
			mimeType: "text/plain",
			suffix: ".txt",
		});
		await fs.writeFile(artifact.path, content, "utf8");
		content = content.slice(0, MAX_READ_CHARS);
		truncated = true;
	}
	const relative = safeRelative(cwd, absolute);
	const tag = await recordFileSnapshot(snapshotOwner, absolute);
	return {
		path: relative,
		content,
		offset,
		lines: visible.length,
		total_lines: allLines.length,
		size: stat.size,
		truncated,
		...(artifact ? { artifact: { ...artifact, bytes: Buffer.byteLength(selected), mime_type: "text/plain" } } : {}),
		...(tag ? { snapshot: formatHashlineHeader(relative, tag) } : {}),
	};
}

async function writeFile(cwd: string, request: IpythonHostRequest): Promise<Record<string, unknown>> {
	request.signal.throwIfAborted();
	const data = request.data;
	strict(data, ["path", "content", "overwrite"]);
	const input = stringValue(data, "path", { max: 4_096 });
	const content = stringValue(data, "content", { optional: true, max: MAX_WRITE_CHARS });
	const overwrite = booleanValue(data, "overwrite", false);
	const absolute = await canonicalWritePath(cwd, input);
	return await withFileLock(absolute, async () => {
		let before = "";
		let existed = false;
		try {
			before = await fs.readFile(absolute, "utf8");
			existed = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (existed && !overwrite) throw new Error("file exists; pass overwrite=True to replace it");
		const temporary = `${absolute}.omp-${process.pid}-${crypto.randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
			await fs.rename(temporary, absolute);
		} finally {
			await fs.rm(temporary, { force: true });
		}
		const relative = safeRelative(cwd, absolute);
		const diff = generateDiffString(before, content, undefined, { path: relative }).diff;
		const payload = { path: relative, created: !existed, diff };
		await request.publishDisplay(richDisplay(DIFF_DISPLAY_MIME, payload, diff));
		return { ...payload, bytes: Buffer.byteLength(content) };
	});
}

async function globFiles(cwd: string, request: IpythonHostRequest): Promise<Record<string, unknown>> {
	request.signal.throwIfAborted();
	const data = request.data;
	strict(data, ["pattern", "path", "hidden", "gitignore", "limit"]);
	const pattern = stringValue(data, "pattern", { max: 4_096 });
	const baseInput = stringValue(data, "path", { optional: true, max: 4_096 }) || ".";
	const hidden = booleanValue(data, "hidden", false);
	const gitignore = booleanValue(data, "gitignore", true);
	const limit = integerValue(data, "limit", 200, 1, MAX_GLOB_RESULTS);
	const base = await canonicalExistingPath(cwd, baseInput);
	const stat = await fs.stat(base);
	if (!stat.isDirectory()) throw new TypeError(`path is not a directory: ${baseInput}`);
	const result = await glob(
		{
			pattern,
			path: base,
			hidden,
			gitignore,
			maxResults: limit,
			sortByMtime: true,
			recursive: false,
			signal: request.signal,
		},
		() => {},
	);
	const entries = result.matches.map(match => {
		const absolute = path.resolve(base, match.path);
		return {
			path: safeRelative(cwd, absolute) + (match.fileType === FileType.Dir ? "/" : ""),
			mtime: match.mtime ?? null,
		};
	});
	return { entries, count: entries.length, truncated: result.totalMatches >= limit };
}

function astScope(data: Readonly<Record<string, unknown>>): { path: string; glob?: string } {
	const scopePath = stringValue(data, "path", { optional: true, max: 4_096 }) || ".";
	const globPattern = stringValue(data, "glob", { optional: true, max: 4_096 });
	return { path: scopePath, ...(globPattern ? { glob: globPattern } : {}) };
}

async function astSearch(cwd: string, request: IpythonHostRequest): Promise<Record<string, unknown>> {
	request.signal.throwIfAborted();
	const data = request.data;
	strict(data, ["pattern", "path", "glob", "offset", "limit"]);
	const pattern = stringValue(data, "pattern", { max: 16_384 });
	const offset = integerValue(data, "offset", 0, 0, 100_000);
	const limit = integerValue(data, "limit", 50, 1, MAX_AST_RESULTS);
	const scope = astScope(data);
	const base = await canonicalExistingPath(cwd, scope.path);
	await request.publishProgress("Searching syntax trees", { current: 0 });
	const result = await astGrep({
		patterns: [pattern],
		path: base,
		glob: scope.glob,
		offset,
		limit,
		includeMeta: true,
		signal: request.signal,
	});
	const matches = result.matches.map(match => ({
		...match,
		path: safeRelative(cwd, path.resolve(base, match.path)),
	}));
	await request.publishProgress("Searched syntax trees", {
		current: result.filesSearched,
		total: result.filesSearched,
	});
	return await boundedJsonResult(request, "AST search results", {
		matches,
		total_matches: result.totalMatches,
		files_with_matches: result.filesWithMatches,
		files_searched: result.filesSearched,
		truncated: result.limitReached,
		parse_errors: result.parseErrors ?? [],
	});
}

function astOperations(data: Readonly<Record<string, unknown>>): Record<string, string> {
	const raw = data.operations;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AST_OPERATIONS) {
		throw new RangeError(`operations must contain 1 through ${MAX_AST_OPERATIONS} entries`);
	}
	const rewrites: Record<string, string> = {};
	for (const [index, value] of raw.entries()) {
		const operation = record(value, `operations[${index}]`);
		strict(operation, ["pattern", "replacement"]);
		const pattern = stringValue(operation, "pattern", { max: 16_384 });
		if (Object.hasOwn(rewrites, pattern)) throw new TypeError("operation patterns must be unique");
		rewrites[pattern] = stringValue(operation, "replacement", { optional: true, max: 1024 * 1024 });
	}
	return rewrites;
}

async function astRewrite(cwd: string, request: IpythonHostRequest): Promise<Record<string, unknown>> {
	request.signal.throwIfAborted();
	const data = request.data;
	strict(data, ["operations", "path", "glob", "apply", "max_files", "fail_on_parse_error"]);
	const rewrites = astOperations(data);
	const scope = astScope(data);
	const base = await canonicalExistingPath(cwd, scope.path);
	const apply = booleanValue(data, "apply", false);
	const maxFiles = integerValue(data, "max_files", 50, 1, 500);
	const failOnParseError = booleanValue(data, "fail_on_parse_error", true);
	await request.publishProgress(apply ? "Applying syntax rewrite" : "Previewing syntax rewrite", { current: 0 });
	const result = await astEdit({
		rewrites,
		path: base,
		glob: scope.glob,
		dryRun: !apply,
		maxFiles,
		failOnParseError,
		signal: request.signal,
	});
	const changes = result.changes.map(change => ({
		...change,
		path: safeRelative(cwd, path.resolve(base, change.path)),
	}));
	const fileChanges = result.fileChanges.map(change => ({
		...change,
		path: safeRelative(cwd, path.resolve(base, change.path)),
	}));
	const payload = {
		changes,
		files: fileChanges,
		total_replacements: result.totalReplacements,
		files_touched: result.filesTouched,
		files_searched: result.filesSearched,
		applied: result.applied,
		truncated: result.limitReached,
		parse_errors: result.parseErrors ?? [],
	};
	if (changes.length > 0) {
		const text = changes
			.map(change => `${change.path}:${change.startLine}: ${change.before} -> ${change.after}`)
			.join("\n");
		await request.publishDisplay(richDisplay(DIFF_DISPLAY_MIME, payload, text));
	}
	await request.publishProgress(apply ? "Applied syntax rewrite" : "Previewed syntax rewrite", {
		current: result.filesSearched,
		total: result.filesSearched,
	});
	return await boundedJsonResult(request, "AST edit results", payload);
}

async function lspQuery(
	owner: IpythonLspOwner | undefined,
	action: IpythonLspAction,
	request: IpythonHostRequest,
): Promise<Readonly<Record<string, unknown>>> {
	if (!owner) throw new Error("LSP is disabled for this session");
	const data = request.data;
	strict(data, ["file", "line", "symbol", "new_name", "apply"]);
	const file = stringValue(data, "file", { max: 4_096 });
	const line = integerValue(data, "line", 1, 1, Number.MAX_SAFE_INTEGER);
	const symbol = stringValue(data, "symbol", { optional: true, max: 1_024 });
	const newName = stringValue(data, "new_name", { optional: true, max: 1_024 });
	const apply = booleanValue(data, "apply", false);
	await request.publishProgress(`Querying language server: ${action}`, { file });
	const result = await owner.query(
		{
			action,
			file,
			line,
			...(symbol ? { symbol } : {}),
			...(newName ? { newName } : {}),
			apply,
		},
		request.signal,
	);
	await request.publishProgress(`Language server completed: ${action}`, { file });
	return await boundedJsonResult(request, `LSP ${action} results`, { ...result });
}

/** Creates typed filesystem and structural-code handlers without resolving legacy tools. */
export function createIpythonCodeHostHandlers(options: IpythonCodeServiceOptions): IpythonHostHandlers {
	return {
		"files.read": request => readFile(options.cwd, options.snapshotOwner, request),
		"files.write": request => writeFile(options.cwd, request),
		"files.glob": request => globFiles(options.cwd, request),
		"code.ast_search": request => astSearch(options.cwd, request),
		"code.ast_edit": request => astRewrite(options.cwd, request),
		"code.lsp_status": request => {
			strict(request.data, []);
			return options.lsp?.status() ?? { configured: [], active: [], disabled: true };
		},
		"code.definition": request => lspQuery(options.lsp, "definition", request),
		"code.type_definition": request => lspQuery(options.lsp, "type_definition", request),
		"code.implementation": request => lspQuery(options.lsp, "implementation", request),
		"code.references": request => lspQuery(options.lsp, "references", request),
		"code.hover": request => lspQuery(options.lsp, "hover", request),
		"code.symbols": request => lspQuery(options.lsp, "symbols", request),
		"code.diagnostics": request => lspQuery(options.lsp, "diagnostics", request),
		"code.rename": request => lspQuery(options.lsp, "rename", request),
		"code.code_actions": request => lspQuery(options.lsp, "code_actions", request),
	};
}

import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
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
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_READ_CHARS = 1024 * 1024;

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
	readonly lsp?: IpythonLspOwner;
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

/** Creates typed language-server handlers for the active session. */
export function createIpythonCodeHostHandlers(options: IpythonCodeServiceOptions): IpythonHostHandlers {
	return {
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

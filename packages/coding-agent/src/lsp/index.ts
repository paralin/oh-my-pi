import { logger } from "@oh-my-pi/pi-utils";
import { formatPathRelativeToCwd } from "../tools/path-utils";
import { throwIfAborted } from "../tools/tool-errors";
import {
	getActiveClients,
	getOrCreateClient,
	type LspServerStatus,
	sendRequest,
	setIdleTimeout,
	supportsDocumentDiagnostics,
	WARMUP_TIMEOUT_MS,
	waitForProjectLoaded,
} from "./client";
import { getLinterClient } from "./clients";
import { hasRootMarkerAncestor, type LspConfig, loadConfig } from "./config";
import { isProjectAwareLspServer } from "./references";
import type { Diagnostic, LspClient, PublishedDiagnostics, ServerConfig } from "./types";
import { fileToUri, formatDiagnostic, formatDiagnosticsSummary, sortDiagnostics } from "./utils";

export type { LspServerStatus } from "./client";

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error" | "available";
	fileTypes: string[];
	error?: string;
}

/** Result from warming up LSP servers */
export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

/** Options for warming up LSP servers */
export interface LspWarmupOptions {
	/** Called when starting to connect to servers */
	onConnecting?: (serverNames: string[]) => void;
}

export function discoverStartupLspServers(
	cwd: string,
	status: LspStartupServerInfo["status"] = "connecting",
): LspStartupServerInfo[] {
	const config = loadConfig(cwd);
	return getLspServers(config).map(([name, serverConfig]) => ({
		name,
		status,
		fileTypes: serverConfig.fileTypes,
	}));
}

/**
 * Warm up LSP servers for a directory by connecting to all detected servers.
 * This should be called at startup to avoid cold-start delays.
 *
 * @param cwd - Working directory to detect and start servers for
 * @param options - Optional callbacks for progress reporting
 * @returns Status of each server that was started
 */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	// Notify caller which servers we're connecting to
	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	// Start all detected servers in parallel with a short timeout
	// Servers that don't respond quickly will be initialized lazily on first use
	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({
				name: result.value.name,
				status: "ready",
				fileTypes: result.value.fileTypes,
			});
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			logger.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({
				name,
				status: "error",
				fileTypes: serverConfig.fileTypes,
				error: errorMsg,
			});
		}
	}

	return { servers };
}

/**
 * Get status of currently active LSP servers.
 */
export function getLspStatus(): LspServerStatus[] {
	return getActiveClients();
}

function isCustomLinter(serverConfig: ServerConfig): boolean {
	return Boolean(serverConfig.createClient);
}

function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return (Object.entries(config.servers) as Array<[string, ServerConfig]>).filter(
		([, serverConfig]) => !isCustomLinter(serverConfig),
	);
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
const DIAGNOSTICS_POLL_MS = 100;
const DIAGNOSTICS_SETTLE_MS = 250;
function limitDiagnosticMessages(messages: string[]): string[] {
	if (messages.length <= DIAGNOSTIC_MESSAGE_LIMIT) {
		return messages;
	}
	return messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
}

const ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES: Record<number, true> = {
	1375: true,
	1378: true,
	2307: true,
	2580: true,
	2591: true,
	2792: true,
	2867: true,
};

function diagnosticCodeNumber(diagnostic: Diagnostic): number | null {
	if (typeof diagnostic.code === "number") return diagnostic.code;
	if (typeof diagnostic.code === "string" && /^\d+$/.test(diagnostic.code)) return Number(diagnostic.code);
	return null;
}
function isTypeScriptProjectDiagnostic(serverName: string, diagnostic: Diagnostic): boolean {
	if (diagnostic.source !== "typescript" && !serverName.toLowerCase().includes("typescript")) {
		return false;
	}
	const code = diagnosticCodeNumber(diagnostic);
	return code !== null && ORPHAN_TYPESCRIPT_PROJECT_DIAGNOSTIC_CODES[code] === true;
}

function filterOrphanProjectDiagnostics(
	absolutePath: string,
	serverName: string,
	serverConfig: ServerConfig,
	diagnostics: Diagnostic[],
): Diagnostic[] {
	if (!serverConfig.rootMarkers.length || hasRootMarkerAncestor(absolutePath, serverConfig.rootMarkers)) {
		return diagnostics;
	}
	return diagnostics.filter(diagnostic => !isTypeScriptProjectDiagnostic(serverName, diagnostic));
}

interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	/**
	 * Quiescence window (ms). typescript-language-server never echoes the document
	 * version (issue #983) and emits diagnostics from several sources at different
	 * times, so there is no single "complete, version-matched" publish to gate on.
	 * When the server does not exact-version-match, accept the latest publish only
	 * after no newer one has arrived for this long, letting an in-flight pre-edit
	 * publish be superseded by the fresh one.
	 */
	settleMs?: number;
}

function requestDocumentDiagnostics(
	client: LspClient,
	uri: string,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<Diagnostic[] | undefined> {
	return sendRequest(client, "textDocument/diagnostic", { textDocument: { uri } }, signal, timeoutMs)
		.then(report => {
			if (!report || typeof report !== "object" || !("kind" in report) || report.kind !== "full") {
				return undefined;
			}
			if (!("items" in report) || !Array.isArray(report.items)) return undefined;
			return report.items;
		})
		.catch(err => {
			if (!signal?.aborted) {
				logger.debug("LSP document diagnostic pull failed", { server: client.name, uri, error: String(err) });
			}
			return undefined;
		});
}

async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, settleMs = DIAGNOSTICS_SETTLE_MS } = options;
	const deadline = Date.now() + timeoutMs;
	let pullAttempted = false;
	let pullResultPromise: Promise<{ diagnostics: Diagnostic[] | undefined }> | undefined;
	let pulled: Diagnostic[] | undefined;
	let settledRef: PublishedDiagnostics | undefined;
	let settledAt = 0;
	while (Date.now() < deadline) {
		throwIfAborted(signal);
		if (!pullAttempted && supportsDocumentDiagnostics(client)) {
			pullAttempted = true;
			pullResultPromise = requestDocumentDiagnostics(client, uri, signal, Math.max(1, deadline - Date.now())).then(
				diagnostics => ({ diagnostics }),
			);
		}

		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const published = client.diagnostics.get(uri);
		if (published && versionOk) {
			// Server honored our exact document version → authoritative, accept now.
			if (expectedDocumentVersion !== undefined && published.version === expectedDocumentVersion) {
				return published.diagnostics;
			}
			// Unversioned/mismatched publish: wait for the stream to go quiet so an
			// in-flight publish for the pre-edit content is superseded by the fresh one.
			if (published !== settledRef) {
				settledRef = published;
				settledAt = Date.now();
			} else if (Date.now() - settledAt >= settleMs) {
				return published.diagnostics;
			}
		}

		const pollMs = Math.min(DIAGNOSTICS_POLL_MS, Math.max(0, deadline - Date.now()));
		if (!pullResultPromise) {
			await Bun.sleep(pollMs);
			continue;
		}
		const pullResult = await Promise.race([pullResultPromise, Bun.sleep(pollMs).then(() => undefined)]);
		if (pullResult) {
			pullResultPromise = undefined;
			pulled = pullResult.diagnostics;
			if (pulled !== undefined) break;
		}
	}

	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	const published = client.diagnostics.get(uri);
	if (published && versionOk) {
		return published.diagnostics;
	}
	if (pullResultPromise) {
		pulled = (await pullResultPromise).diagnostics;
	}
	throwIfAborted(signal);
	if (pulled === undefined) return [];
	client.diagnostics.set(uri, {
		diagnostics: pulled,
		version: expectedDocumentVersion ?? client.openFiles.get(uri)?.version ?? null,
	});
	client.diagnosticsVersion += 1;
	return pulled;
}

/** Result from getDiagnosticsForFile */
export interface FileDiagnosticsResult {
	/** Name of the LSP server used (if available) */
	server?: string;
	/** Formatted diagnostic messages */
	messages: string[];
	/** Summary string (e.g., "2 error(s), 1 warning(s)") */
	summary: string;
	/** Whether there are any errors (severity 1) */
	errored: boolean;
}

type ServerVersionMap = Map<string, number>;

export interface GetDiagnosticsForFileOptions {
	signal?: AbortSignal;
	minVersions?: ServerVersionMap;
	expectedDocumentVersions?: ServerVersionMap;
	/** Per-server wait budget (ms). Defaults to {@link SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Get diagnostics for a file using LSP or custom linter client.
 *
 * @param absolutePath - Absolute path to the file
 * @param cwd - Working directory for LSP config resolution
 * @param servers - Servers to query diagnostics for
 * @param minVersions - Minimum diagnostic versions per server (to detect stale results)
 * @returns Diagnostic results or undefined if no servers
 */
export async function getDiagnosticsForFile(
	absolutePath: string,
	cwd: string,
	servers: Array<[string, ServerConfig]>,
	options: GetDiagnosticsForFileOptions = {},
): Promise<FileDiagnosticsResult | undefined> {
	const { signal, minVersions, expectedDocumentVersions, timeoutMs } = options;
	if (servers.length === 0) {
		return undefined;
	}

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const allDiagnostics: Diagnostic[] = [];
	const serverNames: string[] = [];

	// Wait for diagnostics from all servers in parallel
	const results = await Promise.allSettled(
		servers.map(async ([serverName, serverConfig]) => {
			throwIfAborted(signal);
			// Use custom linter client if configured
			if (serverConfig.createClient) {
				const linterClient = getLinterClient(serverName, serverConfig, cwd);
				const diagnostics = await linterClient.lint(absolutePath);
				return { serverName, serverConfig, diagnostics };
			}

			// Default: use LSP
			const client = await getOrCreateClient(serverConfig, cwd, undefined, signal);
			throwIfAborted(signal);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, signal);
				throwIfAborted(signal);
			}
			// The caller established the minimum diagnostic version after refreshing the document.
			const minVersion = minVersions?.get(serverName);
			const expectedDocumentVersion = expectedDocumentVersions?.get(serverName);
			const diagnostics = await waitForDiagnostics(client, uri, {
				timeoutMs: timeoutMs ?? SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS,
				signal,
				minVersion,
				expectedDocumentVersion,
			});
			return { serverName, serverConfig, diagnostics };
		}),
	);

	for (const result of results) {
		if (result.status === "fulfilled") {
			serverNames.push(result.value.serverName);
			allDiagnostics.push(
				...filterOrphanProjectDiagnostics(
					absolutePath,
					result.value.serverName,
					result.value.serverConfig,
					result.value.diagnostics,
				),
			);
		}
	}

	if (serverNames.length === 0) {
		return undefined;
	}

	if (allDiagnostics.length === 0) {
		return {
			server: serverNames.join(", "),
			messages: [],
			summary: "OK",
			errored: false,
		};
	}

	// Deduplicate diagnostics by range + message (different servers might report similar issues)
	const seen = new Set<string>();
	const uniqueDiagnostics: Diagnostic[] = [];
	for (const d of allDiagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (!seen.has(key)) {
			seen.add(key);
			uniqueDiagnostics.push(d);
		}
	}

	sortDiagnostics(uniqueDiagnostics);
	const formatted = uniqueDiagnostics.map(d => formatDiagnostic(d, relPath));
	const limited = limitDiagnosticMessages(formatted);
	const summary = formatDiagnosticsSummary(uniqueDiagnostics);
	const hasErrors = uniqueDiagnostics.some(d => d.severity === 1);

	return {
		server: serverNames.join(", "),
		messages: limited,
		summary,
		errored: hasErrors,
	};
}

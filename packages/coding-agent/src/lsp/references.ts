import { untilAborted } from "@oh-my-pi/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import { ensureFileOpen, getOrCreateClient, sendRequest, setIdleTimeout, waitForProjectLoaded } from "./client";
import { getServersForFile, type LspConfig, loadConfig } from "./config";
import type { Location, LspClient, Position, ServerConfig } from "./types";
import { fileToUri } from "./utils";

const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 250;

export interface ReferenceLookupRequest {
	cwd: string;
	filePath: string;
	position: Position;
	signal?: AbortSignal;
	config?: LspConfig;
}

export interface ReferenceLookupSuccess {
	status: "ok";
	serverName: string;
	uri: string;
	position: Position;
	locations: Location[];
}

export interface ReferenceLookupUnavailable {
	status: "unavailable";
	reason: string;
}

export type ReferenceLookupResult = ReferenceLookupSuccess | ReferenceLookupUnavailable;

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.createClient && !serverConfig.isLinter;
}

function comparePosition(left: Position, right: Position): number {
	return left.line === right.line ? left.character - right.character : left.line - right.line;
}

export function locationContainsPosition(location: Location, uri: string, position: Position): boolean {
	return (
		location.uri === uri &&
		comparePosition(location.range.start, position) <= 0 &&
		comparePosition(position, location.range.end) <= 0
	);
}

function isOnlyQueriedDeclaration(locations: readonly Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locationContainsPosition(locations[0], uri, position);
}

/** Request raw reference locations while preserving the project-load retry contract. */
export async function requestReferences(
	client: LspClient,
	serverConfig: ServerConfig,
	uri: string,
	position: Position,
	signal?: AbortSignal,
): Promise<Location[]> {
	let locations: Location[] = [];
	for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
		throwIfAborted(signal);
		locations =
			((await sendRequest(
				client,
				"textDocument/references",
				{
					textDocument: { uri },
					position,
					context: { includeDeclaration: true },
				},
				signal,
			)) as Location[] | null) ?? [];

		if (
			!isProjectAwareLspServer(serverConfig) ||
			attempt === REFERENCES_RETRY_COUNT ||
			(locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position))
		) {
			break;
		}
		await waitForProjectLoaded(client, signal);
		throwIfAborted(signal);
		await untilAborted(signal, () => Bun.sleep(REFERENCES_RETRY_DELAY_MS));
	}
	return locations;
}

/** Resolve the primary language server and return references for one source position. */
export async function findReferences(request: ReferenceLookupRequest): Promise<ReferenceLookupResult> {
	throwIfAborted(request.signal);
	const config = request.config ?? loadConfig(request.cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const server = getServersForFile(config, request.filePath).find(([, candidate]) =>
		isProjectAwareLspServer(candidate),
	);
	if (!server) {
		return { status: "unavailable", reason: "no project-aware language server supports this file" };
	}
	const [serverName, serverConfig] = server;
	const client = await getOrCreateClient(serverConfig, request.cwd, undefined, request.signal);
	if (!client.serverCapabilities?.referencesProvider) {
		return { status: "unavailable", reason: `${serverName} does not advertise reference support` };
	}
	await ensureFileOpen(client, request.filePath, request.signal);
	await waitForProjectLoaded(client, request.signal);
	const uri = fileToUri(request.filePath);
	const locations = await requestReferences(client, serverConfig, uri, request.position, request.signal);
	return { status: "ok", serverName, uri, position: request.position, locations };
}

import * as fs from "node:fs";
import * as path from "node:path";

import { ADVISOR_TRANSCRIPT_FILENAME, isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import type { FileEntry, SessionHeader } from "../session/session-entries";
import { loadEntriesFromFile } from "../session/session-loader";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "./agent-registry";

const JSONL_SUFFIX = ".jsonl";

export interface PersistedSubagentDiscoveryOptions {
	registry?: AgentRegistry;
	parentId?: string;
	status?: AgentStatus;
	targetId?: string;
}

function registerAdvisorTranscript(
	registry: AgentRegistry,
	entryName: string,
	sessionFile: string,
	parentId: string | undefined,
): AgentRef | undefined {
	const owner = parentId ?? MAIN_AGENT_ID;
	const slug =
		entryName === ADVISOR_TRANSCRIPT_FILENAME ? "" : entryName.slice("__advisor.".length, -JSONL_SUFFIX.length);
	const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
	const existing = registry.get(advisorId);
	if (existing && existing.kind !== "advisor") return existing;
	if (existing?.sessionFile === sessionFile) return existing;
	if (existing) registry.unregister(advisorId);
	return registry.register({
		id: advisorId,
		displayName: slug ? `advisor:${slug}` : "advisor",
		kind: "advisor",
		parentId: owner,
		session: null,
		sessionFile,
		status: "parked",
	});
}

function registerSubagentTranscript(
	registry: AgentRegistry,
	id: string,
	sessionFile: string,
	parentId: string | undefined,
	status: AgentStatus,
): AgentRef {
	const existing = registry.get(id);
	if (existing) return existing;
	return registry.register({
		id,
		displayName: id,
		kind: "sub",
		parentId: parentId ?? MAIN_AGENT_ID,
		session: null,
		sessionFile,
		status,
	});
}

export function registerPersistedSubagentsFromDir(
	dir: string,
	options: PersistedSubagentDiscoveryOptions = {},
): AgentRef | undefined {
	const registry = options.registry ?? AgentRegistry.global();
	const status = options.status ?? "parked";
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	let matched: AgentRef | undefined;
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(JSONL_SUFFIX) || entry.name.includes(".bak")) continue;
		const sessionFile = path.join(dir, entry.name);
		if (isAdvisorTranscriptName(entry.name)) {
			const ref = registerAdvisorTranscript(registry, entry.name, sessionFile, options.parentId);
			if (ref?.id === options.targetId) matched = ref;
			continue;
		}
		const id = entry.name.slice(0, -JSONL_SUFFIX.length);
		const ref = registerSubagentTranscript(registry, id, sessionFile, options.parentId, status);
		if (ref.id === options.targetId) matched = ref;
		const nestedMatch = registerPersistedSubagentsFromDir(path.join(dir, id), {
			...options,
			registry,
			parentId: id,
			status,
		});
		if (nestedMatch) matched = nestedMatch;
	}
	return matched;
}

export function registerPersistedSubagents(
	sessionFile: string | null | undefined,
	options: PersistedSubagentDiscoveryOptions = {},
): AgentRef | undefined {
	const root = sessionFile?.endsWith(JSONL_SUFFIX) ? sessionFile.slice(0, -JSONL_SUFFIX.length) : undefined;
	if (!root) return undefined;
	return registerPersistedSubagentsFromDir(root, options);
}

async function parentSessionFile(sessionFile: string): Promise<string | undefined> {
	let entries: FileEntry[];
	try {
		entries = await loadEntriesFromFile(sessionFile);
	} catch {
		return undefined;
	}
	const header = entries.find(entry => entry.type === "session") as SessionHeader | undefined;
	const parentSession = header?.parentSession;
	if (!parentSession?.endsWith(JSONL_SUFFIX)) return undefined;
	return path.isAbsolute(parentSession) ? parentSession : path.resolve(path.dirname(sessionFile), parentSession);
}

async function registerKnownSessionChain(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	targetId: string | undefined,
	visited: Set<string>,
): Promise<AgentRef | undefined> {
	if (!sessionFile?.endsWith(JSONL_SUFFIX)) return undefined;
	const resolved = path.resolve(sessionFile);
	if (visited.has(resolved)) return undefined;
	visited.add(resolved);
	let matched = registerPersistedSubagents(resolved, { registry, targetId });
	if (matched && (!targetId || matched.id === targetId)) return matched;
	const parent = await parentSessionFile(resolved);
	const parentMatched = await registerKnownSessionChain(registry, parent, targetId, visited);
	if (parentMatched) matched = parentMatched;
	return matched;
}

export async function registerPersistedSubagentsForKnownSessions(
	options: PersistedSubagentDiscoveryOptions = {},
): Promise<AgentRef | undefined> {
	const registry = options.registry ?? AgentRegistry.global();
	const visited = new Set<string>();
	let matched: AgentRef | undefined;
	for (const ref of registry.list()) {
		if (ref.kind === "advisor") continue;
		const found = await registerKnownSessionChain(registry, ref.sessionFile, options.targetId, visited);
		if (found) matched = found;
		if (options.targetId && found?.id === options.targetId) return found;
	}
	return matched;
}

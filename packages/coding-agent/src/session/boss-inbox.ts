import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { sessionSteeringDirForSessionFile } from "./session-steering";

export const SESSION_BOSS_INBOX_FILE_NAME = "boss-inbox.jsonl";

export type BossInboxMessageKind = "question" | "status" | "finding";

export interface BossInboxRecord {
	id: string;
	timestamp: string;
	sessionId: string;
	from: string;
	kind: BossInboxMessageKind;
	message: string;
}

export interface AppendBossInboxMessageOptions {
	sessionId: string;
	from: string;
	kind: BossInboxMessageKind;
	message: string;
	now?: Date;
	id?: string;
}

export interface BossInboxReadResult {
	records: BossInboxRecord[];
	nextOffset: number;
}

export function sessionBossInboxFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSteeringDirForSessionFile(sessionFile), SESSION_BOSS_INBOX_FILE_NAME);
}

export function normalizeBossInboxKind(kind: string | undefined): BossInboxMessageKind {
	if (kind === "question" || kind === "status" || kind === "finding") return kind;
	return "status";
}

function parseBossInboxRecord(line: string): BossInboxRecord {
	const value = JSON.parse(line) as unknown;
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		!("timestamp" in value) ||
		!("sessionId" in value) ||
		!("from" in value) ||
		!("kind" in value) ||
		!("message" in value) ||
		typeof value.id !== "string" ||
		typeof value.timestamp !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.from !== "string" ||
		(value.kind !== "question" && value.kind !== "status" && value.kind !== "finding") ||
		typeof value.message !== "string"
	) {
		throw new Error("boss inbox entry must be a JSON object with id, timestamp, sessionId, from, kind, and message");
	}
	return value as BossInboxRecord;
}

export async function appendSessionBossInboxMessage(
	sessionFile: string,
	opts: AppendBossInboxMessageOptions,
): Promise<BossInboxRecord> {
	const message = opts.message.trim();
	if (!message) throw new Error("boss inbox message cannot be empty");
	const sessionId = opts.sessionId.trim();
	if (!sessionId) throw new Error("boss inbox session id cannot be empty");
	const from = opts.from.trim();
	if (!from) throw new Error("boss inbox sender cannot be empty");
	const record: BossInboxRecord = {
		id: opts.id ?? crypto.randomUUID(),
		timestamp: (opts.now ?? new Date()).toISOString(),
		sessionId,
		from,
		kind: opts.kind,
		message,
	};
	const inboxFile = sessionBossInboxFileForSessionFile(sessionFile);
	await fs.mkdir(path.dirname(inboxFile), { recursive: true, mode: 0o700 });
	await fs.appendFile(inboxFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	return record;
}

/** Read complete JSONL records at or after a byte offset without consuming a partial trailing line. */
export async function readSessionBossInboxFileFromOffset(
	sessionFile: string,
	offset = 0,
): Promise<BossInboxReadResult> {
	if (!Number.isSafeInteger(offset) || offset < 0) {
		throw new Error("boss inbox offset must be a non-negative integer");
	}
	const inboxFile = sessionBossInboxFileForSessionFile(sessionFile);
	let bytes: Uint8Array;
	try {
		bytes = await fs.readFile(inboxFile);
	} catch (error) {
		if (isEnoent(error)) return { records: [], nextOffset: offset };
		throw error;
	}
	const start = offset > bytes.byteLength ? 0 : offset;
	const newline = bytes.lastIndexOf(10);
	if (newline < start) return { records: [], nextOffset: start };
	const complete = bytes.subarray(start, newline + 1);
	const records: BossInboxRecord[] = [];
	for (const line of new TextDecoder().decode(complete).split("\n")) {
		const trimmed = line.trim();
		if (trimmed) records.push(parseBossInboxRecord(trimmed));
	}
	return { records, nextOffset: newline + 1 };
}

export async function readSessionBossInboxFile(sessionFile: string): Promise<BossInboxRecord[]> {
	return (await readSessionBossInboxFileFromOffset(sessionFile)).records;
}

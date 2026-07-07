import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
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

export function sessionBossInboxFileForSessionFile(sessionFile: string): string {
	return path.join(sessionSteeringDirForSessionFile(sessionFile), SESSION_BOSS_INBOX_FILE_NAME);
}

export function normalizeBossInboxKind(kind: string | undefined): BossInboxMessageKind {
	if (kind === "question" || kind === "status" || kind === "finding") return kind;
	return "status";
}

export function appendSessionBossInboxMessage(
	sessionFile: string,
	opts: AppendBossInboxMessageOptions,
): BossInboxRecord {
	const message = opts.message.trim();
	if (!message) throw new Error("boss inbox message cannot be empty");
	const sessionId = opts.sessionId.trim();
	if (!sessionId) throw new Error("boss inbox session id cannot be empty");
	const from = opts.from.trim();
	if (!from) throw new Error("boss inbox sender cannot be empty");
	const record: BossInboxRecord = {
		id: opts.id ?? randomUUID(),
		timestamp: (opts.now ?? new Date()).toISOString(),
		sessionId,
		from,
		kind: opts.kind,
		message,
	};
	const inboxFile = sessionBossInboxFileForSessionFile(sessionFile);
	fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
	fs.appendFileSync(inboxFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
	return record;
}

export function readSessionBossInboxFile(sessionFile: string): BossInboxRecord[] {
	const inboxFile = sessionBossInboxFileForSessionFile(sessionFile);
	let content: string;
	try {
		content = fs.readFileSync(inboxFile, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: BossInboxRecord[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const value = JSON.parse(trimmed) as BossInboxRecord;
		if (
			!value ||
			typeof value !== "object" ||
			typeof value.id !== "string" ||
			typeof value.timestamp !== "string" ||
			typeof value.sessionId !== "string" ||
			typeof value.from !== "string" ||
			(value.kind !== "question" && value.kind !== "status" && value.kind !== "finding") ||
			typeof value.message !== "string"
		) {
			throw new Error(
				"boss inbox entry must be a JSON object with id, timestamp, sessionId, from, kind, and message",
			);
		}
		records.push(value);
	}
	return records;
}

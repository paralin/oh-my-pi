import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendSessionBossInboxMessage,
	readSessionBossInboxFile,
	SESSION_BOSS_INBOX_FILE_NAME,
	sessionBossInboxFileForSessionFile,
} from "./boss-inbox";
import { sessionSteeringFileForSessionFile } from "./session-steering";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-boss-inbox-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function sessionFile(name: string): string {
	return path.join(tmp, `${name}.jsonl`);
}

describe("session boss inbox", () => {
	it("appends trimmed records to the persisted sidecar beside the steering file", async () => {
		const sessionPath = sessionFile("worker-session");
		const bossInboxPath = sessionBossInboxFileForSessionFile(sessionPath);
		const steeringPath = sessionSteeringFileForSessionFile(sessionPath);

		const record = appendSessionBossInboxMessage(sessionPath, {
			id: "boss-msg-1",
			now: new Date("2026-07-07T08:00:00.000Z"),
			sessionId: " session-123 ",
			from: " WorkerA ",
			kind: "question",
			message: "  Should I retry this migration?  \n",
		});

		expect(path.basename(bossInboxPath)).toBe(SESSION_BOSS_INBOX_FILE_NAME);
		expect(path.dirname(bossInboxPath)).toBe(path.dirname(steeringPath));
		expect(await fs.readFile(bossInboxPath, "utf8")).toBe(`${JSON.stringify(record)}\n`);
		expect(record).toEqual({
			id: "boss-msg-1",
			timestamp: "2026-07-07T08:00:00.000Z",
			sessionId: "session-123",
			from: "WorkerA",
			kind: "question",
			message: "Should I retry this migration?",
		});

		expect(readSessionBossInboxFile(sessionPath)).toEqual([record]);
	});

	it("reads every persisted boss inbox record in append order", () => {
		const sessionPath = sessionFile("multi-record");
		const first = appendSessionBossInboxMessage(sessionPath, {
			id: "boss-msg-1",
			now: new Date("2026-07-07T08:00:00.000Z"),
			sessionId: "session-123",
			from: "WorkerA",
			kind: "status",
			message: "First update",
		});
		const second = appendSessionBossInboxMessage(sessionPath, {
			id: "boss-msg-2",
			now: new Date("2026-07-07T08:01:00.000Z"),
			sessionId: "session-123",
			from: "WorkerA",
			kind: "finding",
			message: "Second update",
		});

		expect(readSessionBossInboxFile(sessionPath)).toEqual([first, second]);
	});
});

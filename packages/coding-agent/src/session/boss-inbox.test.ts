import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendSessionBossInboxMessage,
	readSessionBossInboxFile,
	readSessionBossInboxFileFromOffset,
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

describe("session boss inbox", () => {
	it("appends the exact JSONL shape consumed by the GLaDOS inbox reader", async () => {
		const sessionFile = path.join(tmp, "worker.jsonl");
		const record = await appendSessionBossInboxMessage(sessionFile, {
			id: "boss-msg-1",
			now: new Date("2026-07-15T11:00:00.000Z"),
			sessionId: " child-session ",
			from: " ChildWorker ",
			kind: "finding",
			message: "  Found the failing edge  ",
		});
		const inboxFile = sessionBossInboxFileForSessionFile(sessionFile);

		expect(path.basename(inboxFile)).toBe(SESSION_BOSS_INBOX_FILE_NAME);
		expect(path.dirname(inboxFile)).toBe(path.dirname(sessionSteeringFileForSessionFile(sessionFile)));
		expect(await Bun.file(inboxFile).text()).toBe(`${JSON.stringify(record)}\n`);
		expect(record).toEqual({
			id: "boss-msg-1",
			timestamp: "2026-07-15T11:00:00.000Z",
			sessionId: "child-session",
			from: "ChildWorker",
			kind: "finding",
			message: "Found the failing edge",
		});
	});

	it("reads child-process appends once from a byte offset and replays safely", async () => {
		const sessionFile = path.join(tmp, "worker.jsonl");
		const fixture = path.join(import.meta.dir, "../../test/fixtures/append-boss-inbox.ts");
		for (const [id, message] of [
			["boss-msg-1", "first update"],
			["boss-msg-2", "second update"],
		] as const) {
			const child = Bun.spawn([process.execPath, fixture, sessionFile, id, message], {
				stdout: "ignore",
				stderr: "pipe",
			});
			const exitCode = await child.exited;
			if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
			if (id === "boss-msg-1") {
				const first = await readSessionBossInboxFileFromOffset(sessionFile);
				expect(first.records.map(record => record.id)).toEqual(["boss-msg-1"]);
				const replay = await readSessionBossInboxFileFromOffset(sessionFile, first.nextOffset);
				expect(replay).toEqual({ records: [], nextOffset: first.nextOffset });
			}
		}

		const initial = await readSessionBossInboxFileFromOffset(sessionFile);
		const firstOnly = await readSessionBossInboxFileFromOffset(sessionFile, 0);
		const firstBytes = Buffer.byteLength(`${JSON.stringify(firstOnly.records[0])}\n`);
		const secondOnly = await readSessionBossInboxFileFromOffset(sessionFile, firstBytes);
		expect(initial.records.map(record => record.id)).toEqual(["boss-msg-1", "boss-msg-2"]);
		expect(secondOnly.records.map(record => record.id)).toEqual(["boss-msg-2"]);
		expect(await readSessionBossInboxFile(sessionFile)).toEqual(initial.records);
	});
});

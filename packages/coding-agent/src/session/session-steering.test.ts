import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	drainSessionSteeringFile,
	readSessionSteeringOffset,
	SessionSteeringWatcher,
	sessionSteeringFileForSessionFile,
	sessionSteeringOffsetFileForSessionFile,
	writeSessionSteeringOffset,
} from "./session-steering";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-steering-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function sessionFile(name: string): string {
	return path.join(tmp, `${name}.jsonl`);
}

function jsonl(message: string): string {
	return `${JSON.stringify({ message })}\n`;
}

async function writeSteering(sessionPath: string, content: string): Promise<void> {
	const steeringFile = sessionSteeringFileForSessionFile(sessionPath);
	await fs.mkdir(path.dirname(steeringFile), { recursive: true });
	await fs.writeFile(steeringFile, content);
}

async function appendSteering(sessionPath: string, content: string): Promise<void> {
	const steeringFile = sessionSteeringFileForSessionFile(sessionPath);
	await fs.mkdir(path.dirname(steeringFile), { recursive: true });
	await fs.appendFile(steeringFile, content);
}

describe("session steering drain", () => {
	it("drains complete records from an existing steering file and persisted offsets prevent duplicate delivery", async () => {
		const sessionPath = sessionFile("existing");
		const content = jsonl("first") + jsonl("two 🥧");
		await writeSteering(sessionPath, content);

		const firstDrain = drainSessionSteeringFile(sessionPath);

		expect(firstDrain.records.map(record => record.message)).toEqual(["first", "two 🥧"]);
		expect(firstDrain.offset).toBe(Buffer.byteLength(content));

		writeSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(sessionPath), firstDrain.offset);
		const secondDrain = drainSessionSteeringFile(sessionPath);

		expect(secondDrain.records).toEqual([]);
		expect(secondDrain.offset).toBe(firstDrain.offset);
	});

	it("leaves an incomplete trailing JSONL record unread until the newline arrives", async () => {
		const sessionPath = sessionFile("partial");
		const complete = jsonl("ready");
		const partial = '{"message":"later';
		await writeSteering(sessionPath, complete + partial);

		const firstDrain = drainSessionSteeringFile(sessionPath);

		expect(firstDrain.records.map(record => record.message)).toEqual(["ready"]);
		expect(firstDrain.offset).toBe(Buffer.byteLength(complete));

		writeSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(sessionPath), firstDrain.offset);
		await appendSteering(sessionPath, '"}\n');
		const completed = `${complete + partial}"}\n`;
		const secondDrain = drainSessionSteeringFile(sessionPath);

		expect(secondDrain.records.map(record => record.message)).toEqual(["later"]);
		expect(secondDrain.records[0]?.offset).toBe(Buffer.byteLength(complete));
		expect(secondDrain.offset).toBe(Buffer.byteLength(completed));
	});

	it("skips blank and whitespace-only messages while advancing past their complete lines", async () => {
		const sessionPath = sessionFile("blank-messages");
		const content = `\n${jsonl("")}${jsonl(" \t ")}${jsonl(" keep ")}`;
		await writeSteering(sessionPath, content);

		const result = drainSessionSteeringFile(sessionPath);

		expect(result.records.map(record => record.message)).toEqual(["keep"]);
		expect(result.offset).toBe(Buffer.byteLength(content));
	});

	it("throws on malformed complete JSONL without changing the persisted offset", async () => {
		const sessionPath = sessionFile("malformed");
		const offsetFile = sessionSteeringOffsetFileForSessionFile(sessionPath);
		await writeSteering(sessionPath, "not-json\n");
		writeSessionSteeringOffset(offsetFile, 0);

		expect(() => drainSessionSteeringFile(sessionPath)).toThrow();
		expect(readSessionSteeringOffset(offsetFile)).toBe(0);
	});
});

describe("session steering triggerTurn", () => {
	it("parses the optional triggerTurn flag and defaults it to false", async () => {
		const sessionPath = sessionFile("trigger-turn");
		const content = `${JSON.stringify({ message: "wake up", triggerTurn: true })}\n${jsonl("plain steer")}`;
		await writeSteering(sessionPath, content);

		const drain = drainSessionSteeringFile(sessionPath);

		expect(drain.records.map(record => [record.message, record.triggerTurn])).toEqual([
			["wake up", true],
			["plain steer", false],
		]);
	});
});

describe("SessionSteeringWatcher", () => {
	it("delivers startup records and persists the offset only after onRecords resolves", async () => {
		const sessionPath = sessionFile("watcher-startup");
		const content = jsonl("steer now");
		await writeSteering(sessionPath, content);
		let releaseDelivery!: () => void;
		const deliveryGate = new Promise<void>(resolve => {
			releaseDelivery = resolve;
		});
		let watcher!: SessionSteeringWatcher;
		const delivered = new Promise<string[]>(resolve => {
			watcher = new SessionSteeringWatcher({
				sessionFile: sessionPath,
				onRecords: async records => {
					resolve(records.map(record => record.message));
					await deliveryGate;
				},
			});
		});

		try {
			watcher.start();

			expect(await delivered).toEqual(["steer now"]);
			expect(readSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(sessionPath))).toBe(0);

			releaseDelivery();
			await watcher.flush();

			expect(readSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(sessionPath))).toBe(
				Buffer.byteLength(content),
			);
		} finally {
			watcher.dispose();
		}
	});

	it("drains appended records when explicitly polled at a turn boundary", async () => {
		const sessionPath = sessionFile("watcher-boundary");
		const seen: string[] = [];
		const watcher = new SessionSteeringWatcher({
			sessionFile: sessionPath,
			onRecords: records => {
				seen.push(...records.map(record => record.message));
			},
		});

		try {
			watcher.start();
			await watcher.flush();
			await appendSteering(sessionPath, jsonl("between turns"));

			await watcher.drain();

			expect(seen).toEqual(["between turns"]);
			expect(readSessionSteeringOffset(sessionSteeringOffsetFileForSessionFile(sessionPath))).toBe(
				Buffer.byteLength(jsonl("between turns")),
			);
		} finally {
			watcher.dispose();
		}
	});
});

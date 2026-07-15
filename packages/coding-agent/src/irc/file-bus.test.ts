import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ensureIrcAgent, readIrcInbox, registerIrcAgent, sendIrcMessage, watchIrcInbox } from "./file-bus.js";

let sharedDirectory = "";

beforeEach(async () => {
	sharedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-irc-"));
});

afterEach(async () => {
	await fs.rm(sharedDirectory, { recursive: true, force: true });
});

describe("file-backed IRC", () => {
	it("registers a generation and rejects id collisions and traversal", async () => {
		const registration = await registerIrcAgent(sharedDirectory, "advisor-1", "generation-a");
		expect(registration).toMatchObject({ id: "advisor-1", generation: "generation-a" });
		await expect(registerIrcAgent(sharedDirectory, "advisor-1", "generation-b")).rejects.toThrow("collision");
		await expect(registerIrcAgent(sharedDirectory, "../advisor", "generation-c")).rejects.toThrow("must match");
		await expect(watchIrcInbox(sharedDirectory, "advisor-1", { generation: "generation-b" }).next()).rejects.toThrow(
			"another generation",
		);
	});

	it("persists the complete envelope and correlates replies", async () => {
		await registerIrcAgent(sharedDirectory, "advisor-1", "advisor-generation");
		await registerIrcAgent(sharedDirectory, "builder-1", "builder-generation");
		const sent = await sendIrcMessage({
			sharedDirectory,
			from: "builder-1",
			fromGeneration: "builder-generation",
			to: "advisor-1",
			body: "Review the boundary",
			replyTo: "request-1",
			messageId: "message-1",
			now: new Date("2026-07-15T12:00:00.000Z"),
		});
		expect(sent).toEqual({
			message_id: "message-1",
			from: "builder-1",
			from_generation: "builder-generation",
			to: "advisor-1",
			reply_to: "request-1",
			created_at: "2026-07-15T12:00:00.000Z",
			body: "Review the boundary",
		});
		expect((await readIrcInbox(sharedDirectory, "advisor-1")).events).toEqual([{ cursor: 1, envelope: sent }]);
	});
	it("keeps concurrent sends as complete JSONL envelopes", async () => {
		await registerIrcAgent(sharedDirectory, "advisor-1", "advisor-generation");
		await registerIrcAgent(sharedDirectory, "builder-1", "builder-generation");
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				sendIrcMessage({
					sharedDirectory,
					from: "builder-1",
					fromGeneration: "builder-generation",
					to: "advisor-1",
					body: `message-${index}`,
					messageId: `message-${index}`,
				}),
			),
		);
		const result = await readIrcInbox(sharedDirectory, "advisor-1");
		expect(result.events).toHaveLength(8);
		expect(new Set(result.events.map(event => event.envelope.message_id))).toEqual(
			new Set(Array.from({ length: 8 }, (_, index) => `message-${index}`)),
		);
	});

	it("replays before following and does not lose a message in the watch gap", async () => {
		await registerIrcAgent(sharedDirectory, "advisor-1", "advisor-generation");
		await registerIrcAgent(sharedDirectory, "builder-1", "builder-generation");
		await sendIrcMessage({
			sharedDirectory,
			from: "builder-1",
			fromGeneration: "builder-generation",
			to: "advisor-1",
			body: "replay me",
			messageId: "message-1",
		});

		const watcher = watchIrcInbox(sharedDirectory, "advisor-1", { generation: "advisor-generation" });
		const first = await watcher.next();
		expect(first.value?.envelope.body).toBe("replay me");

		await sendIrcMessage({
			sharedDirectory,
			from: "builder-1",
			fromGeneration: "builder-generation",
			to: "advisor-1",
			body: "follow me",
			messageId: "message-2",
		});
		const second = await watcher.next();
		expect(second.value).toMatchObject({ cursor: 2, envelope: { message_id: "message-2" } });
		await watcher.return(undefined);
	});

	it("allows an existing registration only for the same generation", async () => {
		await expect(ensureIrcAgent(sharedDirectory, "builder-1", "generation-a")).resolves.toMatchObject({
			generation: "generation-a",
		});
		await expect(ensureIrcAgent(sharedDirectory, "builder-1", "generation-a")).resolves.toMatchObject({
			generation: "generation-a",
		});
		await expect(ensureIrcAgent(sharedDirectory, "builder-1", "generation-b")).rejects.toThrow("collision");
	});
});

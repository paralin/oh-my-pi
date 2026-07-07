import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../config/settings";
import type { AgentRegistry } from "../../registry/agent-registry";
import type { BossInboxRecord } from "../../session/boss-inbox";
import {
	appendSessionBossInboxMessage,
	readSessionBossInboxFile,
	sessionBossInboxFileForSessionFile,
} from "../../session/boss-inbox";
import type { ToolSession } from "..";
import { IrcTool } from "../irc";

const throwingPeerRegistry = {
	get() {
		throw new Error("boss inbox send must not look up registry peers");
	},
	list() {
		throw new Error("boss inbox send must not list registry peers");
	},
	listVisibleTo() {
		throw new Error("boss inbox send must not enumerate registry peers");
	},
} as unknown as AgentRegistry;

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		agentRegistry: throwingPeerRegistry,
		getAgentId: () => "WorkerA",
		...overrides,
	};
}

describe("IrcTool boss inbox send", () => {
	it("returns a clean error and does not append when the boss inbox is disabled", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-irc-boss-disabled-"));
		try {
			const sessionPath = path.join(tmp, "worker-session.jsonl");
			let appendCalls = 0;
			const tool = new IrcTool(
				makeSession({
					bossInboxEnabled: false,
					appendBossInboxMessage: ({ kind, message }) => {
						appendCalls += 1;
						return appendSessionBossInboxMessage(sessionPath, {
							id: `unexpected-${appendCalls}`,
							now: new Date("2026-07-07T08:00:00.000Z"),
							sessionId: "session-123",
							from: "WorkerA",
							kind,
							message,
						});
					},
				}),
			);

			const result = await tool.execute("irc-disabled", {
				op: "send",
				to: "boss",
				kind: "question",
				message: "Need a decision",
			});

			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: "Boss inbox is disabled for this session. Start the worker with --boss-inbox to enable it.",
				},
			]);
			expect(result.details).toEqual({ op: "send", from: "WorkerA", to: "boss" });
			expect(appendCalls).toBe(0);
			expect(readSessionBossInboxFile(sessionPath)).toEqual([]);
			expect(fs.existsSync(sessionBossInboxFileForSessionFile(sessionPath))).toBe(false);
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it("queues enabled boss sends through ToolSession without requiring a registry peer", async () => {
		const appended: Array<{ kind: string; message: string }> = [];
		const persistedRecord: BossInboxRecord = {
			id: "boss-msg-queued",
			timestamp: "2026-07-07T08:00:00.000Z",
			sessionId: "session-123",
			from: "WorkerA",
			kind: "finding",
			message: "Found the bad migration",
		};
		const tool = new IrcTool(
			makeSession({
				bossInboxEnabled: true,
				appendBossInboxMessage: message => {
					appended.push(message);
					return persistedRecord;
				},
			}),
		);

		const result = await tool.execute("irc-enabled", {
			op: "send",
			to: "boss",
			kind: "finding",
			message: "  Found the bad migration  ",
			await: true,
		});

		expect(appended).toEqual([{ kind: "finding", message: "Found the bad migration" }]);
		expect(result.isError).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Queued finding for boss inbox (boss-msg-queued). Keep working; replies arrive through normal steering.",
			},
		]);
		expect(result.details).toEqual({
			op: "send",
			from: "WorkerA",
			to: "boss",
			receipts: [{ to: "boss", outcome: "injected" }],
			bossInbox: persistedRecord,
		});
	});
});

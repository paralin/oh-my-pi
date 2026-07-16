import { describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import type { AgentRegistry } from "../../registry/agent-registry";
import type { BossInboxRecord } from "../../session/boss-inbox";
import type { ToolSession } from "..";
import { HubTool } from ".";

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

describe("Hub boss inbox send", () => {
	it("rejects boss delivery when --boss-inbox is disabled", async () => {
		let appendCalls = 0;
		const tool = new HubTool(
			makeSession({
				bossInboxEnabled: false,
				appendBossInboxMessage: async () => {
					appendCalls += 1;
					throw new Error("disabled inbox must not append");
				},
			}),
		);

		const result = await tool.execute("hub-disabled", {
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
		expect(appendCalls).toBe(0);
	});

	it("queues boss delivery without resolving an in-process peer", async () => {
		const appended: Array<{ kind: string; message: string }> = [];
		const persistedRecord: BossInboxRecord = {
			id: "boss-msg-queued",
			timestamp: "2026-07-15T12:00:00.000Z",
			sessionId: "session-123",
			from: "WorkerA",
			kind: "finding",
			message: "Found the bad migration",
		};
		const tool = new HubTool(
			makeSession({
				bossInboxEnabled: true,
				appendBossInboxMessage: async message => {
					appended.push(message);
					return persistedRecord;
				},
			}),
		);

		const result = await tool.execute("hub-enabled", {
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

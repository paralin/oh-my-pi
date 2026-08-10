import { describe, expect, it } from "bun:test";
import type { Usage } from "@oh-my-pi/pi-ai";
import { actUsageDelta, truncateActEventText } from "@oh-my-pi/pi-coding-agent/session/act-events";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("durable Act events", () => {
	it("truncates event text at the wire bounds", () => {
		expect(truncateActEventText("x".repeat(16_385), 16_384)).toEqual({ text: "x".repeat(16_384), truncated: true });
		expect(truncateActEventText("ok", 16_384)).toEqual({ text: "ok", truncated: false });
	});
	it("persists a start and terminal without an Act return value", () => {
		const usage: Usage = {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const manager = SessionManager.inMemory("/tmp");
		manager.appendActStart("act-1", usage, "provider/model");
		expect(manager.getUnmatchedActStarts()).toHaveLength(1);
		manager.appendActTerminal("act-1", "done", usage, {
			model: { provider: "provider", id: "model" },
			sessionKey: "provider/model",
		});
		expect(manager.getUnmatchedActStarts()).toEqual([]);
		const terminal = manager.getBranch().find(entry => entry.type === "act_terminal");
		expect(terminal).toMatchObject({
			actId: "act-1",
			status: "done",
			usage,
			model: { provider: "provider", id: "model" },
		});
		expect(JSON.stringify(terminal)).not.toContain("returnValue");
	});

	it("computes a non-mutating usage delta", () => {
		const baseline: Usage = {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const current: Usage = { ...baseline, input: 8, output: 4, totalTokens: 12 };
		expect(actUsageDelta(baseline, current)).toMatchObject({ input: 6, output: 1, totalTokens: 7 });
		expect(baseline.input).toBe(2);
	});
});

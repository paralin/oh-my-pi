import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcHarnessSessionOwner } from "./rpc-harness";

let tmp = "";

beforeEach(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-harness-"));
});

afterEach(async () => {
	await fs.rm(tmp, { recursive: true, force: true });
});

function recordFile(sessionId = "session"): string {
	return path.join(tmp, sessionId, "rpc.jsonl");
}

function runIndexFile(): string {
	return path.join(tmp, "rpc-runs.jsonl");
}

function usage() {
	return { input: 10, output: 4, reasoning: 1, cacheRead: 2, cacheWrite: 3, total: 14 };
}

describe("RPC harness session owner", () => {
	it("assigns monotonic event sequences and replays durable events", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		const first = await owner.appendEvent({ type: "notice", level: "info", message: "first" });
		const second = await owner.appendEvent({ type: "notice", level: "info", message: "second" });
		expect([first.sequence, second.sequence]).toEqual([1, 2]);

		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		const replay = await reopened.replay(first.sequence);
		expect(replay.map(event => [event.sequence, "message" in event ? event.message : ""])).toEqual([[2, "second"]]);
	});

	it("returns the same immutable terminal result on every call", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		const result = await owner.completeResult({
			outcome: "completed",
			stopReason: "finished",
			finalMessage: "done",
			usage: usage(),
		});
		const repeated = await owner.waitResult();
		expect(repeated).toBe(result);
		expect(repeated.resultId).toBe("session-1:result");
		expect(repeated.terminalSequence).toBe(1);
		expect(Object.isFrozen(repeated)).toBe(true);
		const reopened = await RpcHarnessSessionOwner.open("session-1", recordFile());
		expect(await reopened.waitResult()).toEqual(result);
		expect(await reopened.replay()).toMatchObject([
			{ type: "session_terminal", terminalSequence: 1, resultId: "session-1:result" },
		]);
	});

	it("rejects conflicting run IDs and repeats the same binding idempotently", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile("session-1"), undefined, runIndexFile());
		expect(await owner.bindRun("run-1")).toEqual({ runId: "run-1", sessionId: "session-1", existing: false });
		expect(await owner.bindRun("run-1")).toEqual({ runId: "run-1", sessionId: "session-1", existing: true });

		const otherSession = await RpcHarnessSessionOwner.open(
			"session-2",
			recordFile("session-2"),
			undefined,
			runIndexFile(),
		);
		await expect(otherSession.bindRun("run-1")).rejects.toThrow("bound to session session-1");
	});

	it("retries rejected steering after reopening and redelivers it", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		let deliveries = 0;
		await expect(
			owner.steer("steer-1", "hello", async () => {
				deliveries++;
				throw new Error("unsafe boundary");
			}),
		).resolves.toEqual({ status: "REJECTED", steeringSequence: 1 });
		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		await expect(
			reopened.steer("steer-1", "hello", async () => {
				deliveries++;
			}),
		).resolves.toEqual({ status: "ACCEPTED", steeringSequence: 1 });
		expect(deliveries).toBe(2);
	});

	it("seals the event sequence after the terminal result", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		await owner.completeResult({
			outcome: "completed",
			stopReason: "stop",
			finalMessage: "done",
			usage: usage(),
		});
		await expect(owner.appendEvent({ type: "notice", level: "info", message: "late" })).rejects.toThrow(
			"after the terminal result",
		);
	});

	it("claims a run ID across independently opened owners", async () => {
		const first = await RpcHarnessSessionOwner.open("session-1", recordFile("session-1"), undefined, runIndexFile());
		const second = await RpcHarnessSessionOwner.open("session-2", recordFile("session-2"), undefined, runIndexFile());
		const results = await Promise.allSettled([first.bindRun("run-1"), second.bindRun("run-1")]);
		expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
	});

	it("acknowledges steering once and reports duplicate retries", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		let deliveries = 0;
		const deliver = async () => {
			deliveries++;
		};
		await expect(owner.steer("steer-1", "hello", deliver)).resolves.toEqual({
			status: "ACCEPTED",
			steeringSequence: 1,
		});
		await expect(owner.steer("steer-1", "hello", deliver)).resolves.toEqual({
			status: "DUPLICATE",
			steeringSequence: 1,
		});
		expect(deliveries).toBe(1);
		expect((await owner.replay()).map(event => String(event.type))).toEqual(["steering_queued", "steering_injected"]);
	});
});

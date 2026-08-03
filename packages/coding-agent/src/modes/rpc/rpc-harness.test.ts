import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type RpcHarnessPublishedEvent,
	type RpcHarnessResult,
	RpcHarnessSessionOwner,
	rpcHarnessRecordFileForSessionFile,
} from "./rpc-harness";

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

async function claimRunInChild(
	sessionId: string,
	recordFilePath: string,
	runIndexPath: string,
	runId = "run-1",
): Promise<{
	ok: boolean;
	existing?: boolean;
	sessionId?: string;
	error?: string;
}> {
	const child = Bun.spawn(["bun", path.join(import.meta.dir, "rpc-harness-claim-child.ts")], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			RPC_SESSION_ID: sessionId,
			RPC_RECORD_FILE: recordFilePath,
			RPC_RUN_INDEX_FILE: runIndexPath,
			RPC_RUN_ID: runId,
		},
	});
	const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`run claim child exited with ${exitCode}`);
	return JSON.parse(output.trim()) as {
		ok: boolean;
		existing?: boolean;
		sessionId?: string;
		error?: string;
	};
}

describe("RPC harness session owner", () => {
	it("derives the record path from the transcript path", () => {
		expect(rpcHarnessRecordFileForSessionFile(path.join(tmp, "20260101-120000_abc.jsonl"))).toBe(
			path.join(tmp, "20260101-120000_abc", "rpc.jsonl"),
		);
		expect(rpcHarnessRecordFileForSessionFile(path.join(tmp, "transcript"))).toBe(
			path.join(tmp, "transcript.d", "rpc.jsonl"),
		);
	});

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

	it("persists a safe event while publishing its display form", async () => {
		const published: object[] = [];
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile(), event => published.push(event));
		await owner.appendEvent(
			{ type: "notice", level: "info", message: "$$HASH$$" },
			{ type: "notice", level: "info", message: "display secret" },
		);

		expect(await owner.replay()).toMatchObject([{ sequence: 1, message: "$$HASH$$" }]);
		expect(published).toMatchObject([{ sequence: 1, message: "display secret" }]);
	});

	it("restores display values when reopening durable events", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		await owner.appendEvent({ type: "notice", level: "info", message: "$$HASH$$" });
		await owner.dispose();

		const reopened = await RpcHarnessSessionOwner.open("session-1", file, undefined, undefined, {
			displayEvent: event =>
				event.type === "notice"
					? { ...event, message: event.message.replace("$$HASH$$", "display secret") }
					: event,
		});
		expect(await reopened.replay()).toMatchObject([{ sequence: 1, message: "display secret" }]);
		expect(await reopened.replayPersisted()).toMatchObject([{ sequence: 1, message: "$$HASH$$" }]);
		expect(await Bun.file(file).text()).toContain("$$HASH$$");
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

	it("keeps terminal secrets obfuscated on disk while returning display text", async () => {
		const file = recordFile();
		const displayResult = (result: RpcHarnessResult) => ({
			...result,
			finalMessage: result.finalMessage.replace("$$HASH$$", "display secret"),
		});
		const owner = await RpcHarnessSessionOwner.open("session-1", file, undefined, undefined, { displayResult });
		await owner.completeResult({
			outcome: "completed",
			stopReason: "finished",
			finalMessage: "$$HASH$$",
			usage: usage(),
		});
		expect((await owner.waitResult()).finalMessage).toBe("display secret");
		expect(await fs.readFile(file, "utf8")).not.toContain("display secret");

		const reopened = await RpcHarnessSessionOwner.open("session-1", file, undefined, undefined, { displayResult });
		expect((await reopened.waitResult()).finalMessage).toBe("display secret");
		const replayedTerminal = (await reopened.replay()).find(event => event.type === "session_terminal");
		expect(replayedTerminal?.finalMessage).toBe("display secret");
	});

	it("rejects result waiters when ledger persistence fails", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		const result = owner.waitResult();
		const observedResult = result.then(
			() => undefined,
			error => error,
		);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.rm(path.dirname(file), { recursive: true });
		await fs.writeFile(path.dirname(file), "blocks directory creation");

		await expect(owner.appendEvent({ type: "notice", level: "info", message: "fail" })).rejects.toThrow();
		expect(await observedResult).toBeInstanceOf(Error);
		await expect(owner.waitResult()).rejects.toThrow();
	});

	it("stores terminal state in one recoverable record", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		await owner.completeResult({
			outcome: "completed",
			stopReason: "finished",
			finalMessage: "done",
			usage: usage(),
		});
		const records: unknown[] = (await fs.readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ kind: "terminal" });
		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		expect(reopened.hasResult).toBe(true);
		expect(await reopened.replay()).toHaveLength(1);
	});

	it("recovers preceding records when the final record is torn", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		await owner.appendEvent({ type: "notice", level: "info", message: "kept" });
		await fs.appendFile(file, '{"kind":"event"');

		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		expect(await reopened.replay()).toMatchObject([{ type: "notice", message: "kept" }]);
		await reopened.appendEvent({ type: "notice", level: "info", message: "after repair" });

		const repaired = await RpcHarnessSessionOwner.open("session-1", file);
		expect((await repaired.replay()).map(event => event.type)).toEqual(["notice", "notice"]);
	});

	it("normalizes a valid unterminated record before appending", async () => {
		const file = recordFile();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			JSON.stringify({
				kind: "event",
				event: { type: "notice", level: "info", message: "kept", sequence: 1 },
			}),
		);

		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		await reopened.appendEvent({ type: "notice", level: "info", message: "after repair" });

		const repaired = await RpcHarnessSessionOwner.open("session-1", file);
		expect((await repaired.replay()).map(event => ("message" in event ? event.message : ""))).toEqual([
			"kept",
			"after repair",
		]);
	});

	it("bounds replay pages and exposes the latest sequence", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		await owner.appendEvent({ type: "notice", level: "info", message: "first" });
		await owner.appendEvent({ type: "notice", level: "info", message: "second" });
		expect(await owner.replay(0, 1)).toHaveLength(1);
		expect(owner.latestSequence).toBe(2);
		await expect(owner.replay(0, 1_001)).rejects.toThrow("limit must be an integer from 1 to 1000");
	});

	it("rejects conflicting run IDs and repeats the same binding idempotently", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile("session-1"), undefined, runIndexFile());
		expect(await owner.bindRun("run-1")).toEqual({ runId: "run-1", sessionId: "session-1", existing: false });
		expect(await owner.bindRun("run-1")).toEqual({ runId: "run-1", sessionId: "session-1", existing: true });
		await expect(owner.bindRun("run-2")).rejects.toThrow("already bound to run_id run-1");

		const otherSession = await RpcHarnessSessionOwner.open(
			"session-2",
			recordFile("session-2"),
			undefined,
			runIndexFile(),
		);
		await expect(otherSession.bindRun("run-1")).rejects.toThrow("bound to session session-1");
		const reopened = await RpcHarnessSessionOwner.open(
			"session-1",
			recordFile("session-1"),
			undefined,
			runIndexFile(),
		);
		await expect(reopened.bindRun("run-2")).rejects.toThrow("already bound to run_id run-1");
		await Promise.all([owner.dispose(), otherSession.dispose(), reopened.dispose()]);
	});

	it("repairs a local run record after only the durable claim was published", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const claimFile = path.join(`${index}.locks`, Bun.SHA256.hash("run-1", "hex"));
		await fs.mkdir(path.dirname(claimFile), { recursive: true });
		await fs.writeFile(claimFile, "session-1");
		const owner = await RpcHarnessSessionOwner.open("session-1", file, undefined, index);
		await owner.bindRun("run-1");
		await owner.dispose();

		expect(await Bun.file(file).text()).toContain('"runId":"run-1"');
		const reopened = await RpcHarnessSessionOwner.open("session-1", file, undefined, index);
		await expect(reopened.bindRun("run-2")).rejects.toThrow("already bound to run_id run-1");
		await reopened.dispose();
	});

	it("rejects a second live owner and allows takeover after release", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const first = await RpcHarnessSessionOwner.open("session-1", file, undefined, index);
		const second = await RpcHarnessSessionOwner.open("session-1", file, undefined, index);
		await first.bindRun("run-1");

		await expect(second.bindRun("run-1")).rejects.toThrow("already has a live owner");
		await first.dispose();
		await expect(second.bindRun("run-1")).resolves.toEqual({
			runId: "run-1",
			sessionId: "session-1",
			existing: true,
		});
		await second.dispose();
	});

	it("rejects live custody before repairing a torn ledger tail", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const first = await RpcHarnessSessionOwner.open("session-1", file, undefined, index, {
			acquireSessionLease: true,
		});
		await first.bindRun("run-1");
		await fs.appendFile(file, '{"kind":"event"');

		await expect(
			RpcHarnessSessionOwner.open("session-1", file, undefined, index, { acquireSessionLease: true }),
		).rejects.toThrow("live owner");
		expect(await fs.readFile(file, "utf8")).toEndWith('{"kind":"event"');
		await first.dispose();
	});

	it("redelivers accepted steering that was not injected before reopen", async () => {
		const file = recordFile();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			`${[
				JSON.stringify({ kind: "steering", steeringId: "steer-1", steeringSequence: 1, status: "ACCEPTED" }),
				JSON.stringify({
					kind: "event",
					event: {
						type: "steering_queued",
						steeringId: "steer-1",
						steeringSequence: 1,
						message: "hello",
						sequence: 1,
					},
				}),
			].join("\n")}\n`,
		);
		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		let deliveries = 0;
		await expect(
			reopened.steer("steer-1", "hello", async () => {
				deliveries++;
			}),
		).resolves.toEqual({ status: "ACCEPTED", steeringSequence: 1 });
		expect(deliveries).toBe(1);
	});

	it("repairs an accepted steering record missing its queued event", async () => {
		const file = recordFile();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			`${JSON.stringify({
				kind: "steering",
				steeringId: "steer-1",
				steeringSequence: 1,
				status: "ACCEPTED",
				message: "hello",
			})}\n`,
		);

		const reopened = await RpcHarnessSessionOwner.open("session-1", file);
		expect((await reopened.replay()).map(event => event.type)).toEqual(["steering_queued"]);
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

	it("latches a failed rejected-steering append", async () => {
		const file = recordFile();
		const owner = await RpcHarnessSessionOwner.open("session-1", file);
		const result = owner.waitResult().then(
			() => undefined,
			error => error,
		);
		await owner.appendEvent({ type: "notice", level: "info", message: "initialize" });
		await fs.chmod(file, 0o400);

		await expect(
			owner.steer("steer-1", "hello", async () => {
				throw new Error("delivery failed");
			}),
		).rejects.toThrow();
		expect(await result).toBeInstanceOf(Error);
		await expect(owner.appendEvent({ type: "notice", level: "info", message: "late" })).rejects.toThrow();
	});

	it("reopens the terminal boundary when accepted work starts a continuation", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		owner.beginResultSeal();
		expect(() => owner.assertAcceptingWork()).toThrow("run result is already sealed");

		owner.cancelResultSeal();

		expect(() => owner.assertAcceptingWork()).not.toThrow();
	});

	it("seals the event sequence after the terminal result", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		const sealing = owner.completeResult({
			outcome: "completed",
			stopReason: "stop",
			finalMessage: "done",
			usage: usage(),
		});
		expect(() => owner.assertAcceptingWork()).toThrow("run result is already sealed");
		await sealing;
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

	it("claims a run ID atomically across separate processes", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const results = await Promise.all([
			claimRunInChild("session-1", file, index),
			claimRunInChild("session-2", recordFile("session-2"), index),
		]);
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok && result.error?.includes("bound to session"))).toHaveLength(1);
	});

	it("binds a long opaque run ID through fixed-length claim paths", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile("session-1"), undefined, runIndexFile());
		const runId = "opaque-".repeat(1_000);
		await expect(owner.bindRun(runId)).resolves.toMatchObject({ runId });
		await owner.dispose();
	});

	it("leases one session ledger across different run IDs", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const results = await Promise.all([
			claimRunInChild("session-1", file, index, "run-1"),
			claimRunInChild("session-1", file, index, "run-2"),
		]);
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok && result.error?.includes("session ledger"))).toHaveLength(1);
	});

	it("recovers an abandoned lease-reclaim directory", async () => {
		const file = recordFile("session-1");
		const leaseFile = `${file}.owner`;
		const reclaimLock = `${leaseFile}.reclaim`;
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(leaseFile, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
		await fs.mkdir(reclaimLock);
		const staleTime = new Date(Date.now() - 10_000);
		await fs.utimes(reclaimLock, staleTime, staleTime);

		const owner = await RpcHarnessSessionOwner.open("session-1", file, undefined, runIndexFile());
		await expect(owner.bindRun("run-1")).resolves.toMatchObject({ sessionId: "session-1" });
		await owner.dispose();
	});

	it("reclaims a malformed lease left by an interrupted legacy write", async () => {
		const file = recordFile("session-1");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(`${file}.owner`, '{"pid":');

		const owner = await RpcHarnessSessionOwner.open("session-1", file, undefined, runIndexFile());
		await expect(owner.bindRun("run-1")).resolves.toMatchObject({ sessionId: "session-1" });
		await owner.dispose();
	});

	it("reclaims a lease whose PID belongs to a different process birth", async () => {
		const file = recordFile("session-1");
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(`${file}.owner`, JSON.stringify({ pid: process.pid, birthId: "different", token: "stale" }));

		const owner = await RpcHarnessSessionOwner.open("session-1", file, undefined, runIndexFile());
		await expect(owner.bindRun("run-1")).resolves.toMatchObject({ sessionId: "session-1" });
		await owner.dispose();
	});

	it("serializes concurrent reclamation of a stale owner lease", async () => {
		const file = recordFile("session-1");
		const index = runIndexFile();
		const digest = Bun.SHA256.hash("run-1", "hex");
		const claimFile = path.join(`${index}.locks`, digest);
		await fs.mkdir(path.dirname(claimFile), { recursive: true });
		await fs.writeFile(claimFile, "session-1");
		await fs.writeFile(`${claimFile}.owner`, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));

		const results = await Promise.all([
			claimRunInChild("session-1", file, index),
			claimRunInChild("session-1", file, index),
		]);
		expect(results.filter(result => result.ok)).toHaveLength(1);
		expect(results.filter(result => !result.ok && result.error?.includes("live owner"))).toHaveLength(1);
	});

	it("coalesces cumulative message snapshots while publishing every live delta", async () => {
		const published: RpcHarnessPublishedEvent[] = [];
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile(), event => published.push(event));
		const updates = ["one", " two", " three"].map((delta, index) => ({
			type: "message_update" as const,
			message: { role: "assistant", content: [{ type: "text", text: ["one", "one two", "one two three"][index] }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
		}));
		const tasks = updates.map(async update => {
			const task = owner.appendEvent(update as never);
			await Promise.resolve();
			return task;
		});

		const replay = await owner.replay();
		await Promise.all(tasks);
		expect(replay).toHaveLength(1);
		expect(JSON.stringify(replay[0])).toContain("one two three");
		expect(
			published.map(event =>
				event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
					? event.assistantMessageEvent.delta
					: undefined,
			),
		).toEqual(["one", " two", " three"]);
		expect(published.map(event => event.sequence)).toEqual([undefined, undefined, 1]);
	});

	it("ends update coalescing at an intervening event", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		const first = owner.appendEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "first" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" },
		} as never);
		const boundary = owner.appendEvent({ type: "notice", level: "info", message: "boundary" });
		const second = owner.appendEvent({
			type: "message_update",
			message: { role: "assistant", content: [{ type: "text", text: "second" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second" },
		} as never);
		const replay = await owner.replay();
		await Promise.all([first, boundary, second]);
		expect(replay.map(event => event.type)).toEqual(["message_update", "notice", "message_update"]);
		expect(JSON.stringify(replay[0])).toContain("first");
		expect(JSON.stringify(replay[2])).toContain("second");
	});

	it("marks steering duplicate only after durable injection", async () => {
		const owner = await RpcHarnessSessionOwner.open("session-1", recordFile());
		let deliveries = 0;
		const deliver = async () => {
			deliveries++;
		};
		await expect(owner.steer("steer-1", "hello", deliver)).resolves.toEqual({
			status: "ACCEPTED",
			steeringSequence: 1,
		});
		await expect(owner.steer("steer-1", "changed", deliver)).rejects.toThrow(
			"payload does not match the original request",
		);
		await expect(owner.steer("steer-1", "hello", deliver, "different images")).rejects.toThrow(
			"payload does not match the original request",
		);
		expect(deliveries).toBe(1);
		await expect(owner.steer("steer-1", "hello", deliver)).resolves.toEqual({
			status: "ACCEPTED",
			steeringSequence: 1,
		});
		await owner.markSteeringInjected("steer-1");
		await expect(owner.steer("steer-1", "hello", deliver)).resolves.toEqual({
			status: "DUPLICATE",
			steeringSequence: 1,
		});
		expect(deliveries).toBe(2);
		expect((await owner.replay()).map(event => String(event.type))).toEqual(["steering_queued", "steering_injected"]);
	});
});

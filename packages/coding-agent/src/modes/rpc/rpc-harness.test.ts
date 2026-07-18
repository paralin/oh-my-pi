import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
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

async function claimRunInChild(
	sessionId: string,
	recordFilePath: string,
	runIndexPath: string,
): Promise<{
	ok: boolean;
	existing?: boolean;
	sessionId?: string;
	error?: string;
}> {
	const harnessModule = pathToFileURL(path.join(import.meta.dir, "rpc-harness.ts")).href;
	// The child is a separate Bun eval process, so it must dynamically load the
	// same owner module by file URL; a parent static import cannot cross the
	// process boundary.
	const script = `
		const { RpcHarnessSessionOwner } = await import(${JSON.stringify(harnessModule)});
		try {
			const owner = await RpcHarnessSessionOwner.open(
				process.env.RPC_SESSION_ID,
				process.env.RPC_RECORD_FILE,
				undefined,
				process.env.RPC_RUN_INDEX_FILE,
			);
			const result = await owner.bindRun("run-1");
			console.log(JSON.stringify({ ok: true, existing: result.existing, sessionId: result.sessionId }));
		} catch (error) {
			console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
		}
	`;
	const child = Bun.spawn(["bun", "-e", script], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			RPC_SESSION_ID: sessionId,
			RPC_RECORD_FILE: recordFilePath,
			RPC_RUN_INDEX_FILE: runIndexPath,
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

	it("redelivers accepted steering that was not injected before reopen", async () => {
		const file = recordFile();
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(
			file,
			[
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
			].join("\n") + "\n",
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

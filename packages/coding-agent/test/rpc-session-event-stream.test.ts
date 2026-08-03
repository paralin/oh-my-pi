import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcHarnessSessionOwner } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-harness";
import {
	deliverRpcSteeringIfNeeded,
	disposeRpcSessionWithCustody,
	RpcCustodyBindingGuard,
	type RpcSessionEventStreamDeps,
	RpcTerminalTaskTracker,
	streamRpcSessionEvent,
	summarizeRpcEpisode,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

function notice(message: string): AgentSessionEvent {
	return { type: "notice", level: "info", message };
}

function agentEnd(stopReason: string, isTerminal = true): AgentSessionEvent {
	return {
		type: "agent_end",
		messages: [{ role: "assistant", content: [], stopReason }],
		isTerminal,
	} as unknown as AgentSessionEvent;
}

function collect(overrides: Partial<RpcSessionEventStreamDeps> = {}) {
	const frames: object[] = [];
	const seals: Array<[string, string]> = [];
	const failures: Array<[string, unknown]> = [];
	const deps: RpcSessionEventStreamDeps = {
		ledger: () => undefined,
		output: frame => frames.push(frame),
		sealResult: async (stopReason, outcome) => {
			seals.push([stopReason, outcome]);
		},
		waitForMessagePersistence: async () => {},
		trackSteeringPersistence: () => {},
		onLedgerFailure: (command, error) => failures.push([command, error]),
		...overrides,
	};
	return { deps, frames, seals, failures };
}

describe("deliverRpcSteeringIfNeeded", () => {
	test("skips a steering delivery already present in the transcript", async () => {
		let deliveries = 0;

		await deliverRpcSteeringIfNeeded(true, async () => {
			deliveries++;
		});

		expect(deliveries).toBe(0);
	});

	test("delivers steering absent from the transcript", async () => {
		let deliveries = 0;

		await deliverRpcSteeringIfNeeded(false, async () => {
			deliveries++;
		});

		expect(deliveries).toBe(1);
	});
});

describe("RpcCustodyBindingGuard", () => {
	test("rejects extension work throughout asynchronous custody binding", async () => {
		const guard = new RpcCustodyBindingGuard();
		const release = Promise.withResolvers<void>();
		const binding = guard.run(() => release.promise);

		expect(() => guard.assertWorkAllowed()).toThrow("custody is binding");
		release.resolve();
		await binding;
		expect(() => guard.assertWorkAllowed()).not.toThrow();
	});
});

describe("RpcTerminalTaskTracker", () => {
	test("holds the terminal boundary until accepted steering delivery settles", async () => {
		const tracker = new RpcTerminalTaskTracker();
		const delivery = Promise.withResolvers<void>();
		tracker.track(delivery.promise);
		let sealed = false;
		const terminal = tracker.wait().then(() => {
			sealed = true;
		});

		await Promise.resolve();
		expect(sealed).toBe(false);

		delivery.resolve();
		await terminal;
		expect(sealed).toBe(true);
	});
});

describe("streamRpcSessionEvent", () => {
	test("writes events straight through and seals nothing while no run is bound", async () => {
		const { deps, frames, seals } = collect();

		streamRpcSessionEvent(notice("first"), deps);
		streamRpcSessionEvent(agentEnd("end_turn"), deps);
		streamRpcSessionEvent(notice("second"), deps);
		await Promise.resolve();

		expect(frames.map(frame => (frame as { type: string }).type)).toEqual(["notice", "agent_end", "notice"]);
		expect(frames.every(frame => !("sequence" in frame))).toBe(true);
		expect(seals).toEqual([]);
	});

	test("records and sequences events once a run is bound", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const recordFile = path.join(tmp, "session", "rpc.jsonl");
			const frames: object[] = [];
			const ledger = await RpcHarnessSessionOwner.open("session-1", recordFile, event => frames.push(event));
			const { deps, seals } = collect({ ledger: () => ledger, output: frame => frames.push(frame) });

			streamRpcSessionEvent(notice("first"), deps);
			streamRpcSessionEvent(agentEnd("error"), deps);
			await ledger.replay();
			await Promise.resolve();

			expect(frames.map(frame => (frame as { sequence?: number }).sequence)).toEqual([1, 2]);
			expect(seals).toEqual([["error", "failed"]]);
			expect(await Bun.file(recordFile).text()).toContain('"sequence":1');
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("records nonterminal agent_end without sealing the result", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(tmp, "session", "rpc.jsonl"));
			const { deps, seals } = collect({ ledger: () => ledger });

			streamRpcSessionEvent(agentEnd("end_turn", false), deps);
			await ledger.replay();

			expect(seals).toEqual([]);
			expect(ledger.hasResult).toBe(false);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("records steering injection only after message persistence", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(tmp, "session", "rpc.jsonl"));
			await ledger.steer("steer-1", "hello", async () => {});
			const persisted = Promise.withResolvers<void>();
			const { deps } = collect({
				ledger: () => ledger,
				waitForMessagePersistence: () => persisted.promise,
			});
			const event = {
				type: "message_end",
				message: { role: "user", content: "hello", timestamp: 0, idempotencyKey: "rpc:session-1:steer-1" },
			} as unknown as AgentSessionEvent;

			streamRpcSessionEvent(event, deps);
			await ledger.replay();
			expect((await ledger.replay()).map(item => item.type)).not.toContain("steering_injected");
			persisted.resolve();
			await Promise.resolve();
			await ledger.replay();
			expect((await ledger.replay()).map(item => item.type)).toContain("steering_injected");
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("waits for delayed steering persistence before sealing", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(tmp, "session", "rpc.jsonl"));
			await ledger.steer("steer-1", "hello", async () => {});
			const persisted = Promise.withResolvers<void>();
			const pending = new Set<Promise<void>>();
			const { deps } = collect({
				ledger: () => ledger,
				waitForMessagePersistence: () => persisted.promise,
				trackSteeringPersistence: task => pending.add(task),
				sealResult: async (stopReason, outcome) => {
					ledger.beginResultSeal();
					await Promise.all(pending);
					await ledger.completeResult({
						outcome,
						stopReason,
						finalMessage: "",
						usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					});
				},
			});
			const event = {
				type: "message_end",
				message: { role: "user", content: "hello", timestamp: 0, idempotencyKey: "rpc:session-1:steer-1" },
			} as unknown as AgentSessionEvent;

			streamRpcSessionEvent(event, deps);
			streamRpcSessionEvent(agentEnd("end_turn"), deps);
			await ledger.replay();
			expect(ledger.hasResult).toBe(false);
			expect(() => ledger.assertAcceptingWork()).toThrow("already sealed");

			persisted.resolve();
			await ledger.waitResult();
			expect((await ledger.replay()).map(item => item.type)).toEqual([
				"steering_queued",
				"message_end",
				"agent_end",
				"steering_injected",
				"session_terminal",
			]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("does not mark steering injected when transcript persistence fails", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(tmp, "session", "rpc.jsonl"));
			await ledger.steer("steer-1", "hello", async () => {});
			const { deps, failures } = collect({
				ledger: () => ledger,
				waitForMessagePersistence: async () => {
					throw new Error("transcript write failed");
				},
			});
			const event = {
				type: "message_end",
				message: { role: "user", content: "hello", timestamp: 0, idempotencyKey: "rpc:session-1:steer-1" },
			} as unknown as AgentSessionEvent;

			streamRpcSessionEvent(event, deps);
			await Promise.resolve();
			await ledger.replay();

			expect((await ledger.replay()).map(item => item.type)).not.toContain("steering_injected");
			expect(failures).toEqual([["session.steer", expect.any(Error)]]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
	test("falls back to the direct stream after the terminal result is sealed", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(tmp, "session", "rpc.jsonl"));
			await ledger.completeResult({
				outcome: "completed",
				stopReason: "end_turn",
				finalMessage: "done",
				usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
			});
			const { deps, frames, failures } = collect({ ledger: () => ledger });

			streamRpcSessionEvent(notice("after"), deps);
			await Promise.resolve();

			expect(frames).toEqual([notice("after")]);
			expect(failures).toEqual([]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	test("reports a failed append as session.watch", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-stream-"));
		try {
			const sidecar = path.join(tmp, "session");
			const ledger = await RpcHarnessSessionOwner.open("session-1", path.join(sidecar, "rpc.jsonl"));
			// Occupying the sidecar directory name with a regular file makes the
			// append fail the way a full or read-only disk would.
			await fs.writeFile(sidecar, "");
			const { deps, failures } = collect({ ledger: () => ledger });

			streamRpcSessionEvent(notice("first"), deps);
			await ledger.replay().catch(() => undefined);
			await Promise.resolve();

			expect(failures.map(([command]) => command)).toEqual(["session.watch"]);
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});

test("holds durable custody until session disposal finishes", async () => {
	const sessionDisposed = Promise.withResolvers<void>();
	const calls: string[] = [];
	const disposal = disposeRpcSessionWithCustody(
		{
			dispose: async () => {
				calls.push("session-start");
				await sessionDisposed.promise;
				calls.push("session-end");
			},
		},
		{
			dispose: async () => {
				calls.push("custody");
			},
		},
	);

	await Promise.resolve();
	expect(calls).toEqual(["session-start"]);
	sessionDisposed.resolve();
	await disposal;
	expect(calls).toEqual(["session-start", "session-end", "custody"]);
});

test("rebuilds result aggregates from durable message events", () => {
	const summary = summarizeRpcEpisode([
		{
			type: "message_end",
			sequence: 1,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "before crash" }],
				stopReason: "stop",
				usage: {
					input: 4,
					output: 3,
					cacheRead: 1,
					cacheWrite: 2,
					totalTokens: 10,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		} as never,
	]);

	expect(summary).toEqual({
		finalMessage: "before crash",
		usage: { input: 4, output: 3, reasoning: 0, cacheRead: 1, cacheWrite: 2, total: 10 },
	});
});

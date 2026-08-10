import { describe, expect, test } from "bun:test";
import {
	dispatchRpcInputFrame,
	finalizeRpcInputAfterEof,
	type PendingExtensionRequest,
	RpcInputDispatcher,
	type RpcInputFrameDeps,
	RpcPendingExtensionRequests,
	RpcShutdownCoordinator,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { RpcCommand, RpcExtensionUIResponse, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type OutputFrame = RpcResponse | object;

const makeDeps = (
	handleCommand: RpcInputFrameDeps["handleCommand"],
	options?: { pendingExtensionRequests?: Map<string, PendingExtensionRequest> },
) => {
	const outputs: OutputFrame[] = [];
	const deps: RpcInputFrameDeps = {
		handleCommand,
		output: obj => {
			outputs.push(obj as OutputFrame);
		},
		errorResponse: (id, command, message) => ({
			id,
			type: "response",
			command,
			success: false,
			error: message,
		}),
		pendingExtensionRequests: options?.pendingExtensionRequests ?? new Map<string, PendingExtensionRequest>(),
	};
	return { deps, outputs };
};

const flushMicrotasks = () => new Promise<void>(resolve => setImmediate(resolve));

const requestExtensionInput = (deps: RpcInputFrameDeps, id: string, message: string) => {
	const response = Promise.withResolvers<RpcExtensionUIResponse>();
	deps.pendingExtensionRequests.set(id, {
		resolve: response.resolve,
		reject: error => response.reject(error),
	});
	deps.output({
		type: "extension_ui_request",
		id,
		method: "input",
		message,
	});
	return response.promise;
};

const sessionResultResponse = (id: string | undefined): RpcResponse => ({
	id,
	type: "response",
	command: "session.result",
	success: true,
	data: {
		resultId: "result-1",
		outcome: "completed",
		stopReason: "done",
		finalMessage: "done",
		usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		terminalSequence: 1,
	},
});

describe("dispatchRpcInputFrame", () => {
	test("ordinary commands are dispatched serially (ordering preserved)", async () => {
		const started: string[] = [];
		const finished: string[] = [];
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
			started.push(command.type);
			finished.push(command.type);
			if (command.type === "abort_retry") {
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected: ${command.type}`);
		};

		const { deps, outputs } = makeDeps(handleCommand);

		const first = dispatchRpcInputFrame({ id: "c1", type: "abort_retry" }, deps);
		expect(first).toBeInstanceOf(Promise);
		// The input loop awaits each command's promise before pulling the next
		// frame; simulate that contract by awaiting before the next dispatch.
		await first;
		expect(outputs).toHaveLength(1);
		expect(started).toEqual(["abort_retry"]);
		expect(finished).toEqual(["abort_retry"]);

		const second = dispatchRpcInputFrame({ id: "c2", type: "set_auto_retry", enabled: true }, deps);
		await second;
		expect(outputs).toHaveLength(2);
		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
	});
});

test("drains queued serial input before sealing EOF and releasing result waiters", async () => {
	const order: string[] = [];
	let inputDrained = false;
	let sealed = false;

	await finalizeRpcInputAfterEof(
		async () => {
			inputDrained = true;
			order.push("input");
		},
		async () => {
			expect(inputDrained).toBe(true);
			sealed = true;
			order.push("seal");
		},
		async () => {
			expect(sealed).toBe(true);
			order.push("background");
		},
	);

	expect(order).toEqual(["input", "seal", "background"]);
});
describe("RpcInputDispatcher", () => {
	test("control frames resolve extension UI requests while an ordinary command is active", async () => {
		let depsRef: RpcInputFrameDeps;
		const { deps, outputs } = makeDeps(async command => {
			if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
			const response = await requestExtensionInput(depsRef, "ui-active", "Continue?");
			return {
				id: command.id,
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: "value" in response && response.value === "continue" },
			};
		});
		depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "prompt-1", type: "prompt", message: "ask extension" });
		await flushMicrotasks();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
		]);

		dispatcher.dispatch({ type: "extension_ui_response", id: "ui-active", value: "continue" });
		await dispatcher.drain();

		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "ui-active",
				method: "input",
				message: "Continue?",
			},
			{
				id: "prompt-1",
				type: "response",
				command: "prompt",
				success: true,
				data: { agentInvoked: true },
			},
		]);
	});

	test("malformed frames emit a parse error without ending the input reader", () => {
		const { deps, outputs } = makeDeps(async command => ({
			id: command.id,
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: false },
		}));
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch(null);

		expect(outputs).toEqual([
			expect.objectContaining({
				type: "response",
				command: "parse",
				success: false,
				error: expect.stringContaining("Failed to parse command:"),
			}),
		]);
	});

	test("ordinary commands stay serialized while first command is blocked", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") {
				await releaseFirst.promise;
				return { id: command.id, type: "response", command: "abort_retry", success: true };
			}
			if (command.type === "get_state") {
				return {
					id: command.id,
					type: "response",
					command: "get_state",
					success: true,
					data: {
						thinkingLevel: undefined,
						isStreaming: false,
						isCompacting: false,
						steeringMode: "all",
						followUpMode: "all",
						interruptMode: "immediate",
						sessionId: "session-1",
						autoCompactionEnabled: false,
						fastModeEnabled: false,
						fastModeActive: false,
						tokensPerSecond: null,
						messageCount: 0,
						queuedMessageCount: 0,
						todoPhases: [],
					},
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "first", type: "abort_retry" });
		dispatcher.dispatch({ id: "second", type: "get_state" });
		await flushMicrotasks();

		expect(started).toEqual(["abort_retry"]);
		expect(outputs).toHaveLength(0);

		releaseFirst.resolve();
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "get_state"]);
		expect((outputs[0] as RpcResponse).id).toBe("first");
		expect((outputs[1] as RpcResponse).id).toBe("second");
		expect((outputs[1] as RpcResponse).command).toBe("get_state");
	});

	test("session.result waits in the background while later steering dispatches", async () => {
		const result = Promise.withResolvers<RpcResponse>();
		const started: string[] = [];
		const backgroundTasks: Promise<void>[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "session.result") return result.promise;
			if (command.type === "session.steer") {
				return {
					id: command.id,
					type: "response",
					command: "session.steer",
					success: true,
					data: { status: "ACCEPTED", steeringSequence: 1 },
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		deps.trackBackgroundTask = task => backgroundTasks.push(task);
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "result", type: "session.result" });
		dispatcher.dispatch({ id: "steer", type: "session.steer", steering_id: "s-1", message: "continue" });
		await dispatcher.drain();
		expect(started).toEqual(["session.result", "session.steer"]);
		expect((outputs[0] as RpcResponse).id).toBe("steer");

		result.resolve({
			id: "result",
			type: "response",
			command: "session.result",
			success: true,
			data: {
				resultId: "result-1",
				outcome: "completed",
				stopReason: "done",
				finalMessage: "done",
				usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				terminalSequence: 1,
			},
		});
		await Promise.all(backgroundTasks);
		expect((outputs[1] as RpcResponse).id).toBe("result");
	});

	test("session.result starts after an earlier custody bind without blocking later steering", async () => {
		const bind = Promise.withResolvers<void>();
		const result = Promise.withResolvers<RpcResponse>();
		const started: string[] = [];
		const backgroundTasks: Promise<void>[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "session.start") {
				await bind.promise;
				return {
					id: command.id,
					type: "response",
					command: "session.start",
					success: true,
					data: { run_id: command.run_id, session_id: "session-1", existing: false },
				};
			}
			if (command.type === "session.result") return result.promise;
			if (command.type === "session.steer") {
				return {
					id: command.id,
					type: "response",
					command: "session.steer",
					success: true,
					data: { status: "ACCEPTED", steeringSequence: 1 },
				};
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		deps.trackBackgroundTask = task => backgroundTasks.push(task);
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "start", type: "session.start", run_id: "run-1" });
		dispatcher.dispatch({ id: "result", type: "session.result" });
		dispatcher.dispatch({ id: "steer", type: "session.steer", steering_id: "s-1", message: "continue" });
		await flushMicrotasks();
		expect(started).toEqual(["session.start"]);
		expect(backgroundTasks).toHaveLength(0);

		bind.resolve();
		await dispatcher.drain();
		expect(started).toEqual(["session.start", "session.result", "session.steer"]);
		expect(outputs.map(output => (output as RpcResponse).id)).toEqual(["start", "steer"]);

		result.resolve({
			id: "result",
			type: "response",
			command: "session.result",
			success: true,
			data: {
				resultId: "result-1",
				outcome: "completed",
				stopReason: "done",
				finalMessage: "done",
				usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				terminalSequence: 1,
			},
		});
		await Promise.all(backgroundTasks);
		expect((outputs[2] as RpcResponse).id).toBe("result");
	});

	/**
	 * A bound client can ask for the terminal result before one exists. That wait
	 * is released by the EOF seal, so it must not join the drain that runs
	 * *before* sealing — otherwise stdin close never reaches `sealLedgerOnExit()`
	 * and the run neither seals nor disposes.
	 */
	const makeResultWaitHarness = () => {
		const terminal = Promise.withResolvers<void>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "prompt") {
				// Matches production: `prompt` answers as soon as the turn starts,
				// the turn itself keeps running.
				return { id: command.id, type: "response", command: "prompt", success: true };
			}
			if (command.type === "session.result") {
				// waitResult() settles only once the ledger holds terminal state.
				await terminal.promise;
				return sessionResultResponse(command.id);
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: async () => {},
		});
		deps.trackBackgroundTask = task => coordinator.track(task);
		const dispatcher = new RpcInputDispatcher({ deps });
		// The pre-seal drain must resolve within the microtask cascade. Racing it
		// against a flushed sentinel fails fast (instead of hanging the suite) if
		// the result wait is ever put back into the serial task set.
		const drainInput = async () => {
			const drained = dispatcher.drain().then(() => "drained");
			const winner = await Promise.race([drained, flushMicrotasks().then(() => "blocked")]);
			expect(winner).toBe("drained");
		};
		return { terminal, started, outputs, coordinator, dispatcher, drainInput };
	};

	test("a result requested before terminal state is released by the EOF seal, not the pre-seal drain", async () => {
		const { terminal, started, outputs, coordinator, dispatcher, drainInput } = makeResultWaitHarness();
		const order: string[] = [];

		// Bound client asks for the result, then closes stdin without prompting.
		dispatcher.dispatch({ id: "result", type: "session.result" });

		await finalizeRpcInputAfterEof(
			async () => {
				await drainInput();
				order.push("input");
			},
			async () => {
				expect(outputs).toHaveLength(0);
				order.push("seal");
				terminal.resolve();
			},
			async () => {
				await dispatcher.drainResultWaits();
				await coordinator.drain();
				order.push("background");
			},
		);

		expect(order).toEqual(["input", "seal", "background"]);
		expect(started).toEqual(["session.result"]);
		expect(outputs).toEqual([sessionResultResponse("result")]);
		expect(dispatcher.hasPendingResultWaits).toBe(false);
		expect(coordinator.hasTrackedTasks).toBe(false);
	});

	test("a result queued behind a hung provider turn still seals and answers at EOF", async () => {
		const { terminal, started, outputs, coordinator, dispatcher, drainInput } = makeResultWaitHarness();
		let sealed = false;

		dispatcher.dispatch({ id: "p1", type: "prompt", message: "go" });
		dispatcher.dispatch({ id: "result", type: "session.result" });

		await finalizeRpcInputAfterEof(
			drainInput,
			async () => {
				// Forced sealing runs even though the turn never reached a terminal
				// event on its own.
				sealed = true;
				terminal.resolve();
			},
			async () => {
				await dispatcher.drainResultWaits();
				await coordinator.drain();
			},
		);

		expect(sealed).toBe(true);
		expect(started).toEqual(["prompt", "session.result"]);
		expect(outputs.map(frame => (frame as RpcResponse).id)).toEqual(["p1", "result"]);
		expect(dispatcher.hasPendingResultWaits).toBe(false);
	});

	test("aborts started long-running serial work so the EOF drain reaches the seal", async () => {
		// `compact` runs in the serial tail and waits on a provider summary that can
		// stall without limit. The pre-seal drain awaits that tail, and the abort
		// that would settle it lives in `session.dispose()` — which only runs after
		// the seal. Left alone the process wedges: no seal, no dispose, no exit.
		const compaction = Promise.withResolvers<RpcResponse>();
		const started: string[] = [];
		const aborted: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "compact") return compaction.promise;
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({
			deps,
			isLongRunningSerialCommand: command => command.type === "compact",
			abortSerialCommand: command => {
				aborted.push(command.type);
				// Production: session.abortCompaction() aborts the controller the
				// stalled summary is waiting on, so session.compact() rejects.
				compaction.reject(new Error("Compaction aborted"));
			},
		});

		dispatcher.dispatch({ id: "c1", type: "compact" });
		await flushMicrotasks();
		expect(started).toEqual(["compact"]);

		// stdin closes. Without the abort this drain never resolves.
		dispatcher.closeForExit();
		const order: string[] = [];
		await finalizeRpcInputAfterEof(
			async () => {
				const drained = dispatcher.drain().then(() => "drained");
				expect(await Promise.race([drained, flushMicrotasks().then(() => "blocked")])).toBe("drained");
				order.push("input");
			},
			async () => {
				order.push("seal");
			},
			async () => {
				order.push("background");
			},
		);

		expect(aborted).toEqual(["compact"]);
		expect(order).toEqual(["input", "seal", "background"]);
		// Aborting is not dropping: the command still answers the client.
		expect(outputs).toEqual([
			{ id: "c1", type: "response", command: "compact", success: false, error: "Compaction aborted" },
		]);
	});

	test("refuses long-running serial work still queued at EOF and runs the ordinary tail", async () => {
		// The queued/started distinction: a second `compact` has not started, so
		// there is nothing to abort. Starting it once the tail unblocks would
		// re-stall the drain the abort just freed, so it is refused instead — but
		// refused with the frame it owes, and ordinary queued commands still run.
		const compaction = Promise.withResolvers<RpcResponse>();
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "compact") return compaction.promise;
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({
			deps,
			isLongRunningSerialCommand: command => command.type === "compact",
			abortSerialCommand: () => compaction.reject(new Error("Compaction aborted")),
		});

		dispatcher.dispatch({ id: "c1", type: "compact" });
		dispatcher.dispatch({ id: "c2", type: "compact" });
		dispatcher.dispatch({ id: "s1", type: "set_auto_retry", enabled: true });
		await flushMicrotasks();
		expect(started).toEqual(["compact"]);

		dispatcher.closeForExit();
		await dispatcher.drain();

		expect(started).toEqual(["compact", "set_auto_retry"]);
		expect(outputs).toEqual([
			{ id: "c1", type: "response", command: "compact", success: false, error: "Compaction aborted" },
			{
				id: "c2",
				type: "response",
				command: "compact",
				success: false,
				error: "RPC client disconnected before the command started",
			},
			{ id: "s1", type: "response", command: "set_auto_retry", success: true },
		]);
	});
	test("serial command rejection emits an error response and does not poison the queue", async () => {
		const started: string[] = [];
		const { deps, outputs } = makeDeps(async command => {
			started.push(command.type);
			if (command.type === "abort_retry") throw new Error("retry controller exploded");
			if (command.type === "set_auto_retry") {
				return { id: command.id, type: "response", command: "set_auto_retry", success: true };
			}
			throw new Error(`unexpected command type: ${command.type}`);
		});
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "bad", type: "abort_retry" });
		dispatcher.dispatch({ id: "next", type: "set_auto_retry", enabled: true });
		await dispatcher.drain();

		expect(started).toEqual(["abort_retry", "set_auto_retry"]);
		expect(outputs).toEqual([
			{
				id: "bad",
				type: "response",
				command: "abort_retry",
				success: false,
				error: "retry controller exploded",
			},
			{
				id: "next",
				type: "response",
				command: "set_auto_retry",
				success: true,
			},
		]);
	});

	test("drain after EOF rejects active and future extension UI requests", async () => {
		const disconnectMessage = "RPC client disconnected before extension UI response completed";
		const pendingExtensionRequests = new RpcPendingExtensionRequests();
		const started: string[] = [];
		let depsRef: RpcInputFrameDeps;
		const { deps, outputs } = makeDeps(
			async command => {
				if (command.type !== "prompt") throw new Error(`unexpected command type: ${command.type}`);
				started.push(command.id ?? "");
				await requestExtensionInput(depsRef, `${command.id}-dialog`, command.message);
				return {
					id: command.id,
					type: "response",
					command: "prompt",
					success: true,
					data: { agentInvoked: true },
				};
			},
			{ pendingExtensionRequests },
		);
		depsRef = deps;
		const dispatcher = new RpcInputDispatcher({ deps });

		dispatcher.dispatch({ id: "active", type: "prompt", message: "active dialog" });
		dispatcher.dispatch({ id: "queued", type: "prompt", message: "queued dialog" });
		await flushMicrotasks();

		expect(started).toEqual(["active"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
		]);

		pendingExtensionRequests.rejectAll(disconnectMessage);
		await dispatcher.drain();

		expect(started).toEqual(["active", "queued"]);
		expect(outputs).toEqual([
			{
				type: "extension_ui_request",
				id: "active-dialog",
				method: "input",
				message: "active dialog",
			},
			{
				id: "active",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
			{
				type: "extension_ui_request",
				id: "queued-dialog",
				method: "input",
				message: "queued dialog",
			},
			{
				id: "queued",
				type: "response",
				command: "prompt",
				success: false,
				error: disconnectMessage,
			},
		]);
	});
});

describe("RpcShutdownCoordinator", () => {
	/** performShutdown spy that records call count and outputs.length at the moment it ran. */
	const makeShutdownRecorder = (outputs: OutputFrame[]) => {
		const state = { calls: 0, outputsAtShutdown: -1 };
		const performShutdown = async () => {
			state.calls++;
			state.outputsAtShutdown = outputs.length;
		};
		return { state, performShutdown };
	};

	/**
	 * Full production-shaped harness: a background session.result wait whose
	 * handler blocks on a gate, tracked by the coordinator exactly as
	 * `runRpcMode` wires it (`trackBackgroundTask: task => coordinator.track(task)`).
	 */
	const makeResultHarness = () => {
		const gate = Promise.withResolvers<RpcResponse>();
		const { deps, outputs } = makeDeps(async command => {
			if (command.type === "session.result") return await gate.promise;
			throw new Error(`unexpected: ${command.type}`);
		});
		const shutdown = { requested: false };
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => shutdown.requested,
			performShutdown: recorder.performShutdown,
		});
		deps.trackBackgroundTask = task => coordinator.track(task);
		return { gate, deps, outputs, shutdown, recorder, coordinator };
	};

	test("deferred shutdown drains an in-flight session.result wait before performShutdown", async () => {
		const { gate, deps, outputs, shutdown, recorder, coordinator } = makeResultHarness();

		const awaited = dispatchRpcInputFrame({ id: "s1", type: "session.result" }, deps);
		expect(coordinator.hasTrackedTasks).toBe(true);
		expect(awaited).toBeUndefined();

		shutdown.requested = true;
		const check = coordinator.checkShutdownRequested();

		// The check must stay pending while the result wait still owes its response
		// frame. Race it against a flushed sentinel: if the check could resolve,
		// its microtask would win before the setImmediate tick.
		const winner = await Promise.race([check.then(() => "shutdown"), flushMicrotasks().then(() => "pending")]);
		expect(winner).toBe("pending");
		expect(recorder.state.calls).toBe(0);
		expect(outputs).toHaveLength(0);

		gate.resolve(sessionResultResponse("s1"));
		await check;
		expect(coordinator.hasTrackedTasks).toBe(false);

		expect(outputs).toEqual([sessionResultResponse("s1")]);
		expect(recorder.state.calls).toBe(1);
		// The session.result response frame was written before performShutdown ran.
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("prepares shutdown before draining result waiters", async () => {
		const order: string[] = [];
		const result = Promise.withResolvers<void>();
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			prepareShutdown: async () => {
				order.push("sealed");
				result.resolve();
			},
			performShutdown: async () => {
				order.push("shutdown");
			},
		});
		coordinator.track(
			result.promise.then(() => {
				order.push("result");
			}),
		);

		await coordinator.checkShutdownRequested();

		expect(order).toEqual(["sealed", "result", "shutdown"]);
	});

	test("settle hook fires the deferred shutdown when no further client frames arrive", async () => {
		const { gate, deps, outputs, shutdown, recorder } = makeResultHarness();

		const awaited = dispatchRpcInputFrame({ id: "s2", type: "session.result" }, deps);
		expect(awaited).toBeUndefined();

		// Shutdown requested while session.result waits; the stdin loop is parked
		// with no frames, so only track()'s settle hook can trigger it.
		shutdown.requested = true;
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);

		gate.resolve(sessionResultResponse("s2"));
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		expect(outputs).toEqual([sessionResultResponse("s2")]);
		expect(recorder.state.outputsAtShutdown).toBe(1);
	});

	test("concurrent triggers are latched: performShutdown runs exactly once", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => true,
			performShutdown: recorder.performShutdown,
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		coordinator.track(gateB.promise);

		// Explicit trigger (input loop) races the settle hooks of both tasks.
		const check = coordinator.checkShutdownRequested();
		gateA.resolve();
		gateB.resolve();
		await check;
		await flushMicrotasks();
		await flushMicrotasks();

		expect(recorder.state.calls).toBe(1);
		// A later re-check reuses the latched sequence instead of re-running it.
		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(1);
	});

	test("no-op when shutdown was not requested", async () => {
		const outputs: OutputFrame[] = [];
		const recorder = makeShutdownRecorder(outputs);
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: recorder.performShutdown,
		});

		await coordinator.checkShutdownRequested();
		expect(recorder.state.calls).toBe(0);

		// A tracked task settling with the flag false never triggers shutdown.
		const gate = Promise.withResolvers<void>();
		coordinator.track(gate.promise);
		gate.resolve();
		await flushMicrotasks();
		await flushMicrotasks();
		expect(recorder.state.calls).toBe(0);
	});

	test("drain() waits for tasks tracked while draining", async () => {
		const coordinator = new RpcShutdownCoordinator({
			isShutdownRequested: () => false,
			performShutdown: async () => {},
		});

		const gateA = Promise.withResolvers<void>();
		const gateB = Promise.withResolvers<void>();
		coordinator.track(gateA.promise);
		// When A settles, a new task B enters the set mid-drain.
		void gateA.promise.then(() => {
			coordinator.track(gateB.promise);
		});

		let drained = false;
		const drain = coordinator.drain().then(() => {
			drained = true;
		});

		gateA.resolve();
		await flushMicrotasks();
		// A settled and B was tracked mid-drain; drain must keep waiting on B.
		expect(drained).toBe(false);

		gateB.resolve();
		await drain;
		expect(drained).toBe(true);
	});
});

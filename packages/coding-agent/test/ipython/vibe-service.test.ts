import { describe, expect, test } from "bun:test";
import type { IpythonHostRequest } from "../../src/ipython/controller";
import { IpythonVibeService } from "../../src/ipython/vibe-service";
import type { ToolSession } from "../../src/session/tool-session";
import type {
	VibeKillOutcome,
	VibeScreenSnapshot,
	VibeSendOutcome,
	VibeSpawnOutcome,
	VibeWaitOutcome,
} from "../../src/vibe/runtime";

function hostRequest(data: Readonly<Record<string, unknown>>, signal = new AbortController().signal) {
	const progress: string[] = [];
	const request: IpythonHostRequest = {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data,
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd: "/workspace",
		cellId: "cell-1",
		sequence: 1,
		origin: "model",
		authority: "trusted-cell",
		publishProgress: async message => {
			progress.push(message);
		},
		publishDisplay: async () => {},
		allocateArtifact: async () => {
			throw new Error("Vibe does not allocate artifacts");
		},
	};
	return { request, progress };
}

const screen: VibeScreenSnapshot = {
	id: "worker-1",
	cli: "fast",
	state: "running",
	turns: 1,
	queued: 0,
	trace: ["read(src/index.ts)"],
	outputTail: ["working"],
	lastActivityAt: 1,
};

describe("IPython Vibe service", () => {
	test("calls the registry directly for spawn/send/wait/kill/list without a tool bridge", async () => {
		const calls: string[] = [];
		const registry = {
			spawn: async (
				_session: ToolSession,
				input: { cli: "fast" | "good"; name?: string; prompt: string },
			): Promise<VibeSpawnOutcome> => {
				calls.push(`spawn:${input.cli}:${input.prompt}`);
				return { id: "worker-1", jobId: "job-1" };
			},
			send: async (_session: ToolSession, input: { session: string; message: string }): Promise<VibeSendOutcome> => {
				calls.push(`send:${input.session}:${input.message}`);
				return { id: input.session, mode: "steered" };
			},
			wait: async (
				_session: ToolSession,
				input: { sessions?: string[]; timeoutMs?: number; signal?: AbortSignal },
			): Promise<VibeWaitOutcome> => {
				calls.push(`wait:${input.sessions?.join(",")}:${input.timeoutMs}`);
				return {
					settled: [{ id: "worker-1", jobId: "job-1", status: "completed", resultText: "done" }],
					stillRunning: [],
					timedOut: false,
				};
			},
			kill: async (_session: ToolSession, id: string): Promise<VibeKillOutcome> => {
				calls.push(`kill:${id}`);
				return { id, cancelledTurn: true };
			},
			screens: (_session: ToolSession): VibeScreenSnapshot[] => {
				calls.push("list");
				return [screen];
			},
		};
		const service = new IpythonVibeService({ session: {} as ToolSession, registry });
		expect(
			await service.handlers["vibe.spawn"]!(hostRequest({ cli: "fast", prompt: " investigate " }).request),
		).toEqual({ id: "worker-1", cli: "fast", job_id: "job-1" });
		expect(
			await service.handlers["vibe.send"]!(hostRequest({ session: "worker-1", message: " continue " }).request),
		).toEqual({ id: "worker-1", mode: "steered" });
		expect(
			await service.handlers["vibe.wait"]!(hostRequest({ sessions: ["worker-1"], timeout_seconds: 2 }).request),
		).toMatchObject({ timed_out: false, settled: [{ id: "worker-1", result_text: "done" }] });
		expect(await service.handlers["vibe.kill"]!(hostRequest({ session: "worker-1" }).request)).toEqual({
			id: "worker-1",
			cancelled_turn: true,
		});
		expect(await service.handlers["vibe.list"]!(hostRequest({}).request)).toMatchObject({
			sessions: [{ id: "worker-1", trace: ["read(src/index.ts)"] }],
		});
		expect(calls).toEqual([
			"spawn:fast:investigate",
			"send:worker-1:continue",
			"wait:worker-1:2000",
			"kill:worker-1",
			"list",
		]);
	});

	test("bounds an omitted-selector wait across every settled and running worker", async () => {
		const settled = Array.from({ length: 100 }, (_, index) => ({
			id: `worker-${index}`,
			jobId: `job-${index}`,
			status: "completed" as const,
			resultText: "🧪".repeat(8_000),
		}));
		const running = Array.from({ length: 100 }, (_, index) => `running-${index}`);
		const service = new IpythonVibeService({
			session: {} as ToolSession,
			registry: {
				spawn: async (): Promise<VibeSpawnOutcome> => ({ id: "x", jobId: "j" }),
				send: async (): Promise<VibeSendOutcome> => ({ id: "x", mode: "queued" }),
				wait: async (): Promise<VibeWaitOutcome> => ({ settled, stillRunning: running, timedOut: false }),
				kill: async (): Promise<VibeKillOutcome> => ({ id: "x", cancelledTurn: false }),
				screens: (): VibeScreenSnapshot[] => [],
			},
		});
		const result = await service.handlers["vibe.wait"]!(hostRequest({}).request);
		const projected = result.settled as Array<{ result_text: string }>;
		expect(projected).toHaveLength(64);
		expect(Buffer.byteLength(projected[0]?.result_text ?? "", "utf8")).toBeLessThanOrEqual(4 * 1024);
		expect(result).toMatchObject({
			settled_truncated: true,
			settled_omitted: 36,
			still_running_truncated: true,
		});
		expect(result.still_running).toHaveLength(64);
		expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(512 * 1024);
	});

	test("rejects invalid fields and bounds before touching the registry", async () => {
		let calls = 0;
		const registry = {
			spawn: async (): Promise<VibeSpawnOutcome> => {
				calls++;
				return { id: "x", jobId: "j" };
			},
			send: async (): Promise<VibeSendOutcome> => {
				calls++;
				return { id: "x", mode: "queued" };
			},
			wait: async (): Promise<VibeWaitOutcome> => {
				calls++;
				return { settled: [], stillRunning: [], timedOut: false };
			},
			kill: async (): Promise<VibeKillOutcome> => {
				calls++;
				return { id: "x", cancelledTurn: false };
			},
			screens: (): VibeScreenSnapshot[] => {
				calls++;
				return [];
			},
		};
		const service = new IpythonVibeService({ session: {} as ToolSession, registry });
		await expect(service.handlers["vibe.spawn"]!(hostRequest({ cli: "slow", prompt: "x" }).request)).rejects.toThrow(
			"cli must be fast or good",
		);
		await expect(
			service.handlers["vibe.send"]!(hostRequest({ session: "x", message: "x", extra: true }).request),
		).rejects.toThrow("unknown field: extra");
		await expect(service.handlers["vibe.wait"]!(hostRequest({ sessions: ["x", "x"] }).request)).rejects.toThrow(
			"sessions must be unique",
		);
		await expect(service.handlers["vibe.wait"]!(hostRequest({ timeout_seconds: 3_601 }).request)).rejects.toThrow(
			"timeout_seconds must be between",
		);
		expect(calls).toBe(0);
	});

	test("passes active cancellation into wait and does not call a pre-aborted operation", async () => {
		let receivedSignal: AbortSignal | undefined;
		const waitEntered = Promise.withResolvers<void>();
		let spawnCalls = 0;
		const registry = {
			spawn: async (): Promise<VibeSpawnOutcome> => {
				spawnCalls++;
				return { id: "x", jobId: "j" };
			},
			send: async (): Promise<VibeSendOutcome> => ({ id: "x", mode: "queued" }),
			wait: async (_session: ToolSession, input: { signal?: AbortSignal }): Promise<VibeWaitOutcome> => {
				receivedSignal = input.signal;
				waitEntered.resolve();
				return await new Promise<VibeWaitOutcome>((_resolve, reject) =>
					input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }),
				);
			},
			kill: async (): Promise<VibeKillOutcome> => ({ id: "x", cancelledTurn: false }),
			screens: (): VibeScreenSnapshot[] => [],
		};
		const service = new IpythonVibeService({ session: {} as ToolSession, registry });
		const waiting = new AbortController();
		const request = hostRequest({}, waiting.signal);
		const pending = service.handlers["vibe.wait"]!(request.request);
		await waitEntered.promise;
		waiting.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		expect(receivedSignal).toBe(waiting.signal);
		const preaborted = new AbortController();
		preaborted.abort(new Error("stopped"));
		await expect(
			service.handlers["vibe.spawn"]!(hostRequest({ cli: "fast", prompt: "x" }, preaborted.signal).request),
		).rejects.toThrow("stopped");
		expect(spawnCalls).toBe(0);
	});
});

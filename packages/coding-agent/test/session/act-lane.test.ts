import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { IpythonHostRequestChannel } from "@oh-my-pi/pi-coding-agent/ipython/controller";
import { ActLane, type ActPrivateSession } from "@oh-my-pi/pi-coding-agent/session/act-lane";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function channel(responses: Readonly<Record<string, unknown>>[] = []): IpythonHostRequestChannel & { sent: string[] } {
	const abort = new AbortController();
	return {
		signal: abort.signal,
		sent: [],
		async send(data) {
			this.sent.push(String(data.code));
		},
		async receive(signal) {
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			const response = responses.shift();
			if (!response) throw new Error("no response");
			return response;
		},
	};
}

function fakeSession(
	model: { provider: string; id: string },
	run: (tool: AgentTool, signal: AbortSignal) => Promise<void>,
	tool: AgentTool,
): ActPrivateSession {
	return {
		model,
		thinkingLevel: "medium",
		messages: [],
		sessionManager: SessionManager.inMemory("/tmp"),
		async prompt(_text, options) {
			await run(tool, options.signal);
		},
		subscribe() {
			return () => {};
		},
		abort() {},
		dispose() {},
		getLastAssistantText() {
			return "provider text";
		},
	};
}

async function execute(tool: AgentTool, id: string, code: string): Promise<unknown> {
	return await tool.execute(id, { code });
}

describe("ActLane", () => {
	it("exchanges complete cells and finishes only on done", async () => {
		const lane = new ActLane();
		const host = channel([
			{ type: "cell_result", durationMs: 5, stdout: "set", stderr: "", result: "1" },
			{ type: "done" },
		]);
		const result = await lane.run("work", host, {
			sessionKey: "fake/a",
			createSession: async tool =>
				fakeSession(
					{ provider: "fake", id: "a" },
					async installed => {
						const first = await execute(installed, "one", "value = 1");
						expect(first).toMatchObject({ details: { durationMs: 5, result: "1" } });
						await execute(installed, "two", "rlm.done(value)");
					},
					tool,
				),
		});
		expect(result).toEqual({ outcome: "done" });
		expect(host.sent).toEqual(["value = 1", "rlm.done(value)"]);
	});

	it("retains a private transcript per model across switches", async () => {
		const lane = new ActLane();
		let creates = 0;
		const target = (id: string) => ({
			sessionKey: `fake/${id}`,
			createSession: async (tool: AgentTool) => {
				creates++;
				return fakeSession({ provider: "fake", id }, async () => {}, tool);
			},
		});
		await lane.run("a1", channel(), target("a"));
		await lane.run("b", channel(), target("b"));
		await lane.run("a2", channel(), target("a"));
		expect(creates).toBe(2);
	});

	it("rejects an overlapping Act instead of silently queueing it", async () => {
		const gate = Promise.withResolvers<void>();
		const lane = new ActLane();
		const target = {
			sessionKey: "fake/a",
			createSession: async (tool: AgentTool) =>
				fakeSession({ provider: "fake", id: "a" }, async () => gate.promise, tool),
		};
		const first = lane.run("one", channel(), target);
		await Promise.resolve();
		await expect(lane.run("two", channel(), target)).rejects.toThrow("Another Act is already active");
		gate.resolve();
		await first;
	});

	it("cancels provider work cooperatively", async () => {
		const lane = new ActLane();
		const started = Promise.withResolvers<void>();
		const target = {
			sessionKey: "fake/a",
			createSession: async (tool: AgentTool) =>
				fakeSession(
					{ provider: "fake", id: "a" },
					async (_installed, signal) => {
						started.resolve();
						await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
					},
					tool,
				),
		};
		const pending = lane.run("one", channel(), target);
		await started.promise;
		expect(lane.cancel()).toBe(true);
		expect(await pending).toEqual({ outcome: "cancelled" });
	});

	it("cancels in-flight session creation and disposes a session that arrives late", async () => {
		const lane = new ActLane();
		const creation = Promise.withResolvers<ActPrivateSession>();
		const disposed = Promise.withResolvers<void>();
		let creationSignal: AbortSignal | undefined;
		const pending = lane.run("one", channel(), {
			sessionKey: "fake/a",
			createSession: async (_tool, signal) => {
				creationSignal = signal;
				return await creation.promise;
			},
		});
		await Promise.resolve();
		const disposing = lane.dispose();
		expect(await pending).toEqual({ outcome: "cancelled" });
		await disposing;
		expect(creationSignal?.aborted).toBe(true);

		const late = fakeSession({ provider: "fake", id: "a" }, async () => {}, {} as AgentTool);
		late.dispose = () => disposed.resolve();
		creation.resolve(late);
		await disposed.promise;
	});

	it("returns provider text without treating it as completion", async () => {
		const lane = new ActLane();
		const result = await lane.run("one", channel(), {
			sessionKey: "fake/a",
			createSession: async tool => fakeSession({ provider: "fake", id: "a" }, async () => {}, tool),
		});
		expect(result).toEqual({ outcome: "text", text: "provider text" });
	});

	it("rejects malformed cell results", async () => {
		const lane = new ActLane();
		await expect(
			lane.run("one", channel([{ type: "cell_result", stdout: 42 }]), {
				sessionKey: "fake/a",
				createSession: async tool =>
					fakeSession(
						{ provider: "fake", id: "a" },
						async installed => {
							await execute(installed, "bad", "1 + 1");
						},
						tool,
					),
			}),
		).rejects.toThrow("invalid stdout");
	});
});

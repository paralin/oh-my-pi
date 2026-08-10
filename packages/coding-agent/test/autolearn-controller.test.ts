import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AutoLearnController, buildAutoLearnInstructions } from "@oh-my-pi/pi-coding-agent/autolearn/controller";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

class FakeSession {
	readonly listeners: Array<(event: AgentSessionEvent) => void> = [];
	readonly captures: string[] = [];
	planEnabled = false;
	goalEnabled = false;
	captureGate: Promise<void> | undefined;
	captureError: Error | undefined;

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	async capture(content: string): Promise<void> {
		this.captures.push(content);
		const gate = this.captureGate;
		const error = this.captureError;
		if (gate) await gate;
		if (error) throw error;
	}

	getGoalModeState(): { enabled: boolean } | undefined {
		return this.goalEnabled ? { enabled: true } : undefined;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	toolCalls(n: number): void {
		for (let i = 0; i < n; i++) {
			this.emit({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "read", result: null });
		}
	}

	agentStart(): void {
		this.emit({ type: "agent_start" });
	}

	agentEnd(messages: AgentMessage[] = []): void {
		this.emit({ type: "agent_end", messages });
	}
}

function install(session: FakeSession, overrides: Record<string, unknown> = {}): Settings {
	const settings = Settings.isolated({ "autolearn.enabled": true, ...overrides });
	new AutoLearnController({
		session: session as unknown as AgentSession,
		settings,
		capture: content => session.capture(content),
	});
	return settings;
}

async function settleCaptures(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("AutoLearnController", () => {
	it("does not inject a passive nudge into the conversation prefix", () => {
		const session = new FakeSession();
		install(session);
		session.toolCalls(5);
		session.agentEnd();

		expect(session.captures).toHaveLength(0);
	});

	it("does not nudge below the threshold", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(4);
		session.agentEnd();
		expect(session.captures).toHaveLength(0);
	});
	it("does not combine tool calls across separate sub-threshold turns", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(3);
		session.agentEnd();
		session.toolCalls(3);
		session.agentEnd();
		// Neither turn reached the threshold; the counter must not accumulate.
		expect(session.captures).toHaveLength(0);
	});

	it("stops auto-continuing when autolearn is disabled mid-session", () => {
		const session = new FakeSession();
		// Enable via the global layer (not an isolated override) so the live flag
		// can be flipped and the controller's fire-time re-check is exercised.
		const settings = Settings.isolated({ "autolearn.autoContinue": true });
		settings.set("autolearn.enabled", true);
		new AutoLearnController({
			session: session as unknown as AgentSession,
			settings,
			capture: content => session.capture(content),
		});
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // fires while enabled
		settings.set("autolearn.enabled", false);
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1); // no new nudge after disable
		// The disabled stop must NOT leave its tool calls queued: re-enabling and
		// doing a sub-threshold turn must not fire from leaked counts.
		settings.set("autolearn.enabled", true);
		session.toolCalls(1);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("does not nudge during goal mode and leaks no suppression latch", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		// Goal mode owns the continuation; auto-learn stays out of the loop.
		expect(session.captures).toHaveLength(0);
		// The skipped stop must not arm suppression for the next non-goal stop.
		session.goalEnabled = false;
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("never nudges a turn that started in goal mode even if the goal ended mid-turn", () => {
		const session = new FakeSession();
		session.goalEnabled = true;
		install(session, { "autolearn.autoContinue": true });
		// The turn begins as a goal continuation...
		session.agentStart();
		session.toolCalls(5);
		// ...then a `goal` tool completes/drops the goal mid-turn: the live flag is
		// off by the time the turn stops, but this turn must still never be nudged.
		session.goalEnabled = false;
		session.agentEnd();
		expect(session.captures).toHaveLength(0);

		// The capture is per-turn: a fresh turn that did not start in goal mode
		// nudges normally, proving the latch resets.
		session.agentStart();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
	});

	it("coalesces newer eligible stops behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(5);
		session.agentEnd();
		expect(session.captures).toHaveLength(1);
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(3);
	});

	it("does not queue an ineligible stop behind an in-flight capture", async () => {
		const session = new FakeSession();
		const release = Promise.withResolvers<void>();
		session.captureGate = release.promise;
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		session.toolCalls(4);
		session.agentEnd();
		session.captureGate = undefined;
		release.resolve();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("clears the in-flight guard after capture failure", async () => {
		const session = new FakeSession();
		session.captureError = new Error("capture failed");
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		session.captureError = undefined;
		session.toolCalls(5);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(2);
	});

	it("respects a custom minToolCalls threshold", async () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true, "autolearn.minToolCalls": 2 });
		session.toolCalls(2);
		session.agentEnd();
		await settleCaptures();
		expect(session.captures).toHaveLength(1);
	});

	it("does not nudge when the turn ended with stopReason aborted", () => {
		const session = new FakeSession();
		install(session, { "autolearn.autoContinue": true });
		session.toolCalls(5);
		const abortedMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "partial" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "mock",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
		};
		session.agentEnd([abortedMessage]);
		expect(session.captures).toHaveLength(0);
	});
});

describe("buildAutoLearnInstructions", () => {
	it("returns null when manage_skill is not in the active tool set", () => {
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: false })).toBeNull();
		// learn without manage_skill still yields no guidance (manage_skill gates it).
		expect(buildAutoLearnInstructions({ manageSkill: false, learn: true })).toBeNull();
	});

	it("includes the learn addendum when the learn tool is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: true });
		expect(text).toContain("manage_skill");
		expect(text).toContain("long-term memory");
	});

	it("omits the learn addendum when only manage_skill is present", () => {
		const text = buildAutoLearnInstructions({ manageSkill: true, learn: false });
		expect(text).toContain("manage_skill");
		expect(text).not.toContain("long-term memory");
	});
});

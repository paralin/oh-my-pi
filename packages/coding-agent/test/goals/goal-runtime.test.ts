import { describe, expect, it } from "bun:test";
import {
	GoalRuntime,
	type GoalRuntimeHost,
	goalTokenDelta,
	renderGoalPrompt,
	renderTrustedObjective,
} from "@oh-my-pi/pi-coding-agent/goals/runtime";
import type { Goal, GoalModeState, GoalRuntimeEvent, GoalTokenUsage } from "@oh-my-pi/pi-coding-agent/goals/state";
import { escapeXmlText } from "@oh-my-pi/pi-utils";

function createUsage(overrides: Partial<GoalTokenUsage> = {}): GoalTokenUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		...overrides,
	};
}

function createGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		objective: "Ship <fast> & safely",
		status: "active",
		tokenBudget: undefined,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function cloneGoal(goal: Goal): Goal {
	return { ...goal };
}

function cloneState(state: GoalModeState | undefined): GoalModeState | undefined {
	return state ? { ...state, goal: cloneGoal(state.goal) } : undefined;
}

function cloneEvent(event: GoalRuntimeEvent): GoalRuntimeEvent {
	if (event.type === "goal_updated") {
		return {
			...event,
			goal: event.goal ? cloneGoal(event.goal) : null,
			state: cloneState(event.state),
		};
	}
	return { ...event };
}

function createHarness(
	initial: {
		state?: GoalModeState;
		usage?: GoalTokenUsage;
		now?: number;
		onEmit?: (event: GoalRuntimeEvent) => Promise<void>;
	} = {},
) {
	let state = cloneState(initial.state);
	let usage = createUsage(initial.usage);
	let now = initial.now ?? 0;
	const events: GoalRuntimeEvent[] = [];
	const persists: Array<{ mode: "goal" | "goal_paused" | "none"; state?: GoalModeState }> = [];
	const hiddenMessages: Array<{ customType: string; content: string; deliverAs?: "steer" | "followUp" | "nextTurn" }> =
		[];
	const host: GoalRuntimeHost = {
		getState: () => cloneState(state),
		setState: next => {
			state = cloneState(next);
		},
		getCurrentUsage: () => createUsage(usage),
		emit: async event => {
			events.push(cloneEvent(event));
			await initial.onEmit?.(event);
		},
		persist: (mode, persistedState) => {
			persists.push({ mode, state: cloneState(persistedState) });
		},
		sendHiddenMessage: async message => {
			hiddenMessages.push({ ...message });
		},
		now: () => now,
	};
	return {
		runtime: new GoalRuntime(host),
		getState: () => cloneState(state),
		setState: (next: GoalModeState | undefined) => {
			state = cloneState(next);
		},
		setUsage: (next: Partial<GoalTokenUsage>) => {
			usage = createUsage(next);
		},
		advance: (ms: number) => {
			now += ms;
		},
		events,
		persists,
		hiddenMessages,
	};
}

describe("goal runtime", () => {
	it("counts cache writes but ignores cache reads in token deltas", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 13, output: 6, cacheRead: 999, cacheWrite: 8 }),
				createUsage({ input: 10, output: 4, cacheRead: 1, cacheWrite: 5 }),
			),
		).toBe(8);
	});

	it("clamps token deltas at zero across usage resets", () => {
		expect(
			goalTokenDelta(
				createUsage({ input: 10, output: 5, cacheRead: 0, cacheWrite: 2 }),
				createUsage({ input: 100, output: 50, cacheRead: 500, cacheWrite: 20 }),
			),
		).toBe(0);
	});

	it("advances wall-clock accounting only by persisted whole seconds", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		harness.setUsage(createUsage({ input: 1 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(400);
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(2_000);
		expect(harness.persists).toHaveLength(1);

		harness.advance(700);
		harness.setUsage(createUsage({ input: 2 }));
		await harness.runtime.flushUsage("suppressed");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(3);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(3_000);
		expect(harness.persists).toHaveLength(2);
	});

	it("does not persist snapshots on wall-clock-only flushes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		// Flush wall-clock time without any token usage changes.
		await harness.runtime.flushUsage("suppressed");
		// The in-memory state should still be updated.
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		// But it should not write/persist to the session log.
		expect(harness.persists).toHaveLength(0);
	});

	it("persists wall-clock-only usage before internal compaction or session-switch aborts", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(2_500);
		await harness.runtime.onTaskAborted({ reason: "internal" });

		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(2);
		expect(harness.persists).toHaveLength(1);
		expect(harness.persists[0]).toMatchObject({
			mode: "goal",
			state: { goal: { timeUsedSeconds: 2 } },
		});
	});

	it("resets wall-clock baseline when preserving an active goal after a no-goal switch", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.advance(10_000);
		harness.setState({ enabled: true, mode: "active", goal });

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("clears stale accounting when reconciling to a no-goal session", async () => {
		const goal = createGoal();
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setState(undefined);
		harness.runtime.clearAccounting();
		harness.advance(10_000);
		harness.setState({ enabled: true, mode: "active", goal });

		await harness.runtime.onThreadResumed({ preserveActiveGoal: true });
		harness.advance(1_000);
		await harness.runtime.flushUsage("suppressed");

		expect(harness.getState()?.goal.timeUsedSeconds).toBe(1);
		expect(harness.runtime.snapshot.wallClock.lastAccountedAt).toBe(11_000);
	});

	it("steers only once until a budget mutation resets the cycle", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 10, tokensUsed: 8 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.setUsage({ input: 2 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]).toMatchObject({
			customType: "goal-budget-limit",
			deliverAs: "steer",
		});

		harness.setUsage({ input: 5 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.hiddenMessages).toHaveLength(1);

		await harness.runtime.onBudgetMutated(20);
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.getState()?.goal.tokenBudget).toBe(20);
		expect(harness.hiddenMessages).toHaveLength(1);

		harness.setUsage({ input: 15 });
		await harness.runtime.flushUsage("allowed");
		expect(harness.getState()?.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(2);
	});

	it("pauses an active goal when an interruption aborts the task", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ output: 4 });
		await harness.runtime.onTaskAborted({ reason: "interrupted" });

		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.goal.status).toBe("paused");
		expect(state?.goal.tokensUsed).toBe(4);
		expect(state?.goal.timeUsedSeconds).toBe(1);
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("auto-pauses active goals when a thread resumes", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed();
		expect(resumed?.enabled).toBe(false);
		expect(resumed?.goal.status).toBe("paused");
		expect(harness.getState()?.enabled).toBe(false);
		expect(harness.getState()?.goal.status).toBe("paused");
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("preserves an active goal during internal session-switch reconciliation", async () => {
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
		});

		const resumed = await harness.runtime.onThreadResumed({ preserveActiveGoal: true });

		expect(resumed?.enabled).toBe(true);
		expect(resumed?.goal.status).toBe("active");
		expect(harness.getState()?.enabled).toBe(true);
		expect(harness.getState()?.goal.status).toBe("active");
		expect(harness.persists).toHaveLength(0);
	});

	it("escapes XML in goal helpers and rendered prompts", () => {
		const objective = "Fix <root>&keep>safe";
		const goal = createGoal({ objective });
		const prompt = renderGoalPrompt("active", goal);

		expect(renderTrustedObjective(objective)).toBe("<objective>\nFix &lt;root&gt;&amp;keep&gt;safe\n</objective>");
		expect(prompt).toContain("Fix &lt;root&gt;&amp;keep&gt;safe");
		expect(prompt).not.toContain(objective);
	});

	it("returns the input verbatim when escapeXmlText has nothing to escape", () => {
		const input = "plain text — with 'quotes' and \"double\" plus unicode ✓";
		expect(escapeXmlText(input)).toBe(input);
		// fast-path identity: the helper should not allocate a new string when nothing changed
		expect(escapeXmlText(input)).toBe(escapeXmlText(input));
	});

	it("escapeXmlText escapes only the XML-significant trio and leaves other characters untouched", () => {
		expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
		expect(escapeXmlText("'\"`")).toBe("'\"`");
	});

	it("onBudgetMutated downward to below current usage flips active to budget-limited and steers", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 30, status: "active" }),
			},
		});

		const next = await harness.runtime.onBudgetMutated(20);

		expect(next?.goal.status).toBe("budget-limited");
		expect(next?.goal.tokenBudget).toBe(20);
		expect(next?.goal.tokensUsed).toBe(30);
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.customType).toBe("goal-budget-limit");
	});

	it("completeGoalFromTool clears enabled and flips status to complete with mode exiting (fix #1)", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ tokenBudget: 100, tokensUsed: 42, timeUsedSeconds: 7 }),
			},
		});

		const completed = await harness.runtime.completeGoalFromTool();

		expect(completed.status).toBe("complete");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.mode).toBe("exiting");
		expect(state?.reason).toBe("completed");
		expect(state?.goal.status).toBe("complete");
	});

	it("dropGoal emits goal_updated with the dropped goal and clears persisted state", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ id: "g-99", objective: "Ship soon" }),
			},
		});

		const dropped = await harness.runtime.dropGoal();

		expect(dropped?.status).toBe("dropped");
		expect(dropped?.id).toBe("g-99");
		expect(harness.getState()).toBeUndefined();
		const lastEvent = harness.events.at(-1);
		if (lastEvent?.type !== "goal_updated") {
			throw new Error("expected goal_updated event after dropGoal");
		}
		expect(lastEvent.goal?.status).toBe("dropped");
		expect(lastEvent.state?.enabled).toBe(false);
	});

	it("rejects op=create on the runtime when a non-dropped goal already exists", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing" }),
			},
		});

		await expect(harness.runtime.createGoal({ objective: "Second" })).rejects.toThrow(
			"cannot create a new goal because this session already has a goal",
		);
	});

	it("replaces an active goal with a fresh active goal", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing", tokenBudget: 100 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ input: 12 });

		const next = await harness.runtime.replaceGoal({ objective: "Second", tokenBudget: 25 });

		expect(next.enabled).toBe(true);
		expect(next.goal.objective).toBe("Second");
		expect(next.goal.status).toBe("active");
		expect(next.goal.tokenBudget).toBe(25);
		expect(next.goal.tokensUsed).toBe(0);
		expect(next.goal.timeUsedSeconds).toBe(0);
		expect(next.goal.id).not.toBe("goal-1");
		expect(harness.persists.at(-1)?.state?.goal.objective).toBe("Second");
	});

	it("preserves usage flushed while setting an active goal", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ objective: "Existing", tokenBudget: 100, tokensUsed: 3 }),
			},
		});

		harness.runtime.onTurnStart("turn-1", createUsage());
		harness.advance(1_000);
		harness.setUsage({ input: 12 });

		const next = await harness.runtime.setGoal({ objective: "Second", tokenBudget: 20 });

		expect(next.goal.status).toBe("active");
		expect(next.goal.tokensUsed).toBe(15);
		expect(next.goal.timeUsedSeconds).toBe(1);
	});

	it("sets a fresh active goal over a paused goal", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "active",
				goal: createGoal({ objective: "Paused", status: "paused", tokenBudget: 100, tokensUsed: 30 }),
			},
		});

		const next = await harness.runtime.setGoal({ objective: "Second", tokenBudget: 25 });

		expect(next.enabled).toBe(true);
		expect(next.goal.objective).toBe("Second");
		expect(next.goal.status).toBe("budget-limited");
		expect(next.goal.tokenBudget).toBe(25);
		expect(next.goal.tokensUsed).toBe(30);
		expect(next.goal.timeUsedSeconds).toBe(0);
		expect(next.goal.id).not.toBe("goal-1");
		expect(harness.persists.at(-1)?.mode).toBe("goal");
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.customType).toBe("goal-budget-limit");
	});

	it("allows creating a new goal after the previous one is complete", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "exiting",
				reason: "completed",
				goal: createGoal({ status: "complete" }),
			},
		});

		const next = await harness.runtime.createGoal({ objective: "Phase 4" });
		expect(next.goal.objective).toBe("Phase 4");
		expect(next.goal.status).toBe("active");
		expect(next.enabled).toBe(true);
	});

	it("revalidates queued goal starts after acquiring runtime ownership", async () => {
		const completionFanout = Promise.withResolvers<void>();
		let blockCompletion = true;
		const harness = createHarness({
			state: { enabled: true, mode: "active", goal: createGoal() },
			onEmit: async () => {
				if (!blockCompletion) return;
				blockCompletion = false;
				await completionFanout.promise;
			},
		});
		const completing = harness.runtime.completeGoalFromTool();
		await Promise.resolve();
		let planActive = false;
		const queuedStart = harness.runtime.createGoal({ objective: "Next" }, () => {
			if (planActive) throw new Error("plan active");
		});
		planActive = true;
		completionFanout.resolve();

		await completing;
		await expect(queuedStart).rejects.toThrow("plan active");
		expect(harness.getState()?.goal.status).toBe("complete");
	});

	it("keeps an exhausted paused goal budget-limited when resumed", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "active",
				goal: createGoal({ status: "paused", tokenBudget: 20, tokensUsed: 20 }),
			},
		});

		const resumed = await harness.runtime.resumeGoal();
		expect(resumed.enabled).toBe(true);
		expect(resumed.goal.status).toBe("budget-limited");
		expect(harness.hiddenMessages).toHaveLength(1);
		expect(harness.hiddenMessages[0]?.customType).toBe("goal-budget-limit");
	});

	it("rejects resume when the current goal is not paused", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ status: "active" }),
			},
		});

		await expect(harness.runtime.resumeGoal()).rejects.toThrow("No paused goal.");
	});

	it("completeGoalFromTool succeeds for a paused goal (enabled=false)", async () => {
		const harness = createHarness({
			state: {
				enabled: false,
				mode: "active",
				goal: createGoal({ status: "paused", tokensUsed: 30, timeUsedSeconds: 5 }),
			},
		});

		const completed = await harness.runtime.completeGoalFromTool();
		expect(completed.status).toBe("complete");
		const state = harness.getState();
		expect(state?.enabled).toBe(false);
		expect(state?.mode).toBe("exiting");
		expect(state?.goal.status).toBe("complete");
	});
});

describe("goal pause/resume owner semantics and lifecycle non-regression", () => {
	it("pauseGoal on an active goal pauses and preserves accounting and budget", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ status: "active", tokenBudget: 100, tokensUsed: 30 }),
			},
			usage: createUsage({ input: 30, output: 0, cacheRead: 0, cacheWrite: 0 }),
		});
		const paused = await harness.runtime.pauseGoal("waiting for review");
		expect(paused?.enabled).toBe(false);
		expect(paused?.goal.status).toBe("paused");
		expect(paused?.goal.tokensUsed).toBe(30);
		expect(paused?.reason).toBe("waiting for review");
		expect(harness.persists.at(-1)?.mode).toBe("goal_paused");
	});

	it("lifecycle onThreadResumed still pauses an active goal (non-regression)", async () => {
		let state: GoalModeState | undefined = {
			enabled: true,
			mode: "active",
			goal: createGoal({ status: "active", tokensUsed: 10 }),
		};
		const usage = createUsage({ input: 10, output: 0, cacheRead: 0, cacheWrite: 0 });
		const host: GoalRuntimeHost = {
			getState: () => state && { ...state, goal: { ...state.goal } },
			setState: next => {
				state = next ? { ...next, goal: { ...next.goal } } : undefined;
			},
			getCurrentUsage: () => usage,
			emit: async () => {},
			persist: () => {},
			sendHiddenMessage: async () => {},
			now: () => 0,
		};
		const runtime = new GoalRuntime(host);
		const resumed = await runtime.onThreadResumed();
		expect(resumed?.enabled).toBe(false);
		expect(resumed?.goal.status).toBe("paused");
	});

	it("lifecycle onTaskAborted interrupted still pauses an active goal (non-regression)", async () => {
		let state: GoalModeState | undefined = {
			enabled: true,
			mode: "active",
			goal: createGoal({ status: "active", tokensUsed: 5 }),
		};
		const usage = createUsage({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0 });
		const host: GoalRuntimeHost = {
			getState: () => state && { ...state, goal: { ...state.goal } },
			setState: next => {
				state = next ? { ...next, goal: { ...next.goal } } : undefined;
			},
			getCurrentUsage: () => usage,
			emit: async () => {},
			persist: () => {},
			sendHiddenMessage: async () => {},
			now: () => 0,
		};
		const runtime = new GoalRuntime(host);
		await runtime.onTaskAborted({ reason: "interrupted" });
		expect(state?.goal.status).toBe("paused");
	});

	it("strict resume still rejects a goal that is not paused", async () => {
		const harness = createHarness({
			state: {
				enabled: true,
				mode: "active",
				goal: createGoal({ status: "active" }),
			},
		});
		await expect(harness.runtime.resumeGoal()).rejects.toThrow("No paused goal.");
	});
});

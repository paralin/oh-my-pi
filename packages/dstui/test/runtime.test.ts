import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { compileModule } from "../src/compiler";
import { type ComponentInstance, instantiate, instantiateComponentByName, type TimerClock } from "../src/runtime";

/** Manual clock that records `setInterval` calls and lets tests advance them. */
interface ManualClock extends TimerClock {
	fire(): void;
	readonly intervals: number[];
	readonly cleared: () => number;
}

function manualClock(): ManualClock {
	const handlers: Array<() => void> = [];
	const intervals: number[] = [];
	let cleared = 0;
	return {
		setInterval(handler, intervalMs) {
			intervals.push(intervalMs);
			handlers.push(handler);
			return (handlers.length - 1) as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval(_handle) {
			cleared += 1;
		},
		intervals,
		cleared: () => cleared,
		fire() {
			for (const fn of handlers) fn();
		},
	};
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("instantiate", () => {
	test("renders state and reacts to bound keys", () => {
		const module = compileModule(`
			(defcomponent counter ()
				(state (value 0))
				(view (text (str value)))
				(bind :right (set! value (+ value 1))))
		`);
		let renders = 0;
		const instance = instantiate(module.components[0], {}, module.views, {
			onRender: () => {
				renders += 1;
			},
		});
		expect(stripAnsi(instance.render(10)[0] ?? "")).toBe("0");
		instance.handleInput("\u001b[C");
		expect(stripAnsi(instance.render(10)[0] ?? "")).toBe("1");
		expect(renders).toBe(1);
		instance.dispose();
	});

	test("emit settles exactly once and tears down timers", () => {
		const clock = manualClock();
		const module = compileModule(`
			(defcomponent t ()
				(state (n 0))
				(view (text (str n)))
				(every 100 (set! n (+ n 1)))
				(bind :enter (emit n)))
		`);
		const settles: unknown[] = [];
		const instance = instantiate(module.components[0], {}, module.views, {
			clock,
			onSettled: ev => settles.push(ev),
		});
		expect(clock.intervals[0]).toBe(100);
		clock.fire();
		clock.fire();
		expect(instance.isSettled()).toBe(false);
		instance.handleInput("\r");
		// `n` advanced twice via timers, so the emitted value is 2.
		expect(settles).toEqual([{ reason: "emit", value: 2 }]);
		expect(clock.cleared()).toBe(1);
		// Re-emitting must not fire a second settle.
		instance.handleInput("\r");
		expect(settles.length).toBe(1);
		instance.dispose();
	});

	test("cancel on escape returns null and is idempotent", () => {
		const module = compileModule(`
			(defcomponent t ()
				(state (n 0))
				(view (text "hi"))
				(bind :enter (emit n)))
		`);
		const settles: unknown[] = [];
		const instance = instantiate(module.components[0], {}, module.views, {
			onSettled: ev => settles.push(ev),
		});
		instance.handleInput("\u001b");
		instance.handleInput("\u001b");
		expect(settles).toEqual([{ reason: "cancel", value: null }]);
		instance.dispose();
	});

	test("timer interval is clamped up to minTimerIntervalMs", () => {
		const clock = manualClock();
		const module = compileModule(`
			(defcomponent t ()
				(state (n 0))
				(view (text (str n)))
				(every 1 (set! n (+ n 1))))
		`);
		instantiate(module.components[0], {}, module.views, {
			clock,
			limits: { minTimerIntervalMs: 75 },
		});
		expect(clock.intervals[0]).toBe(75);
	});

	test("timer count above maxTimers throws at instantiation", () => {
		const module = compileModule(
			`
			(defcomponent t ()
				(state (n 0))
				(view (text (str n)))
				(every 100 (set! n 1))
				(every 100 (set! n 2))
				(every 100 (set! n 3)))
		`,
			{ limits: { maxTimers: 8 } },
		);
		expect(() => instantiate(module.components[0], {}, module.views, { limits: { maxTimers: 2 } })).toThrow();
	});

	test("config supports kebab/snake/camel aliases", () => {
		const module = compileModule(`
			(defcomponent t (selected-index)
				(state (idx (if selected-index selected-index 0)))
				(view (text (str idx))))
		`);
		const a = instantiate(module.components[0], { "selected-index": 7 }, module.views);
		expect(stripAnsi(a.render(10)[0] ?? "")).toBe("7");
		const b = instantiate(module.components[0], { selected_index: 5 }, module.views);
		expect(stripAnsi(b.render(10)[0] ?? "")).toBe("5");
		const c = instantiate(module.components[0], { selectedIndex: 9 }, module.views);
		expect(stripAnsi(c.render(10)[0] ?? "")).toBe("9");
	});

	test("instantiateComponentByName looks up by name", () => {
		const module = compileModule(`
			(defcomponent foo () (view (text "foo")) (bind :enter (emit 1)))
			(defcomponent bar () (view (text "bar")) (bind :enter (emit 2)))
		`);
		const instance = instantiateComponentByName(module, "bar", {});
		expect(stripAnsi(instance.render(10)[0] ?? "")).toBe("bar");
		instance.dispose();
		expect(() => instantiateComponentByName(module, "missing", {})).toThrow();
	});

	test("dispose is idempotent and stops further renders", () => {
		const module = compileModule(`(defcomponent t () (view (text "x")))`);
		const instance: ComponentInstance = instantiate(module.components[0], {}, module.views);
		expect(stripAnsi(instance.render(5)[0] ?? "")).toBe("x");
		instance.dispose();
		instance.dispose();
		expect(instance.render(5)).toEqual([]);
	});
});

describe("render", () => {
	let originalSetInterval: typeof setInterval;
	beforeEach(() => {
		originalSetInterval = globalThis.setInterval;
	});
	afterEach(() => {
		globalThis.setInterval = originalSetInterval;
	});

	test("each renders one row per item", () => {
		const module = compileModule(`
			(defcomponent t ()
				(state (items (list "a" "b" "c")))
				(view (each item items (text item))))
		`);
		const instance = instantiate(module.components[0], {}, module.views);
		const lines = instance.render(20).map(stripAnsi);
		expect(lines).toEqual(["a", "b", "c"]);
		instance.dispose();
	});

	test("output rows are capped by maxOutputRows", () => {
		const module = compileModule(`
			(defcomponent t ()
				(state (items (list 1 2 3 4 5 6 7 8 9 10)))
				(view (each item items (text (str item)))))
		`);
		const instance = instantiate(module.components[0], {}, module.views, {
			limits: { maxOutputRows: 3 },
		});
		expect(instance.render(20).length).toBe(3);
		instance.dispose();
	});
});

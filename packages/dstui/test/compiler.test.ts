import { describe, expect, test } from "bun:test";
import { compileModule } from "../src/compiler";
import { CompileError, CompileLimitError } from "../src/errors";

describe("compileModule", () => {
	test("compiles a defcomponent with state/view/bind/every", () => {
		const module = compileModule(`
			(defcomponent picker (title items)
				(state (cursor 0))
				(view (text title :accent))
				(bind :up (set! cursor (- cursor 1)))
				(every 250 (set! cursor cursor)))
		`);
		expect(module.components).toHaveLength(1);
		const comp = module.components[0];
		expect(comp.name).toBe("picker");
		expect(comp.params).toEqual(["title", "items"]);
		expect(comp.stateDefs).toHaveLength(1);
		expect(comp.bindings).toHaveLength(1);
		expect(comp.timers).toHaveLength(1);
	});

	test("compiles a defview", () => {
		const module = compileModule(`
			(defview row (focused label)
				(flex-row :gap 1
					(text (if focused ">" " "))
					(text label)))
		`);
		expect(module.views).toHaveLength(1);
		expect(module.views[0].name).toBe("row");
		expect(module.views[0].params).toEqual(["focused", "label"]);
	});

	test("rejects modules with neither defcomponent nor defview", () => {
		expect(() => compileModule(`(+ 1 2)`)).toThrow(CompileError);
	});

	test("rejects defcomponent without a name", () => {
		expect(() => compileModule(`(defcomponent (text "x"))`)).toThrow(CompileError);
	});

	test("rejects bind without a key", () => {
		expect(() => compileModule(`(defcomponent c () (view (text "x")) (bind))`)).toThrow(CompileError);
	});

	test("enforces maxBindings", () => {
		const binds: string[] = [];
		for (let i = 0; i < 12; i++) binds.push(`(bind :a (set! v ${i}))`);
		const source = `(defcomponent c () (state (v 0)) (view (text "")) ${binds.join("\n")})`;
		expect(() => compileModule(source, { limits: { maxBindings: 4 } })).toThrow(CompileLimitError);
	});

	test("enforces maxTimers", () => {
		const timers: string[] = [];
		for (let i = 0; i < 12; i++) timers.push(`(every 100 (set! v ${i}))`);
		const source = `(defcomponent c () (state (v 0)) (view (text "")) ${timers.join("\n")})`;
		expect(() => compileModule(source, { limits: { maxTimers: 4 } })).toThrow(CompileLimitError);
	});

	test("enforces maxComponentsPerModule", () => {
		const comps: string[] = [];
		for (let i = 0; i < 6; i++) comps.push(`(defcomponent c${i} () (view (text "")))`);
		expect(() => compileModule(comps.join("\n"), { limits: { maxComponentsPerModule: 2 } })).toThrow(
			CompileLimitError,
		);
	});

	test("rejects forbidden parameter names", () => {
		expect(() => compileModule(`(defcomponent c (__proto__) (view (text "")))`)).toThrow();
	});
});

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createSessionAskOwner } from "../../src/ask/session-owner";
import { type AskInput, askInputSchema, executeAsk } from "../../src/ask/structured";
import type { ToolSession } from "../../src/session/tool-session.js";
import { ToolAbortError } from "../../src/tools/tool-errors.js";

function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

function createAskExecution(session: ToolSession) {
	return (params: AskInput, signal: AbortSignal | undefined, context: AgentToolContext) =>
		executeAsk(createSessionAskOwner(session, context), params, signal);
}

function createContext(args: {
	select?: (
		prompt: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: {
			initialIndex?: number;
			timeout?: number;
			signal?: AbortSignal;
			outline?: boolean;
			onTimeout?: () => void;
			onLeft?: () => void;
			onRight?: () => void;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: readonly number[];
			markableCount?: number;
		},
	) => Promise<string | undefined>;
	editor?: (
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
		editorOptions?: { promptStyle?: boolean },
	) => Promise<string | undefined>;
	askDialog?: (
		questions: ExtensionAskDialogQuestion[],
		dialogOptions?: any,
	) => Promise<ExtensionAskDialogResult | undefined>;
	abort?: () => void;
}): AgentToolContext {
	// AgentToolContext includes many runtime fields; tests only need UI + abort behavior.
	return {
		hasUI: true,
		ui: {
			...(args.select ? { select: args.select } : {}),
			...(args.askDialog ? { askDialog: args.askDialog } : {}),
			editor: (
				title: string,
				prefill?: string,
				dialogOptions?: { signal?: AbortSignal },
				editorOptions?: { promptStyle?: boolean },
			) => args.editor?.(title, prefill, dialogOptions, editorOptions) ?? Promise.resolve(undefined),
		},
		abort: args.abort ?? (() => {}),
	} as unknown as AgentToolContext;
}

function selectItemLabel(option: ExtensionUISelectItem | undefined): string | undefined {
	return typeof option === "string" ? option : option?.label;
}

function stripAnsi(text: string): string {
	return stripVTControlCharacters(text);
}

beforeAll(async () => {
	await initTheme(false);
});

describe("Structured question cancellation", () => {
	it("aborts the turn when the user cancels selection", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			ask(
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("defaults to no timeout when ask.timeout is unset", async () => {
		// Regression for the surprise-auto-select report: a fresh install must let the user
		// deliberate indefinitely. The dialog timeout is opt-in via the `ask.timeout` setting.
		const ask = createAskExecution(createSession());
		const select = vi.fn(
			async (
				_prompt: string,
				options: ExtensionUISelectItem[],
				_dialogOptions?: { initialIndex?: number; timeout?: number },
			) => (typeof options[0] === "string" ? options[0] : options[0]?.label),
		);
		const context = createContext({ select });

		await ask(
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeUndefined();
	});

	it("still aborts when user explicitly cancels with timeout configured", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 30 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async () => undefined,
			abort,
		});

		expect(
			ask(
				{
					questions: [
						{
							id: "confirm",
							question: "Proceed?",
							options: [{ label: "yes" }, { label: "no" }],
						},
					],
				},
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
	it("auto-selects the recommended option on ask timeout", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const select = vi.fn(
			async (
				_prompt: string,
				options: ExtensionUISelectItem[],
				dialogOptions?: { initialIndex?: number; timeout?: number; onTimeout?: () => void },
			) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				const selected = options[dialogOptions?.initialIndex ?? 0];
				return typeof selected === "string" ? selected : selected?.label;
			},
		);
		const context = createContext({
			select,
			abort,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						recommended: 1,
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: no");
		expect(result.details?.selectedOptions).toEqual(["no"]);
		expect(abort).not.toHaveBeenCalled();
		expect(select).toHaveBeenCalledTimes(1);
		expect(select.mock.calls[0]?.[2]?.initialIndex).toBe(1);
		expect(select.mock.calls[0]?.[2]?.timeout).toBeGreaterThan(0);
	}, 30_000);

	it("auto-selects the first option when timeout elapses without a selected option", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return undefined;
			},
			abort,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(abort).not.toHaveBeenCalled();
	}, 30_000);

	it("routes custom input through editor with promptStyle after choosing Other", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(
			async (
				_title: string,
				_prefill?: string,
				_dialogOptions?: unknown,
				editorOptions?: { promptStyle?: boolean },
			) => {
				// Verify promptStyle is passed
				expect(editorOptions?.promptStyle).toBe(true);
				return "custom response";
			},
		);
		const select = vi.fn(async () => "Other (type your own)");
		const context = createContext({
			select,
			editor,
			abort,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("custom response");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(result.details?.customInput).toBe("custom response");
		expect((select.mock.calls[0] as unknown[])?.[2] as Record<string, unknown>).toHaveProperty("timeout");
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("does not enter custom input when timeout resolves to Other in multi-select", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		const abort = vi.fn();
		const editor = vi.fn(async () => "should-not-be-used");
		const context = createContext({
			select: async (_prompt, _options, dialogOptions) => {
				const timeout = dialogOptions?.timeout ?? 1;
				await Bun.sleep(timeout + 5);
				dialogOptions?.onTimeout?.();
				return "Other (type your own)";
			},
			editor,
			abort,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "confirm",
						question: "Proceed?",
						options: [{ label: "yes" }, { label: "no" }],
						multi: true,
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: yes");
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(editor).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	}, 30_000);

	it("aborts multi-question ask when any question is explicitly cancelled", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First")) return "one";
				return undefined;
			},
			abort,
		});

		await expect(
			ask(
				{
					questions: [
						{
							id: "first",
							question: "First",
							options: [{ label: "one" }, { label: "two" }],
						},
						{
							id: "second",
							question: "Second",
							options: [{ label: "alpha" }, { label: "beta" }],
						},
					],
				},
				undefined,
				context,
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(abort).toHaveBeenCalledTimes(1);
	});
});

describe("Structured question option descriptions", () => {
	it("passes descriptions to the selector while returning selected labels", async () => {
		const ask = createAskExecution(createSession());
		const select = vi.fn(async (_prompt: string, options: ExtensionUISelectItem[]) => {
			expect(options[0]).toEqual({
				label: "Use local credentials",
				description: "Authenticate with provider keys already configured under ~/.omp.",
			});
			expect(options[1]).toEqual({
				label: "Set up in terminal",
				description: "Launch the terminal setup flow to add credentials before continuing.",
			});
			const selected = options[1];
			return typeof selected === "string" ? selected : selected?.label;
		});
		const context = createContext({ select });

		const result = await ask(
			{
				questions: [
					{
						id: "auth",
						question: "How should authentication continue?",
						options: [
							{
								label: "Use local credentials",
								description: "Authenticate with provider keys already configured under ~/.omp.",
							},
							{
								label: "Set up in terminal",
								description: "Launch the terminal setup flow to add credentials before continuing.",
							},
						],
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: Set up in terminal");
		expect(result.details?.selectedOptions).toEqual(["Set up in terminal"]);
		expect(result.content[0].text).not.toContain("Launch the terminal setup flow");
		expect(result.details?.options).toEqual(["Use local credentials", "Set up in terminal"]);
	});

	it("forwards descriptions through multi-select and returns bare labels", async () => {
		const ask = createAskExecution(createSession());
		let step = 0;
		let firstOptions: ExtensionUISelectItem[] = [];
		const editor = vi.fn(async () => undefined);
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					firstOptions = options;
					step += 1;
					return selectItemLabel(options.find(o => selectItemLabel(o)?.endsWith("alpha")));
				}
				if (step === 1) {
					step += 1;
					return selectItemLabel(options.find(o => selectItemLabel(o)?.endsWith("beta")));
				}
				return selectItemLabel(options.find(o => selectItemLabel(o)?.includes("Done selecting")));
			},
			editor,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [
							{ label: "alpha", description: "First choice detail." },
							{ label: "beta", description: "Second choice detail." },
						],
						multi: true,
					},
				],
			},
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha", "beta"]);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: alpha, beta");
		expect(result.content[0].text).not.toContain("First choice detail");
		const alphaOption = firstOptions.find(o => selectItemLabel(o)?.endsWith("alpha"));
		expect(typeof alphaOption === "object" ? alphaOption.description : undefined).toBe("First choice detail.");
	});
});

describe("Structured question custom input", () => {
	it("routes custom input through editor and preserves raw multiline strings", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const multilineText = "first line\nsecond line";
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toBe("User provided custom input:\n  first line\n  second line");
		expect(result.details?.customInput).toBe(multilineText);
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});
	it("keeps question context visible while entering Other custom input", async () => {
		const ask = createAskExecution(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no", description: "Skip the optional detail." }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		await ask({ questions }, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		expect(title).toContain("Share details");
		expect(title).toContain("yes");
		expect(title).toContain("no");
		expect(title).toContain("Skip the optional detail.");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("Enter your response:");
	});

	it("caps Other editor context for long option lists with long descriptions", async () => {
		const ask = createAskExecution(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const longDescription = "x".repeat(400);
		const optionCount = 20;
		const options = Array.from({ length: optionCount }, (_, i) => ({
			label: `option-${i}`,
			description: longDescription,
		}));
		const questions = [{ id: "pick", question: "Pick one", options }];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
		});

		await ask({ questions }, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		const lineCount = title.split("\n").length;
		// Cap is 8 option rows + their (single-line) descriptions + chrome; far below
		// 20 options × (label + multi-line description) the unbounded path would emit.
		expect(lineCount).toBeLessThanOrEqual(22);
		expect(title).toContain("Pick one");
		expect(title).toContain("option-0");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
		// Descriptions are flattened to a single line and truncated.
		expect(title).not.toContain("x".repeat(400));
		// Every option-row description must fit on one line.
		for (const line of title.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(160);
		}
	});

	it("keeps user-checked options visible in capped multi-select context", async () => {
		const ask = createAskExecution(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `opt-${i}` }));
		const questions = [{ id: "pick", question: "Multi pick", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				call += 1;
				if (call === 1) return selectItemLabel(opts.find(o => selectItemLabel(o) === "opt-12"));
				if (call === 2) return selectItemLabel(opts.find(o => selectItemLabel(o) === "opt-17"));
				return "Other (type your own)";
			},
			editor,
		});

		await ask({ questions }, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		// Checked options must survive the window so the user sees what they had
		// already toggled before switching to Other.
		expect(title).toContain("opt-12");
		expect(title).toContain("opt-17");
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
	});

	it("summarizes excess checked options instead of exceeding the context cap", async () => {
		const ask = createAskExecution(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const options = Array.from({ length: 20 }, (_, i) => ({ label: `checked-${i}` }));
		const questions = [{ id: "pick", question: "Pick many", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				if (call < 12) {
					const label = `checked-${call}`;
					call += 1;
					return selectItemLabel(opts.find(o => selectItemLabel(o) === label));
				}
				return "Other (type your own)";
			},
			editor,
		});

		await ask({ questions }, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		const optionRows = title
			.split("\n")
			.filter(line => line.includes("checked-") || line.includes("Other (type your own)"));
		expect(optionRows.length).toBeLessThanOrEqual(8);
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("checked");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
	});

	it("keeps sparse checked gap markers within the Other title budget", async () => {
		const ask = createAskExecution(createSession());
		const editor = vi.fn(async (_title: string) => "custom");
		const checkedLabels = [10, 20, 30, 40, 50, 60].map(i => `opt-${i}`);
		const options = Array.from({ length: 61 }, (_, i) => ({ label: `opt-${i}` }));
		const questions = [{ id: "pick", question: "Pick sparse", options, multi: true }];
		let call = 0;
		const context = createContext({
			select: async (_prompt, opts) => {
				const next = checkedLabels[call++];
				return next ? selectItemLabel(opts.find(o => selectItemLabel(o) === next)) : "Other (type your own)";
			},
			editor,
		});

		await ask({ questions }, undefined, context);

		const title = editor.mock.calls[0]?.[0] ?? "";
		expect(title.split("\n").length).toBeLessThanOrEqual(16);
		expect(title).toContain("Other (type your own)");
		expect(title).toContain("more option");
		expect(title).toContain("Enter your response:");
	});

	it("enforces total title row budget under narrow terminals", async () => {
		const originalColumns = process.stdout.columns;
		// Force an 80-wide terminal so long descriptions would wrap to multiple
		// rendered rows without per-line width truncation + total row budget.
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
		try {
			const ask = createAskExecution(createSession());
			const editor = vi.fn(async (_title: string) => "custom");
			const longDescription = "x".repeat(400);
			const options = Array.from({ length: 8 }, (_, i) => ({
				label: `option-${i}`,
				description: longDescription,
			}));
			const questions = [{ id: "pick", question: "Pick one", options }];
			const context = createContext({
				select: async () => "Other (type your own)",
				editor,
			});

			await ask({ questions }, undefined, context);

			const title = editor.mock.calls[0]?.[0] ?? "";
			const lines = title.split("\n");
			// 16-row hard budget keeps the input row + hint reachable on 80x24.
			expect(lines.length).toBeLessThanOrEqual(16);
			// Every emitted line must fit on a single 80-cell row after truncation.
			for (const line of lines) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
			}
			expect(title).toContain("Pick one");
			expect(title).toContain("Other (type your own)");
			expect(title).toContain("Enter your response:");
			expect(title).not.toContain("x".repeat(400));
		} finally {
			if (originalColumns === undefined) {
				Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			} else {
				Object.defineProperty(process.stdout, "columns", { value: originalColumns, configurable: true });
			}
		}
	});

	it("returns to the option selector when custom input is dismissed in single-question flow", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		let selectCalls = 0;
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => {
				selectCalls += 1;
				return selectCalls === 1 ? "Other (type your own)" : "yes";
			},
			editor,
			abort,
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.details?.selectedOptions).toEqual(["yes"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(selectCalls).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("returns to the option selector when custom input is dismissed in multi-question flow", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => undefined);
		let detailsVisits = 0;
		const questions = [
			{
				id: "first",
				question: "First?",
				options: [{ label: "one" }, { label: "two" }],
			},
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
		];
		const context = createContext({
			select: async prompt => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Details?")) {
					detailsVisits += 1;
					return detailsVisits === 1 ? "Other (type your own)" : "short";
				}
				return undefined;
			},
			editor,
			abort,
		});

		const result = await ask({ questions }, undefined, context);

		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["short"]);
		expect(result.details?.results?.[1]?.customInput).toBeUndefined();
		expect(detailsVisits).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("surfaces external abort during editor mode as ToolAbortError", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const controller = new AbortController();
		const editor = vi.fn(async (_title: string, _prefill?: string, dialogOptions?: { signal?: AbortSignal }) => {
			expect(dialogOptions?.signal).toBe(controller.signal);
			return await new Promise<string | undefined>((_resolve, reject) => {
				dialogOptions?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
				queueMicrotask(() => controller.abort());
			});
		});
		const questions = [
			{
				id: "details",
				question: "Share details",
				options: [{ label: "yes" }, { label: "no" }],
			},
		];
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		await expect(ask({ questions }, controller.signal, context)).rejects.toBeInstanceOf(ToolAbortError);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("treats explicit empty-string custom input as submitted input", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const editor = vi.fn(async () => "");
		const context = createContext({
			select: async () => "Other (type your own)",
			editor,
			abort,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "details",
						question: "Share details",
						options: [{ label: "yes" }, { label: "no" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User provided custom input:");
		expect(result.details?.customInput).toBe("");
		expect(result.details?.selectedOptions).toEqual([]);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});

	it("returns to the option selector when multi-select custom input is dismissed", async () => {
		const ask = createAskExecution(createSession());
		let step = 0;
		const editor = vi.fn(async () => undefined);
		const context = createContext({
			select: async (_prompt, options) => {
				if (step === 0) {
					step += 1;
					const alphaOption = options.find(option => selectItemLabel(option)?.endsWith("alpha"));
					if (!alphaOption) throw new Error("Missing alpha option");
					return selectItemLabel(alphaOption);
				}
				if (step === 1) {
					step += 1;
					return "Other (type your own)";
				}
				const doneOption = options.find(option => selectItemLabel(option)?.includes("Done selecting"));
				if (!doneOption) throw new Error("Missing done option");
				return selectItemLabel(doneOption);
			},
			editor,
		});

		const result = await ask(
			{
				questions: [
					{
						id: "multi",
						question: "Pick answers",
						options: [{ label: "alpha" }, { label: "beta" }],
						multi: true,
					},
				],
			},
			undefined,
			context,
		);

		expect(result.details?.selectedOptions).toEqual(["alpha"]);
		expect(result.details?.customInput).toBeUndefined();
		expect(result.content[0]?.type).toBe("text");
		if (result.content[0]?.type !== "text") {
			throw new Error("Expected text result");
		}
		expect(result.content[0].text).toContain("User selected: alpha");
		expect(step).toBe(2);
		expect(editor).toHaveBeenCalledTimes(1);
	});
});

describe("Structured question multiline custom input", () => {});

describe("Structured question multi-question navigation", () => {
	const questions = [
		{
			id: "first",
			question: "First?",
			options: [{ label: "one" }, { label: "two" }],
		},
		{
			id: "second",
			question: "Second?",
			options: [{ label: "alpha" }, { label: "beta" }],
		},
		{
			id: "third",
			question: "Third?",
			options: [{ label: "red" }, { label: "blue" }],
		},
	];

	it("keeps back unavailable on the first question and supports returning from later questions", async () => {
		const ask = createAskExecution(createSession());
		const firstQuestionOptions: ExtensionUISelectItem[][] = [];
		let firstVisits = 0;
		let secondVisits = 0;
		const context = createContext({
			select: async (prompt, options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstQuestionOptions.push(options);
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "alpha";
				}
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
		expect(firstQuestionOptions[0]).not.toContain("← Back");
		expect(firstQuestionOptions[1]).not.toContain("← Back");
	});

	it("allows forward action on the last question", async () => {
		const ask = createAskExecution(createSession());
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) return "alpha";
				dialogOptions?.onRight?.();
				return undefined;
			},
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
		expect(result.details?.results?.[2]?.customInput).toBeUndefined();
	});

	it("persists state when changing an earlier answer and continuing", async () => {
		const ask = createAskExecution(createSession());
		let firstVisits = 0;
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) {
					firstVisits += 1;
					if (firstVisits === 1) return "one";
					return "two";
				}
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) return "alpha";
					if (secondVisits === 2) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["two"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["alpha"]);
	});

	it("handles timeout with navigation and allows revisiting timed-out questions", async () => {
		const ask = createAskExecution(
			createSession({
				settings: Settings.isolated({ "ask.timeout": 0.001 }),
			}),
		);
		let secondVisits = 0;
		let thirdVisits = 0;
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("First?")) return "one";
				if (prompt.includes("Second?")) {
					secondVisits += 1;
					if (secondVisits === 1) {
						await Bun.sleep(5);
						dialogOptions?.onTimeout?.();
						return undefined;
					}
					return "beta";
				}
				if (prompt.includes("Third?")) {
					thirdVisits += 1;
					if (thirdVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					dialogOptions?.onRight?.();
					return undefined;
				}
				return undefined;
			},
		});

		const result = await ask({ questions }, undefined, context);
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["one"]);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["beta"]);
		expect(result.details?.results?.[2]?.selectedOptions).toEqual([]);
	}, 30_000);
	it("preserves custom input when navigating back and forward", async () => {
		const ask = createAskExecution(createSession());
		const multilineText = "line 1\nline 2";
		let detailVisits = 0;
		let summaryVisits = 0;
		const editor = vi.fn(async () => multilineText);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					summaryVisits += 1;
					if (summaryVisits === 1) {
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await ask({ questions }, undefined, context);

		expect(result.details?.results?.[0]?.customInput).toBe(multilineText);
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});

	it("preserves prior single-select answer when custom editor is dismissed during navigation", async () => {
		const ask = createAskExecution(createSession());
		let detailVisits = 0;
		const editor = vi.fn(async () => undefined);
		const questions = [
			{
				id: "details",
				question: "Details?",
				options: [{ label: "short" }, { label: "long" }],
			},
			{
				id: "summary",
				question: "Summary?",
				options: [{ label: "one" }, { label: "two" }],
			},
		];
		const context = createContext({
			select: async (prompt, _options, dialogOptions) => {
				if (prompt.includes("Details?")) {
					detailVisits += 1;
					if (detailVisits === 1) return "short";
					// Second visit: try Other then dismiss editor, then forward
					if (detailVisits === 2) return "Other (type your own)";
					dialogOptions?.onRight?.();
					return undefined;
				}
				if (prompt.includes("Summary?")) {
					const summaryVisit = detailVisits;
					if (summaryVisit <= 2) {
						// Navigate back to re-visit details
						dialogOptions?.onLeft?.();
						return undefined;
					}
					return "two";
				}
				return undefined;
			},
			editor,
		});

		const result = await ask({ questions }, undefined, context);

		// The prior selection "short" should survive the editor dismiss
		expect(result.details?.results?.[0]?.selectedOptions).toEqual(["short"]);
		expect(result.details?.results?.[0]?.customInput).toBeUndefined();
		expect(result.details?.results?.[1]?.selectedOptions).toEqual(["two"]);
		expect(editor).toHaveBeenCalledTimes(1);
	});
});

describe("Structured question rich ask dialog", () => {
	it("accepts new schema fields (header, preview, note) and maps them into AskDetails", async () => {
		const ask = createAskExecution(createSession());
		const askDialog = vi.fn().mockResolvedValue({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Q1?",
					options: ["Option A"],
					multi: false,
					selectedOptions: ["Option A"],
					note: "My Custom Note",
					timedOut: undefined,
				},
			],
		});
		const context = createContext({ askDialog });

		const result = await ask(
			{
				questions: [
					{
						id: "q1",
						question: "Q1?",
						header: "Chip Header",
						options: [{ label: "Option A", preview: "My Preview" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(askDialog).toHaveBeenCalledTimes(1);
		// Check that header and preview were forwarded
		expect(askDialog.mock.calls[0][0]).toEqual([
			{
				id: "q1",
				question: "Q1?",
				header: "Chip Header",
				options: [{ label: "Option A", preview: "My Preview" }],
			},
		]);

		// Verify result contains details with note mapping
		expect(result.details).toEqual({
			question: "Q1?",
			options: ["Option A"],
			multi: false,
			selectedOptions: ["Option A"],
			customInput: undefined,
			note: "My Custom Note",
			timedOut: undefined,
		});
	});

	it("aborts and throws ToolAbortError when askDialog returns undefined", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const askDialog = vi.fn().mockResolvedValue(undefined);
		const context = createContext({ askDialog, abort });

		await expect(
			ask(
				{
					questions: [{ id: "q1", question: "Q1?", options: [{ label: "Option A" }] }],
				},
				undefined,
				context,
			),
		).rejects.toThrow(ToolAbortError);

		expect(abort).toHaveBeenCalledTimes(1);
	});

	it("returns chat redirect result when askDialog returns kind chat", async () => {
		const ask = createAskExecution(createSession());
		const abort = vi.fn();
		const askDialog = vi.fn().mockResolvedValue({ kind: "chat" });
		const context = createContext({ askDialog, abort });

		const result = await ask(
			{
				questions: [{ id: "q1", question: "Q1?", options: [{ label: "Option A" }] }],
			},
			undefined,
			context,
		);

		expect(abort).not.toHaveBeenCalled();
		expect(result.details).toEqual({ chatRedirect: true, questions: ["Q1?"] });
		expect(result.content[0]?.type).toBe("text");
		expect((result.content[0] as { text: string }).text).toContain("chat about this");
	});

	it("ignores preview and header in degraded select path", async () => {
		const ask = createAskExecution(createSession());
		const select = vi.fn().mockResolvedValue("Option A");
		const context = createContext({ select });

		await ask(
			{
				questions: [
					{
						id: "q1",
						question: "Q1?",
						header: "Chip Header",
						options: [{ label: "Option A", description: "Desc A", preview: "My Preview" }],
					},
				],
			},
			undefined,
			context,
		);

		expect(select).toHaveBeenCalledTimes(1);
		// verify preview/header are NOT forwarded to select options
		expect(select.mock.calls[0][1]).toEqual([{ label: "Option A", description: "Desc A" }, "Other (type your own)"]);
	});

	it("rejects reserved-label collisions in structured input", () => {
		const valid = askInputSchema({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "ok" }] }],
		});
		expect(valid instanceof type.errors).toBe(false);

		const reservedOther = askInputSchema({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Other (type your own)" }] }],
		});
		expect(reservedOther instanceof type.errors).toBe(true);

		const reservedChat = askInputSchema({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Chat about this" }] }],
		});
		expect(reservedChat instanceof type.errors).toBe(true);

		const reservedNext = askInputSchema({
			questions: [{ id: "q1", question: "Q?", options: [{ label: "Next →" }] }],
		});
		expect(reservedNext instanceof type.errors).toBe(true);
	});
});

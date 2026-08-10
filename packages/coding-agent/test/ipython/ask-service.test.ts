import { describe, expect, test } from "bun:test";
import type { AskOwner } from "../../src/ask/structured";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
} from "../../src/extensibility/extensions";
import { IpythonAskService } from "../../src/ipython/ask-service";
import type { IpythonHostRequest } from "../../src/ipython/controller";
import { ToolAbortError } from "../../src/tools/tool-errors";

function hostRequest(data: Readonly<Record<string, unknown>>, signal = new AbortController().signal) {
	const progress: string[] = [];
	const request: IpythonHostRequest = {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data: { type: "ask.questions", ...data },
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
			throw new Error("ask does not allocate artifacts");
		},
	};
	return { request, progress };
}

function richOwner(options: {
	result: ExtensionAskDialogResult | undefined;
	capture?: (questions: ExtensionAskDialogQuestion[], signal?: AbortSignal) => void;
	abort?: () => void;
}): AskOwner {
	const ui = {
		askDialog: async (questions: ExtensionAskDialogQuestion[], dialog?: { signal?: AbortSignal }) => {
			options.capture?.(questions, dialog?.signal);
			return options.result;
		},
	} as unknown as ExtensionUIContext;
	return {
		hasUI: true,
		ui,
		timeoutSeconds: () => 0,
		notify: () => {},
		speak: () => {},
		abort: options.abort ?? (() => {}),
	};
}

const structuredQuestions = [
	{
		id: "runtime",
		question: "Choose a runtime",
		header: "Runtime",
		options: [
			{ label: "Python", description: "Persistent kernel", preview: "# Python preview" },
			{ label: "Bun", description: "Host runtime" },
		],
		multi: true,
		recommended: 0,
	},
];

describe("IPython ask service", () => {
	test("forwards recommendation, multi-select, descriptions, previews, and active cancellation", async () => {
		let captured: ExtensionAskDialogQuestion[] | undefined;
		let capturedSignal: AbortSignal | undefined;
		const owner = richOwner({
			result: {
				kind: "submit",
				results: [
					{
						id: "runtime",
						question: "Choose a runtime",
						options: ["Python", "Bun"],
						multi: true,
						selectedOptions: ["Python", "Bun"],
						note: "Keep both",
					},
				],
			},
			capture: (questions, signal) => {
				captured = questions;
				capturedSignal = signal;
			},
		});
		const service = new IpythonAskService({ owner: () => owner });
		const active = hostRequest({ questions: structuredQuestions });
		const result = await service.handlers["ask.questions"]!(active.request);
		expect(captured).toEqual(structuredQuestions);
		expect(capturedSignal).toBe(active.request.signal);
		expect(result).toEqual({
			question: "Choose a runtime",
			options: ["Python", "Bun"],
			multi: true,
			selectedOptions: ["Python", "Bun"],
			customInput: undefined,
			note: "Keep both",
			timedOut: undefined,
		});
		expect(active.progress).toEqual(["Ask questions started", "Ask questions completed"]);
	});

	test("returns ordered multi-question results and chat redirect", async () => {
		const questions = [
			{ id: "first", question: "First?", options: [{ label: "A" }] },
			{ id: "second", question: "Second?", options: [{ label: "B" }] },
		];
		const submit = new IpythonAskService({
			owner: () =>
				richOwner({
					result: {
						kind: "submit",
						results: questions.map(question => ({
							...question,
							options: question.options.map(option => option.label),
							multi: false,
							selectedOptions: [question.options[0]!.label],
						})),
					},
				}),
		});
		const active = hostRequest({ questions });
		const result = await submit.handlers["ask.questions"]!(active.request);
		expect((result.results as Array<{ id: string }>).map(item => item.id)).toEqual(["first", "second"]);

		const chat = new IpythonAskService({ owner: () => richOwner({ result: { kind: "chat" } }) });
		const redirected = await chat.handlers["ask.questions"]!(hostRequest({ questions }).request);
		expect(redirected).toEqual({ chatRedirect: true, questions: ["First?", "Second?"] });
	});

	test("rejects unknown fields, invalid recommendations, and count bounds before resolving UI", async () => {
		let resolutions = 0;
		const service = new IpythonAskService({
			owner: () => {
				resolutions++;
				return richOwner({ result: { kind: "chat" } });
			},
		});
		await expect(
			service.handlers["ask.questions"]!(hostRequest({ questions: structuredQuestions, surprise: true }).request),
		).rejects.toThrow("unknown field: surprise");
		await expect(
			service.handlers["ask.questions"]!(
				hostRequest({ questions: [{ ...structuredQuestions[0], recommended: 3 }] }).request,
			),
		).rejects.toThrow("recommended must be an in-range integer");
		await expect(
			service.handlers["ask.questions"]!(
				hostRequest({ questions: [structuredQuestions[0], structuredQuestions[0]] }).request,
			),
		).rejects.toThrow("id must be unique");
		await expect(
			service.handlers["ask.questions"]!(
				hostRequest({
					questions: [{ ...structuredQuestions[0], options: [{ label: "Other (type your own)" }] }],
				}).request,
			),
		).rejects.toThrow("reserved option label");
		await expect(
			service.handlers["ask.questions"]!(
				hostRequest({ questions: Array.from({ length: 33 }, () => structuredQuestions[0]) }).request,
			),
		).rejects.toThrow("1 through 32");
		expect(resolutions).toBe(0);
	});

	test("propagates active cancellation before resolving UI", async () => {
		let resolutions = 0;
		const service = new IpythonAskService({
			owner: () => {
				resolutions++;
				return richOwner({ result: { kind: "chat" } });
			},
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const active = hostRequest({ questions: structuredQuestions }, controller.signal);
		await expect(service.handlers["ask.questions"]!(active.request)).rejects.toThrow("cancelled");
		expect(resolutions).toBe(0);
	});

	test("fails immediately when no interactive UI is available", async () => {
		let aborted = false;
		const owner: AskOwner = {
			hasUI: false,
			timeoutSeconds: () => 0,
			notify: () => {},
			speak: () => {},
			abort: () => {
				aborted = true;
			},
		};
		const service = new IpythonAskService({ owner: () => owner });
		const active = hostRequest({ questions: structuredQuestions });
		await expect(service.handlers["ask.questions"]!(active.request)).rejects.toBeInstanceOf(ToolAbortError);
		expect(aborted).toBe(true);
	});
});

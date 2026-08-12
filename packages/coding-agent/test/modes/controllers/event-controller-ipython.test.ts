import { beforeAll, describe, expect, test, vi } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import type { IpythonCompletedCellPresentation, IpythonLiveCellPresentation } from "../../../src/ipython/projection";
import { TranscriptContainer } from "../../../src/modes/components/transcript-container";
import { EventController } from "../../../src/modes/controllers/event-controller";
import { initTheme } from "../../../src/modes/theme/theme";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { vocalizer } from "../../../src/tts/vocalizer";

beforeAll(() => initTheme());

function live(text: string, updates: IpythonLiveCellPresentation["updates"]): IpythonLiveCellPresentation {
	return {
		kind: "cell",
		phase: "live",
		cellId: "cell-ui",
		origin: "model",
		code: "print('early'); print('late')",
		status: "running",
		events: updates.flatMap(update => (update.kind === "execution" ? [update.event] : [])),
		errors: [],
		updates,
		startupProgress: [],
		safeText: { text, truncated: false, totalBytes: Buffer.byteLength(text), outputBytes: Buffer.byteLength(text) },
		artifacts: [],
	};
}

describe("EventController IPython projection", () => {
	test("updates one live cell component and completes it from the terminal presentation", async () => {
		const chatContainer = new TranscriptContainer();
		const requestRender = vi.fn();
		const getIpythonMimeRenderer = vi.fn((mimeType: string) =>
			mimeType === "application/vnd.example+json" ? () => new Text("rich-rendered", 0, 0) : undefined,
		);
		const ctx = {
			isInitialized: true,
			viewSession: { isStreaming: false, getIpythonMimeRenderer },
			chatContainer,
			ui: { requestRender },
			toolOutputExpanded: false,
			statusLine: { invalidate() {} },
			settings: { get: () => false },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
		} as unknown as InteractiveModeContext;
		const pushDelta = vi.spyOn(vocalizer, "pushDelta").mockImplementation(() => {});
		const controller = new EventController(ctx);
		const firstUpdate = {
			kind: "execution" as const,
			cellId: "cell-ui",
			origin: "model" as const,
			event: { kind: "stream" as const, name: "stdout" as const, text: "early\n" },
		};
		const secondUpdate = {
			kind: "execution" as const,
			cellId: "cell-ui",
			origin: "model" as const,
			event: { kind: "stream" as const, name: "stdout" as const, text: "late\n" },
		};
		const richUpdate = {
			kind: "execution" as const,
			cellId: "cell-ui",
			origin: "model" as const,
			event: {
				kind: "display" as const,
				data: { "application/vnd.example+json": { value: 42 }, "text/html": "<script>unsafe()</script>" },
				metadata: {},
				transient: {},
				text: "[rich output]",
				update: false,
			},
		};
		await controller.handleEvent({ type: "ipython_cell_start", presentation: live("early\n", [firstUpdate]) });
		await controller.handleEvent({
			type: "ipython_cell_update",
			presentation: live("early\nlate\n[rich output]\n", [firstUpdate, secondUpdate, richUpdate]),
		});
		expect(chatContainer.children).toHaveLength(1);
		const running = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(running).toContain("early");
		expect(running).toContain("late");

		const complete = {
			...live("early\nlate\n[rich output]\n", [firstUpdate, secondUpdate, richUpdate]),
			phase: "complete",
			cellId: "cell-ui",
			executionId: "execute-ui",
			sequence: 3,
			authority: "trusted-cell",
			status: "ok",
			requestedAt: 1,
			startedAt: 2,
			finishedAt: 4,
			durationMs: 2,
			stdout: "early\nlate\n",
			stderr: "",
			result: undefined,
			artifacts: [{ path: "/tmp/result.txt", mimeType: "text/plain", bytes: 11, label: "result" }],
		} satisfies IpythonCompletedCellPresentation;
		await controller.handleEvent({ type: "ipython_cell_end", presentation: complete });
		const rendered = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(chatContainer.children).toHaveLength(1);
		expect(rendered).toContain("In [3]");
		expect(rendered).not.toContain("completed");
		expect(rendered).toContain("early");
		expect(rendered).toContain("late");
		expect(rendered).toContain("[rich output]");
		expect(rendered).not.toContain("rich-rendered");
		expect(rendered).not.toContain("<script>");
		expect(getIpythonMimeRenderer).not.toHaveBeenCalled();
		const cell = chatContainer.children[0] as unknown as { setExpanded(expanded: boolean): void };
		cell.setExpanded(true);
		const expanded = Bun.stripANSI(chatContainer.render(100).join("\n"));
		expect(expanded).toContain("rich-rendered");
		expect(expanded).not.toContain("<script>");
		expect(getIpythonMimeRenderer).toHaveBeenCalledWith("application/vnd.example+json");
		expect(requestRender).toHaveBeenCalledTimes(3);
		expect(pushDelta).not.toHaveBeenCalled();
		controller.dispose();
		vi.restoreAllMocks();
	});
	test("renders ordered Act progress inside the directing cell without a separate heap card", async () => {
		const chatContainer = new TranscriptContainer();
		const ctx = {
			isInitialized: true,
			viewSession: { isStreaming: false },
			chatContainer,
			ui: { requestRender() {} },
			toolOutputExpanded: true,
			statusLine: { invalidate() {} },
			settings: { get: () => false },
			effectiveHideThinkingBlock: false,
			proseOnlyThinking: false,
		} as unknown as InteractiveModeContext;
		const controller = new EventController(ctx);
		const base = { type: "act_event" as const, actId: "act-ui", outerToolCallId: "cell-ui", sequence: 1 };
		await controller.handleEvent({
			...base,
			event: "start",
			prompt: "private prompt",
			promptTruncated: false,
			model: { provider: "test", id: "actor", name: "Actor" },
			cancellationCapability: "posix-managed",
		});
		await controller.handleEvent({ type: "ipython_cell_start", presentation: live("", []) });
		await controller.handleEvent({
			...base,
			sequence: 2,
			event: "assistant_delta",
			stream: "text",
			text: "I will inspect the live object",
			textTruncated: false,
		});
		await controller.handleEvent({
			...base,
			sequence: 3,
			event: "cell_start",
			cellId: "act-cell",
			code: "observed = shared_value + 1",
			codeTruncated: false,
		});
		await controller.handleEvent({
			...base,
			sequence: 4,
			event: "cell_terminal",
			cellId: "act-cell",
			status: "ok",
			stdout: "42",
			stdoutTruncated: false,
			stderr: "",
			stderrTruncated: false,
			result: "42",
			resultTruncated: false,
			errorTruncated: false,
		});
		await controller.handleEvent({
			...base,
			sequence: 5,
			event: "terminal",
			status: "done",
			prompt: "private prompt",
			promptTruncated: false,
			model: { provider: "test", id: "actor", name: "Actor" },
			cancellationCapability: "posix-managed",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			errorTruncated: false,
		});
		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Act · Actor · running");
		expect(rendered).toContain("I will inspect the live object");
		expect(rendered).toContain("observed = shared_value + 1");
		expect(rendered).toContain("cell act-cell · ok · 42 · 42");
		expect(rendered).toContain("Act · done");
		expect(rendered).not.toContain("private prompt");
		controller.dispose();
	});
});

import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { IpythonCellJournalDetail } from "@oh-my-pi/pi-coding-agent/ipython/journal";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function createRuntimeHarness(messages: AgentMessage[], cells: readonly IpythonCellJournalDetail[] = []) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showCopySelector = vi.fn();
	return {
		setText,
		showStatus,
		showWarning,
		showCopySelector,
		runtime: {
			ctx: {
				session: { messages, getIpythonCellJournalDetails: () => cells },
				editor: { setText },
				showStatus,
				showWarning,
				showCopySelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/copy slash command", () => {
	it("copies the last assistant code block without opening the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([
			assistantText("old\n```ts\nconst oldValue = 1;\n```"),
			assistantText("new\n```sh\necho first\n```\n```py\nprint('last')\n```"),
		]);

		expect(await executeBuiltinSlashCommand("/copy code", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("print('last')");
		expect(harness.showStatus).toHaveBeenCalledWith("Copied code block to clipboard");
		expect(harness.showCopySelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("copies replayed IPython code when no assistant code block exists", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const cell = {
			version: 1,
			kind: "cell",
			cellId: "cell-slash",
			executionId: "execution-slash",
			sequence: 1,
			origin: "direct",
			authority: "trusted-cell",
			code: "print('from cell')",
			status: "ok",
			requestedAt: 1,
			startedAt: 2,
			finishedAt: 3,
			durationMs: 1,
			stdout: "from cell\n",
			stderr: "",
			result: undefined,
			events: [],
			errors: [],
			updates: [],
			safeText: "from cell\n",
			safeTextTruncated: false,
			totalOutputBytes: 10,
			artifacts: [],
		} satisfies IpythonCellJournalDetail;
		const harness = createRuntimeHarness([assistantText("no fenced code")], [cell]);

		expect(await executeBuiltinSlashCommand("/copy code", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("print('from cell')");
		expect(harness.showStatus).toHaveBeenCalledWith("Copied IPython cell code to clipboard");
		expect(harness.showCopySelector).not.toHaveBeenCalled();
	});

	it("keeps bare /copy on the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("answer")]);

		expect(await executeBuiltinSlashCommand("/copy", harness.runtime)).toBe(true);

		expect(harness.showCopySelector).toHaveBeenCalledTimes(1);
		expect(copySpy).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

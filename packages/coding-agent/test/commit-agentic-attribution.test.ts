import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runCommitAgentSession } from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

function commitModel() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Expected claude-sonnet-4-5 model to exist");
	}
	return model;
}

describe("commit agent IPython proposal contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("marks generated commit prompts and reminders as agent-attributed when fallback remains necessary", async () => {
		const prompts: Array<{ text: string; options?: PromptOptions }> = [];
		const session = {
			prompt: async (text: string, options?: PromptOptions) => {
				prompts.push({ text, options });
			},
			subscribe: () => () => {},
			dispose: async () => {},
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);

		const state = await runCommitAgentSession({
			cwd: "/tmp",
			model: commitModel(),
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
		});

		expect(state.proposal).toBeUndefined();
		expect(prompts).toHaveLength(4);
		for (const prompt of prompts) {
			expect(prompt.options?.attribution).toBe("agent");
			expect(prompt.options?.expandPromptTemplates).toBe(false);
		}
	});

	it("uses only IPython and populates state from the final JSON proposal", async () => {
		let eventHandler: ((event: AgentSessionEvent) => void) | undefined;
		let sessionOptions: Parameters<typeof sdkModule.createAgentSession>[0] | undefined;
		const prompts: string[] = [];
		const session = {
			prompt: async (text: string) => {
				prompts.push(text);
				eventHandler?.({
					type: "message_end",
					message: {
						role: "assistant",
						content: [
							{
								type: "text",
								text: JSON.stringify({
									proposal: {
										type: "fix",
										scope: "commit",
										summary: "Restored agentic commit proposals",
										details: [
											{
												text: "Parsed final assistant commit proposals.",
												changelog_category: "Fixed",
												user_visible: true,
											},
										],
										issue_refs: [],
									},
									split_proposal: null,
									changelog_proposal: {
										entries: [
											{
												path: "CHANGELOG.md",
												entries: { Fixed: ["Restored agentic commit proposals"] },
											},
										],
									},
								}),
							},
						],
					},
				} as AgentSessionEvent);
			},
			subscribe: (handler: (event: AgentSessionEvent) => void) => {
				eventHandler = handler;
				return () => {};
			},
			dispose: async () => {},
		};
		vi.spyOn(git.diff, "changedFiles").mockResolvedValue(["packages/coding-agent/src/commit/agentic/agent.ts"]);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			sessionOptions = options;
			return { session } as unknown as CreateAgentSessionResult;
		});

		const state = await runCommitAgentSession({
			cwd: "/tmp",
			model: commitModel(),
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: ["CHANGELOG.md"],
			requireChangelog: true,
			diffText: "",
		});

		if (!sessionOptions || !Array.isArray(sessionOptions.systemPrompt)) {
			throw new Error("Expected commit agent session options");
		}
		expect(prompts).toHaveLength(1);
		expect(sessionOptions.systemPrompt.join("\n")).toContain("sole `ipython` tool");
		expect(sessionOptions).not.toHaveProperty("customTools");
		expect(sessionOptions).not.toHaveProperty("toolNames");
		expect(state.proposal).toMatchObject({
			summary: "Restored agentic commit proposals",
			analysis: {
				type: "fix",
				scope: "commit",
				details: [
					{
						text: "Parsed final assistant commit proposals.",
						changelogCategory: "Fixed",
						userVisible: true,
					},
				],
			},
		});
		expect(state.splitProposal).toBeUndefined();
		expect(state.changelogProposal).toEqual({
			entries: [{ path: "CHANGELOG.md", entries: { Fixed: ["Restored agentic commit proposals"] } }],
		});
	});

	it("runs completion before session disposal", async () => {
		const events: string[] = [];
		const session = {
			prompt: async () => {},
			subscribe: () => () => {},
			dispose: async () => {
				events.push("dispose");
			},
		};

		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({ session } as unknown as CreateAgentSessionResult);

		await runCommitAgentSession({
			cwd: "/tmp",
			model: commitModel(),
			settings: Settings.isolated(),
			modelRegistry: {} as never,
			authStorage: {} as never,
			changelogTargets: [],
			requireChangelog: false,
			onComplete: _state => {
				events.push("complete");
			},
		});

		expect(events).toEqual(["complete", "dispose"]);
	});
});

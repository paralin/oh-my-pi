import { afterEach, describe, expect, it } from "bun:test";
import { ThinkingLevel, type ThinkingLevel as ThinkingLevelValue } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { parseArgs, reportUnrecognizedFlags } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
	createGladosBossExtension,
	GLADOS_BOSS_EXTENSION_ID,
	GLADOS_BOSS_FLAG,
	GLADOS_BOSS_MARKER_TYPE,
	GLADOS_BOSS_MODEL_SELECTOR,
	GLADOS_BOSS_PROVIDER,
	GLADOS_BOSS_PROVIDER_DECISION_TYPE,
	GLADOS_BOSS_STATUS_TOOL,
} from "@oh-my-pi/pi-coding-agent/glados/boss-extension";
import { loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	resetSettingsForTest();
});

describe("GLaDOS Boss extension", () => {
	it("registers --boss through the builtin extension path", async () => {
		const tempDir = await TempDir.create("@glados-boss-flags-");
		try {
			const settings = Settings.isolated({ extensions: [], disabledExtensions: [] });
			const loaded = await loadSessionExtensions({}, tempDir.path(), settings, new EventBus());
			const sink: ExtensionFlagSink = {
				getFlags: () => ExtensionRunner.aggregateFlags(loaded.extensions),
				setFlagValue: (name, value) => loaded.runtime.flagValues.set(name, value),
			};

			const parsed = applyExtensionFlags(sink, ["--boss", "--cwd", tempDir.path(), "start boss"]);

			expect(parsed?.unknownFlags.get(GLADOS_BOSS_FLAG)).toBe(true);
			expect(parsed?.cwd).toBe(tempDir.path());
			expect(parsed?.messages).toEqual(["start boss"]);
			expect(loaded.runtime.flagValues.get(GLADOS_BOSS_FLAG)).toBe(true);
			let stderr = "";
			expect(reportUnrecognizedFlags(parsed!, text => (stderr += text))).toBe(false);
			expect(stderr).toBe("");
		} finally {
			await tempDir.remove();
		}
	});

	it("rejects --boss when extensions are disabled", async () => {
		const tempDir = await TempDir.create("@glados-boss-disabled-");
		try {
			const settings = Settings.isolated({ extensions: [], disabledExtensions: [] });
			const loaded = await loadSessionExtensions(
				{ disableExtensionDiscovery: true },
				tempDir.path(),
				settings,
				new EventBus(),
			);
			expect(ExtensionRunner.aggregateFlags(loaded.extensions).has(GLADOS_BOSS_FLAG)).toBe(false);

			const parsed = parseArgs(["--no-extensions", "--boss", "--cwd", tempDir.path()]);
			let stderr = "";
			expect(reportUnrecognizedFlags(parsed, text => (stderr += text))).toBe(true);
			expect(stderr).toContain("--boss");
		} finally {
			await tempDir.remove();
		}
	});

	it("leaves ordinary sessions unchanged when --boss is absent", async () => {
		const harness = await createHarness({ boss: false, auth: true });
		try {
			await harness.runner.emit({ type: "session_start" });
			const before = await harness.runner.emitBeforeAgentStart("hello", undefined, ["base prompt"]);

			expect(harness.selectedModel).toBeUndefined();
			expect(harness.thinkingLevel).toBeUndefined();
			expect(harness.setActiveToolsCalls).toEqual([]);
			expect(harness.appendEntries).toEqual([]);
			expect(harness.sessionName).toBeUndefined();
			expect(before).toBeUndefined();
		} finally {
			await harness.close();
		}
	});

	it("activates Boss model, tool, marker, and prompt under --boss", async () => {
		const harness = await createHarness({ boss: true, auth: true });
		try {
			await harness.runner.emit({ type: "session_start" });
			const before = await harness.runner.emitBeforeAgentStart("hello", undefined, ["base prompt"]);

			expect(`${harness.selectedModel?.provider}/${harness.selectedModel?.id}`).toBe(GLADOS_BOSS_MODEL_SELECTOR);
			expect(harness.thinkingLevel).toBe(ThinkingLevel.XHigh);
			expect(harness.activeTools).toContain("read");
			expect(harness.activeTools).toContain(GLADOS_BOSS_STATUS_TOOL);
			expect(harness.sessionName).toBe(`Boss: ${harness.cwd}`);
			expect(harness.appendEntries.some(entry => entry.customType === GLADOS_BOSS_MARKER_TYPE)).toBe(true);
			expect(harness.appendEntries.some(entry => entry.customType === GLADOS_BOSS_PROVIDER_DECISION_TYPE)).toBe(
				false,
			);
			expect(before?.systemPrompt?.[0]).toBe("base prompt");
			expect(before?.systemPrompt?.join("\n")).toContain("GLaDOS Boss mode");
		} finally {
			await harness.close();
		}
	});

	it("records a provider decision entry when Boss auth is unavailable", async () => {
		const harness = await createHarness({ boss: true, auth: false });
		try {
			await harness.runner.emit({ type: "session_start" });

			expect(harness.selectedModel).toBeUndefined();
			expect(harness.appendEntries).toContainEqual(
				expect.objectContaining({
					customType: GLADOS_BOSS_PROVIDER_DECISION_TYPE,
					data: expect.objectContaining({ providerRoute: GLADOS_BOSS_MODEL_SELECTOR }),
				}),
			);
			expect(harness.appendEntries.some(entry => entry.customType === GLADOS_BOSS_MARKER_TYPE)).toBe(true);
		} finally {
			await harness.close();
		}
	});
});

async function createHarness(options: { boss: boolean; auth: boolean }) {
	const tempDir = await TempDir.create("@glados-boss-runtime-");
	const cwd = tempDir.path();
	const eventBus = new EventBus();
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		createGladosBossExtension,
		cwd,
		eventBus,
		runtime,
		GLADOS_BOSS_EXTENSION_ID,
	);
	if (options.boss) {
		runtime.flagValues.set(GLADOS_BOSS_FLAG, true);
	}
	const previousBossKey = Bun.env.GLADOS_CODEX_BOSS_API_KEY;
	if (!options.auth) {
		delete Bun.env.GLADOS_CODEX_BOSS_API_KEY;
	}

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	if (options.auth) {
		authStorage.setRuntimeApiKey(GLADOS_BOSS_PROVIDER, "test-key");
	}
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	modelRegistry.syncExtensionSources([extension.path]);
	modelRegistry.clearSourceRegistrations(extension.path);
	for (const { name, config, sourceId } of runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	runtime.pendingProviderRegistrations = [];

	const settings = Settings.isolated({});
	const sessionManager = SessionManager.inMemory(cwd);
	const activeTools = ["read"];
	const appendEntries: Array<{ customType: string; data: unknown }> = [];
	const setActiveToolsCalls: string[][] = [];
	let selectedModel: Model | undefined;
	let thinkingLevel: ThinkingLevelValue | undefined;
	let sessionName: string | undefined;
	const runner = new ExtensionRunner([extension], runtime, cwd, sessionManager, modelRegistry, undefined, settings);
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: (customType, data) => appendEntries.push({ customType, data }),
			setLabel: () => {},
			getActiveTools: () => [...activeTools],
			getAllTools: () => ["read", GLADOS_BOSS_STATUS_TOOL],
			setActiveTools: async toolNames => {
				setActiveToolsCalls.push([...toolNames]);
				activeTools.splice(0, activeTools.length, ...toolNames);
			},
			getCommands: () => [],
			setModel: async model => {
				const available = modelRegistry.hasConfiguredAuth(model);
				if (available) {
					selectedModel = model;
				}
				return available;
			},
			getThinkingLevel: () => thinkingLevel,
			setThinkingLevel: level => {
				thinkingLevel = level;
			},
			getSessionName: () => sessionName,
			setSessionName: async name => {
				sessionName = name;
			},
		},
		{
			getModel: () => selectedModel,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
	);

	return {
		activeTools,
		appendEntries,
		close: async () => {
			authStorage.close();
			if (previousBossKey === undefined) {
				delete Bun.env.GLADOS_CODEX_BOSS_API_KEY;
			} else {
				Bun.env.GLADOS_CODEX_BOSS_API_KEY = previousBossKey;
			}
			await tempDir.remove();
		},
		cwd,
		get selectedModel() {
			return selectedModel;
		},
		get sessionName() {
			return sessionName;
		},
		get thinkingLevel() {
			return thinkingLevel;
		},
		runner,
		setActiveToolsCalls,
	};
}

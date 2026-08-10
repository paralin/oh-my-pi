/**
 * Tests for ExtensionRunner - conflict detection, error handling, and IPython cell events.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { discoverAndLoadExtensions, ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionError,
	ExtensionServiceTier,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";

describe("ExtensionRunner", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	// Shared immutable fixtures. ModelRegistry's constructor synchronously loads
	// every bundled model and rebuilds the canonical index (~100ms); these tests
	// never mutate the registry or auth storage, so build them once per file
	// instead of paying that cost in every beforeEach.
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-runner-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-runner-test-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		tempDir.removeSync();
	});

	const loadTestExtensions = async (configuredPaths: string[] = []) => {
		const result = await discoverAndLoadExtensions([extensionsDir, ...configuredPaths], tempDir.path());
		const testRoots = [
			extensionsDir,
			...configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath)),
		];
		const isTestScoped = (candidate: string): boolean =>
			testRoots.some(root => {
				const relative = path.relative(path.resolve(root), path.resolve(candidate));
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
			});
		return {
			...result,
			extensions: result.extensions.filter(extension => isTestScoped(extension.path)),
			errors: result.errors.filter(error => isTestScoped(error.path)),
		};
	};

	it("exposes caller localProtocolOptions through extension context", async () => {
		const localProtocolOptions = {
			getArtifactsDir: () => tempDir.join("artifacts"),
			getSessionId: () => "runner-session",
		};
		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
			undefined,
			undefined,
			localProtocolOptions,
		);

		expect(runner.createContext().localProtocolOptions).toBe(localProtocolOptions);
	});

	it("reflects SessionManager.moveTo() changes instead of the constructor-time snapshot (/move)", async () => {
		const dirA = tempDir.join("dirA");
		const dirB = tempDir.join("dirB");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		const movableSessionManager = SessionManager.inMemory(dirA);

		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(result.extensions, result.runtime, dirA, movableSessionManager, modelRegistry);

		expect(runner.cwd).toBe(dirA);
		expect(runner.createContext().cwd).toBe(dirA);

		await movableSessionManager.moveTo(dirB);

		expect(runner.cwd).toBe(dirB);
		expect(runner.createContext().cwd).toBe(dirB);
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects ctrl+q so it cannot shadow the app.message.followUp default (#1903)", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+q", {
						description: "Tries to bind the follow-up chord",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-q.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			// Contract: ctrl+q is reserved because it is now a default chord for
			// app.message.followUp. Without this guard, InputController registers
			// the extension shortcut first and the follow-up handler silently
			// overwrites it in the editor's custom-key map.
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+q")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects Alt+M so it cannot shadow the app.model.select default", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("alt+m", {
						description: "Tries to bind model select",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-model.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("alt+m")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"), expect.any(Object));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map(c => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("prefers later-loaded explicit extensions for conflicting commands", async () => {
			const deployCommand = (description: string) => `
				export default function(pi) {
					pi.registerCommand("deploy", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;

			fs.writeFileSync(path.join(extensionsDir, "discovered-deploy.ts"), deployCommand("Discovered deploy"));
			const explicitExtensionPath = path.join(tempDir.path(), "explicit-deploy.ts");
			fs.writeFileSync(explicitExtensionPath, deployCommand("Explicit deploy"));

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const commands = runner.getRegisteredCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0]?.description).toBe("Explicit deploy");

			const command = runner.getCommand("deploy");
			expect(command?.description).toBe("Explicit deploy");
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("collects assistant thinking renderers", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerAssistantThinkingRenderer((context, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "thinking-renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.getAssistantThinkingRenderers().length).toBe(1);
		});
	});

	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const flags = runner.getFlags();

			expect(flags.has("--my-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_provider_request chaining", () => {
		it("exposes the request model instead of the primary session model", async () => {
			const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
			const requestModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel || !requestModel) throw new Error("Expected bundled cross-provider models to exist");

			const extCode = `
				export default function(pi) {
					pi.on("before_provider_request", async (_event, ctx) => {
						const current = ctx.models.current();
						return {
							model: ctx.model && {
								provider: ctx.model.provider,
								id: ctx.model.id,
								api: ctx.model.api,
							},
							current: current && {
								provider: current.provider,
								id: current.id,
								api: current.api,
							},
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "request-model.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => primaryModel,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			const payload = await runner.emitBeforeProviderRequest({}, requestModel);

			const expected = {
				provider: requestModel.provider,
				id: requestModel.id,
				api: requestModel.api,
			};
			expect(payload).toEqual({ model: expected, current: expected });
		});

		it("chains payload replacements across handlers in load order", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext1"] };
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext2"] };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const payload = await runner.emitBeforeProviderRequest({ chain: ["base"] });
			expect(payload).toEqual({ chain: ["base", "ext1", "ext2"] });
		});

		it("keeps chaining after handler errors", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async () => {
						throw new Error("payload failed");
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { preserved?: boolean };
						return { ...payload, preserved: true };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-error.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-ok.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			const payload = await runner.emitBeforeProviderRequest({ original: true });
			expect(payload).toEqual({ original: true, preserved: true });
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("before_provider_request");
			expect(errors[0]?.error).toContain("payload failed");
		});
	});

	describe("after_provider_response", () => {
		it("calls handlers with response metadata and reports handler errors without throwing", async () => {
			const eventsPath = path.join(tempDir.path(), "after-provider-response-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							status: event.status,
							headers: event.headers,
							requestId: event.requestId,
							metadata: event.metadata,
						}) + "\\n",
					);
				});

				pi.on("after_provider_response", async () => {
					throw new Error("response failed");
				});

				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({ afterError: event.status }) + "\\n",
					);
				});
			}
		`;
			fs.writeFileSync(path.join(extensionsDir, "after-provider-response.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emitAfterProviderResponse({
				status: 202,
				headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
				requestId: "req_123",
				metadata: { provider: "test" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					status: 202,
					headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
					requestId: "req_123",
					metadata: { provider: "test" },
				},
				{ afterError: 202 },
			]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("after_provider_response");
			expect(errors[0]?.error).toContain("response failed");
		});
	});

	describe("session_stop", () => {
		it("invokes handlers with completed main-session messages and returns continuation feedback", async () => {
			const eventsPath = path.join(tempDir.path(), "session-stop-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("session_stop", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							type: event.type,
							messages: event.messages,
							turn_id: event.turn_id,
							last_assistant_message: event.last_assistant_message,
							session_id: event.session_id,
							session_file: event.session_file,
							stop_hook_active: event.stop_hook_active,
						}) + "\\n",
					);
					return { continue: true, additionalContext: "Run one more pass." };
				});
			}
		`;
			await Bun.write(path.join(extensionsDir, "session-stop.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			const stopResult = await runner.emitSessionStop({
				messages: [completedMessage],
				turn_id: 2,
				last_assistant_message: completedMessage,
				session_id: "session-123",
				session_file: "/tmp/session.jsonl",
				stop_hook_active: false,
				signal: new AbortController().signal,
			});

			const events = (await Bun.file(eventsPath).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					type: "session_stop",
					messages: [completedMessage],
					turn_id: 2,
					last_assistant_message: completedMessage,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				},
			]);
			expect(stopResult).toEqual({ continue: true, additionalContext: "Run one more pass." });
		});

		it("skips cancelled handlers, releases in-flight handlers, and preserves timeout errors", async () => {
			const extensionPath = path.join(tempDir.path(), "cancel-session-stop.ts");
			const startedPath = path.join(tempDir.path(), "session-stop-started.txt");
			await Bun.write(
				extensionPath,
				`
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("session_stop", async () => {
						fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: ExtensionError[] = [];
			runner.onError(error => errors.push(error));
			testSetExtensionHandlerTimeoutMs(100);
			const controller = new AbortController();
			const preAborted = new AbortController();
			preAborted.abort();
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: preAborted.signal,
				}),
			).resolves.toBeUndefined();
			expect(await Bun.file(startedPath).exists()).toBe(false);

			const emission = runner.emitSessionStop({
				messages: [],
				turn_id: 0,
				session_id: "session-123",
				stop_hook_active: false,
				signal: controller.signal,
			});
			expect(await Bun.file(startedPath).text()).toBe("started");
			controller.abort();

			await expect(emission).resolves.toBeUndefined();
			expect(errors).toEqual([]);

			// A non-cancelled handler still exercises the production timer and reports its timeout.
			testSetExtensionHandlerTimeoutMs(10);
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 1,
					session_id: "session-123",
					stop_hook_active: false,
					signal: new AbortController().signal,
				}),
			).resolves.toBeUndefined();
			expect(errors).toEqual([
				{
					extensionPath,
					event: "session_stop",
					error: "handler timed out after 10ms",
				},
			]);
		});

		it("observes a session_stop signal aborted synchronously by the handler", async () => {
			const extensionPath = path.join(tempDir.path(), "self-cancel-session-stop.ts");
			await Bun.write(
				extensionPath,
				`
				export default function(pi) {
					pi.on("session_stop", async (_event, ctx) => {
						ctx.abort();
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const controller = new AbortController();
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => controller.abort(),
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);
			vi.useFakeTimers();
			try {
				testSetExtensionHandlerTimeoutMs(100);
				const emission = runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: controller.signal,
				});
				let settled = false;
				void emission.then(() => {
					settled = true;
				});
				for (let attempts = 0; attempts < 10 && !settled; attempts++) {
					await Promise.resolve();
				}

				expect(controller.signal.aborted).toBe(true);
				expect(settled).toBe(true);
				await emission;
			} finally {
				vi.useRealTimers();
			}
		});
		it("continues to later handlers after empty continuation feedback", async () => {
			await Bun.write(
				path.join(extensionsDir, "session-stop-empty.ts"),
				`
				export default function(pi) {
					pi.on("session_stop", async () => ({ continue: true }));
					pi.on("session_stop", async () => ({ decision: "block", reason: "Continue from second handler." }));
				}
			`,
			);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			await expect(
				runner.emitSessionStop({
					messages: [completedMessage],
					turn_id: 0,
					last_assistant_message: completedMessage,
					signal: new AbortController().signal,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				}),
			).resolves.toEqual({ decision: "block", reason: "Continue from second handler." });
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "ipython",
				toolCallId: "call-1",
				input: { code: "print('base')" },
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "ipython",
				toolCallId: "call-2",
				input: { code: "print('base')" },
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("handler timeouts", () => {
		it("times out session_start handlers, emits an error, and continues to sibling extensions", async () => {
			const hangExtensionPath = path.join(tempDir.path(), "hang-session-start.ts");
			const fastExtensionPath = path.join(tempDir.path(), "fast-session-start.ts");
			const markerPath = path.join(tempDir.path(), "session-start-marker.txt");
			fs.writeFileSync(
				hangExtensionPath,
				`
					export default function(pi) {
						pi.on("session_start", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);
			fs.writeFileSync(
				fastExtensionPath,
				`
					import * as fs from "node:fs";

					export default function(pi) {
						pi.on("session_start", async () => {
							fs.appendFileSync(${JSON.stringify(markerPath)}, "fast\\n");
						});
					}
				`,
			);

			const result = await loadTestExtensions([hangExtensionPath, fastExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});
			testSetExtensionHandlerTimeoutMs(10);

			const startedAt = performance.now();
			await runner.emit({ type: "session_start" });
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(150);
			expect(fs.readFileSync(markerPath, "utf8")).toBe("fast\n");
			expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
				extensionPath: hangExtensionPath,
				event: "session_start",
				timeoutMs: 10,
			});
			expect(errors).toEqual([
				{
					extensionPath: hangExtensionPath,
					event: "session_start",
					error: "handler timed out after 10ms",
				},
			]);

			warnSpy.mockRestore();
		});
	});

	describe("memory context", () => {
		it("exposes the lazy memory runtime after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async (_event, ctx) => {
						globalThis.__ompMemoryStatus = await ctx.memory.status();
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "memory-context.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);
			const globalState = globalThis as typeof globalThis & { __ompMemoryStatus?: unknown };
			delete globalState.__ompMemoryStatus;

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				() => ({
					status: async () => ({
						backend: "mnemopi",
						active: true,
						writable: true,
						searchable: true,
					}),
					search: async query => ({ backend: "mnemopi", query, count: 0, items: [] }),
					save: async () => ({ backend: "mnemopi", stored: 1 }),
				}),
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(globalState.__ompMemoryStatus).toMatchObject({
				backend: "mnemopi",
				active: true,
				searchable: true,
			});
			delete globalState.__ompMemoryStatus;
		});
	});

	describe("service tier API", () => {
		it("restricts tiers to values supported by each provider family", () => {
			expectTypeOf<"scale">().toExtend<ExtensionServiceTier<"openai">>();
			expectTypeOf<"flex">().toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"priority">().toExtend<ExtensionServiceTier<"anthropic">>();
			expectTypeOf<"scale">().not.toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"flex">().not.toExtend<ExtensionServiceTier<"anthropic">>();
		});

		it("returns a detached snapshot, forwards valid changes, and rejects invalid family tiers", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", () => {
						const tiers = pi.getServiceTiers();
						tiers.openai = "scale";
						pi.appendEntry("service-tier-snapshot", tiers);
						pi.setServiceTier("google", "flex");
						pi.setServiceTier("openai", undefined);
					});
					pi.on("session_start", () => {
						pi.setServiceTier("anthropic", "scale");
					});
					pi.on("session_start", () => {
						pi.setServiceTier("bogus", "priority");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "service-tiers.ts");
			await Bun.write(explicitExtensionPath, extCode);
			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const serviceTiers = { openai: "priority" as const };
			const snapshots: unknown[] = [];
			const setCalls: Array<[string, unknown]> = [];
			const errors: string[] = [];
			runner.onError(error => {
				errors.push(error.error);
			});
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: (_customType, data) => {
						snapshots.push(data);
					},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getServiceTiers: () => serviceTiers,
					setServiceTier: (family, tier) => {
						setCalls.push([family, tier]);
					},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(serviceTiers).toEqual({ openai: "priority" });
			expect(snapshots).toEqual([{ openai: "scale" }]);
			expect(setCalls).toEqual([
				["google", "flex"],
				["openai", undefined],
			]);
			expect(errors).toHaveLength(2);
			expect(errors[0]).toContain('Invalid service tier "scale" for family "anthropic"');
			expect(errors[1]).toContain('Invalid service tier "priority" for family "bogus"');
		});
	});

	describe("session name API", () => {
		it("lets extensions read and set the session name after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async () => {
						if (pi.getSessionName() !== undefined) {
							throw new Error("expected unnamed session");
						}
						await pi.setSessionName("Named by extension");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async name => {
						await sessionManager.setSessionName(name);
					},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(sessionManager.getSessionName()).toBe("Named by extension");
			expect(sessionManager.getHeader()?.title).toBe("Named by extension");
		});

		it("keeps session naming unavailable during extension load", async () => {
			const extCode = `
				export default function(pi) {
					pi.getSessionName();
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name-load.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const loadError = result.errors.find(error => error.path.includes("session-name-load.ts"));

			expect(loadError).toBeDefined();
			expect(loadError?.error).toContain("Extension runtime not initialized");
		});
	});

	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});

	describe("zero-handler fast path", () => {
		it("skips context allocation and handler machinery for an unsubscribed event type, but still fires when subscribed", async () => {
			// The fast path in ExtensionRunner.emit is event-type agnostic; the hot
			// streaming events (message_update / tool_execution_*) traverse the same
			// path. `turn_start` stands in as a subscribed event with a trivial payload.
			const extCode = `
				export default function(pi) {
					pi.on("turn_start", async () => {
						throw new Error("turn_start handler ran");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "turn-start-handler.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// createContext is the per-event allocation the fast path defers; spying on
			// it (call-through preserved) proves the slow path is entered only when a
			// handler exists for the emitted event type.
			const createContextSpy = vi.spyOn(runner, "createContext");
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError(err => {
				errors.push({ event: err.event, error: err.error });
			});

			// No extension subscribes to `agent_start`: no context allocation, and the
			// handler-timeout machinery is never entered.
			await runner.emit({ type: "agent_start" });
			expect(createContextSpy).not.toHaveBeenCalled();
			expect(errors).toHaveLength(0);

			// `turn_start` has a handler: context is allocated once and the handler runs
			// (its throw surfaces via onError, proving #runHandlerWithTimeout executed).
			await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
			expect(createContextSpy).toHaveBeenCalledTimes(1);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("turn_start");
			expect(errors[0]?.error).toContain("turn_start handler ran");
		});
	});

	describe("credential_disabled", () => {
		it("delivers credential_disabled events to subscribed extensions with the typed payload", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								type: event.type,
								provider: event.provider,
								disabledCause: event.disabledCause,
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "credential-disabled.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			await runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" });

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" },
			]);
		});

		it("isolates subscriber failures so other handlers still receive the event", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-isolated.jsonl");
			const ext1Code = `
				export default function(pi) {
					pi.on("credential_disabled", async () => {
						throw new Error("subscriber exploded");
					});
				}
			`;
			const ext2Code = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ provider: event.provider }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1-credential-disabled-throws.ts"), ext1Code);
			fs.writeFileSync(path.join(extensionsDir, "ext2-credential-disabled-records.ts"), ext2Code);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" });

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ provider: "anthropic" }]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("credential_disabled");
			expect(errors[0]?.error).toContain("subscriber exploded");
		});

		it("is a no-op when no extension subscribes", async () => {
			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.hasHandlers("credential_disabled")).toBe(false);
			await expect(
				runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" }),
			).resolves.toBeUndefined();
		});

		it("caps the pre-initialize buffer and drops oldest events under pressure", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-cap.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ provider: event.provider }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "credential-disabled-cap.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Push 33 events while uninitialized — the 1st should be dropped.
			for (let i = 0; i < 33; i++) {
				await runner.emitCredentialDisabled({ provider: `provider-${i}`, disabledCause: "invalid_grant" });
			}

			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			// Drain microtasks so the fire-and-forget emit() calls inside initialize() complete.
			for (let i = 0; i < 5; i++) await Promise.resolve();

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toHaveLength(32);
			// Drop-oldest policy: provider-0 was evicted, provider-1 survived as the head.
			expect(events[0]?.provider).toBe("provider-1");
		});
	});

	describe("mcp_notification", () => {
		it("delivers mcp_notification events to subscribed extensions with the typed payload", async () => {
			const eventsPath = path.join(tempDir.path(), "mcp-notification-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("mcp_notification", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								type: event.type,
								server: event.server,
								method: event.method,
								params: event.params,
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "mcp-notification.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emitMcpNotification({
				server: "peers",
				method: "notifications/peer_message",
				params: { from: "alice", text: "hi" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					type: "mcp_notification",
					server: "peers",
					method: "notifications/peer_message",
					params: { from: "alice", text: "hi" },
				},
			]);
		});

		it("buffers pre-initialize events and drains them on initialize (caps at 100, drops oldest)", async () => {
			// Guard against regression of the two-layer startup race that Codex flagged
			// on PR #6535 (commit ffa058aa8): the sdk.ts bridge wires
			// mcpManager.addNotificationListener inside createAgentSession BEFORE the
			// mode controller calls ExtensionRunner.initialize(). Frames the manager
			// drains from its own buffer arrive here pre-init. Prior behavior silently
			// dropped them; the fix buffers and drains on initialize (same shape as
			// emitCredentialDisabled).
			const eventsPath = path.join(tempDir.path(), "mcp-notification-cap.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("mcp_notification", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ server: event.server, method: event.method }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "mcp-notification-cap.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Push 101 events while uninitialized — the 1st should be dropped, next 100 buffered.
			for (let i = 0; i < 101; i++) {
				await runner.emitMcpNotification({
					server: "peers",
					method: `notifications/test/${i}`,
					params: null,
				});
			}

			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			// Drain microtasks so the fire-and-forget emit() calls inside initialize() complete.
			for (let i = 0; i < 5; i++) await Promise.resolve();

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toHaveLength(100);
			// Drop-oldest policy: test/0 was evicted, test/1 survives as the head.
			expect(events[0]?.method).toBe("notifications/test/1");
			expect(events[99]?.method).toBe("notifications/test/100");
		});
	});

	describe("managed timers (ctx.setInterval / ctx.setTimeout)", () => {
		it("contains a throwing interval callback instead of letting it escape as uncaughtException", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const errors: ExtensionError[] = [];
				runner.onError(err => errors.push(err));

				const ctx = runner.createContext();
				let ticks = 0;
				ctx.setInterval(() => {
					ticks += 1;
					throw new Error("boom from interval");
				}, 1000);

				// Two ticks: the throw is swallowed each time, so the interval keeps firing.
				expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
				expect(ticks).toBe(2);
				expect(errors).toHaveLength(2);
				expect(errors[0]?.event).toBe("interval_callback");
				expect(errors[0]?.extensionPath).toBe("<timer>");
				expect(errors[0]?.error).toContain("boom from interval");
			} finally {
				vi.useRealTimers();
			}
		});

		it("contains a throwing timeout callback and reports it once", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const errors: ExtensionError[] = [];
				runner.onError(err => errors.push(err));

				runner.createContext().setTimeout(() => {
					throw new Error("boom from timeout");
				}, 500);

				expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
				expect(errors).toHaveLength(1);
				expect(errors[0]?.event).toBe("timeout_callback");
				expect(errors[0]?.error).toContain("boom from timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("clearTimer stops a managed interval from firing again", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const ctx = runner.createContext();
				let ticks = 0;
				const timer = ctx.setInterval(() => {
					ticks += 1;
				}, 1000);

				vi.advanceTimersByTime(1000);
				expect(ticks).toBe(1);

				ctx.clearTimer(timer);
				vi.advanceTimersByTime(3000);
				expect(ticks).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clearManagedTimers cancels every outstanding timer on teardown", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const ctx = runner.createContext();
				let intervalTicks = 0;
				let timeoutFired = false;
				ctx.setInterval(() => {
					intervalTicks += 1;
				}, 1000);
				ctx.setTimeout(() => {
					timeoutFired = true;
				}, 1000);

				runner.clearManagedTimers();
				vi.advanceTimersByTime(5000);
				expect(intervalTicks).toBe(0);
				expect(timeoutFired).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears the previous timer scope without clearing candidate timers", () => {
			vi.useFakeTimers();
			try {
				const previous = [] as Extension[];
				const candidate = [] as Extension[];
				const runner = new ExtensionRunner(
					previous,
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				let previousFired = false;
				let candidateFired = false;
				runner.createContext(undefined, previous).setTimeout(() => {
					previousFired = true;
				}, 10);
				runner.createContext(undefined, candidate).setTimeout(() => {
					candidateFired = true;
				}, 10);
				runner.clearManagedTimers(previous);
				vi.advanceTimersByTime(10);
				expect(previousFired).toBe(false);
				expect(candidateFired).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clears candidate rollback timers while preserving the previous restart scope", () => {
			vi.useFakeTimers();
			try {
				const previous = [] as Extension[];
				const candidate = [] as Extension[];
				const runner = new ExtensionRunner(
					previous,
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const fired: string[] = [];
				const candidateContext = runner.createContext(undefined, candidate);
				candidateContext.setTimeout(() => fired.push("candidate-start"), 10);
				candidateContext.setTimeout(() => fired.push("candidate-shutdown"), 10);
				runner.clearManagedTimers(candidate);
				runner.clearManagedTimers(previous);
				runner.createContext(undefined, previous).setTimeout(() => fired.push("previous-restart"), 10);
				vi.advanceTimersByTime(10);
				expect(fired).toEqual(["previous-restart"]);
			} finally {
				vi.useRealTimers();
			}
		});

		it("keeps a candidate timer child scheduled while previous shutdown is awaited", async () => {
			vi.useFakeTimers();
			try {
				const previous = [] as Extension[];
				const candidate = [] as Extension[];
				const runner = new ExtensionRunner(
					previous,
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const candidateContext = runner.createContext(undefined, candidate);
				let childFired = false;
				candidateContext.setTimeout(() => {
					candidateContext.setTimeout(() => {
						childFired = true;
					}, 5);
				}, 5);
				const shutdownDone = Promise.withResolvers<void>();
				runner.createContext(undefined, previous).setTimeout(() => shutdownDone.resolve(), 5);
				vi.advanceTimersByTime(5);
				await shutdownDone.promise;
				runner.clearManagedTimers(previous);
				vi.advanceTimersByTime(5);
				expect(childFired).toBe(true);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("definition replacement", () => {
		it("keeps initialized dispatch ordering after definition replacement", async () => {
			const result = await loadTestExtensions();
			const calls: string[] = [];
			const initial = {
				path: "initial",
				resolvedPath: "initial",
				handlers: new Map([["session_start", [() => calls.push("initial")]]]),
			} as unknown as Extension;
			const replacement = {
				path: "replacement",
				resolvedPath: "replacement",
				handlers: new Map([["session_start", [() => calls.push("first"), () => calls.push("second")]]]),
			} as unknown as Extension;
			const runner = new ExtensionRunner([initial], result.runtime, tempDir.path(), sessionManager, modelRegistry);
			await runner.emit({ type: "session_start" });
			runner.replaceExtensions([replacement]);
			await runner.emit({ type: "session_start" });
			expect(calls).toEqual(["initial", "first", "second"]);
		});
	});
});

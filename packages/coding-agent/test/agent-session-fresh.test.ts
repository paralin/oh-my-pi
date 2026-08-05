import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, AppendOnlyContextManager } from "@oh-my-pi/pi-agent-core";
import type { ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CoordinationLifecycle } from "@oh-my-pi/pi-coding-agent/coordination/backend";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

interface FreshHarness {
	agent: Agent;
	session: AgentSession;
	sessionManager: SessionManager;
}

const cleanup: Array<() => Promise<void>> = [];
let sharedDir: TempDir;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = TempDir.createSync("@pi-agent-session-fresh-shared-");
	authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
});

afterAll(() => {
	authStorage.close();
	sharedDir.removeSync();
});

afterEach(async () => {
	while (cleanup.length > 0) {
		const run = cleanup.pop();
		if (run) await run();
	}
});

async function createFreshHarness(coordinationLifecycle?: CoordinationLifecycle): Promise<FreshHarness> {
	const tempDir = TempDir.createSync("@pi-agent-session-fresh-");
	const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
	const agent = new Agent({
		initialState: {
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated(),
		modelRegistry,
		coordinationLifecycle,
	});
	cleanup.push(async () => {
		await session.dispose();
		tempDir.removeSync();
	});
	return { agent, session, sessionManager };
}

describe("AgentSession fresh provider state", () => {
	it("rotates only the provider-facing session id and prunes cached stream state", async () => {
		const { agent, session, sessionManager } = await createFreshHarness();
		const persistedSessionId = sessionManager.getSessionId();
		const persistedSessionFile = sessionManager.getSessionFile();
		const persistedHeaderId = sessionManager.getHeader()?.id;
		let closeCount = 0;
		const providerState: ProviderSessionState = {
			close() {
				closeCount += 1;
			},
		};
		session.providerSessionState.set("websocket", providerState);

		const appendOnlyContext = new AppendOnlyContextManager();
		agent.setAppendOnlyContext(appendOnlyContext);
		appendOnlyContext.syncMessages([{ role: "user", content: "cached context" }]);
		appendOnlyContext.build({ systemPrompt: ["Test"], messages: [], tools: [] }, { intentTracing: false });

		const result = session.freshSession();

		expect(result).toBeDefined();
		if (!result) return;
		expect(result.previousSessionId).toBe(persistedSessionId);
		expect(result.sessionId).not.toBe(persistedSessionId);
		expect(result.closedProviderSessions).toBe(1);
		expect(agent.sessionId).toBe(result.sessionId);
		expect(session.sessionId).toBe(result.sessionId);
		expect(sessionManager.getSessionId()).toBe(persistedSessionId);
		expect(sessionManager.getHeader()?.id).toBe(persistedHeaderId);
		expect(sessionManager.getSessionFile()).toBe(persistedSessionFile);
		expect(closeCount).toBe(1);
		expect(session.providerSessionState.size).toBe(0);
		expect(appendOnlyContext.log.length).toBe(0);
		expect(appendOnlyContext.prefix.built).toBe(false);
	});

	it("drops the transient provider id when a real new session starts", async () => {
		const { session, sessionManager } = await createFreshHarness();
		const freshResult = session.freshSession();
		expect(freshResult).toBeDefined();
		if (!freshResult) return;

		await session.newSession();

		expect(session.sessionId).toBe(sessionManager.getSessionId());
		expect(session.sessionId).not.toBe(freshResult.sessionId);
	});

	it("awaits custody rotation after committing a new session identity", async () => {
		const entered = Promise.withResolvers<Parameters<CoordinationLifecycle["afterSessionTransition"]>[1]>();
		const release = Promise.withResolvers<void>();
		const lifecycle: CoordinationLifecycle = {
			async beforeRootTransition() {
				return { generation: 1 };
			},
			async afterSessionTransition(_token, transition) {
				entered.resolve(transition);
				await release.promise;
			},
			async afterModelTransition() {
				throw new Error("unexpected model transition");
			},
			async abortRootTransition() {},
		};
		const { session, sessionManager } = await createFreshHarness(lifecycle);
		const previousSessionId = sessionManager.getSessionId();

		let settled = false;
		const changing = session.newSession().then(() => {
			settled = true;
		});
		const transition = await entered.promise;

		expect(transition.previousSessionId).toBe(previousSessionId);
		expect(transition.sessionId).toBe(sessionManager.getSessionId());
		expect(transition.reason).toBe("new");
		const model = session.model;
		if (!model) throw new Error("new session has no selected model");
		expect(transition.provider).toBe(model.provider);
		expect(transition.model).toBe(model.id);
		expect(settled).toBe(false);

		release.resolve();
		await changing;
		expect(settled).toBe(true);
	});
});

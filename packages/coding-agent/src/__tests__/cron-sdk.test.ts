import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { CronManager } from "../cron";
import { AgentRegistry } from "../registry/agent-registry";
import { createAgentSession } from "../sdk";
import { AgentSession } from "../session/agent-session";
import { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { sessionSidecarDir } from "../session/session-paths";

it("delivers overdue durable jobs after session construction and disposes the scheduler", async () => {
	using tempDir = TempDir.createSync("@omp-cron-sdk-");
	const authStorage = await AuthStorage.create(":memory:");
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const sessionManager = await SessionManager.open(sessionFile, tempDir.path());
	const storeDir = sessionSidecarDir(sessionFile);
	await fs.mkdir(storeDir, { recursive: true });
	await Bun.write(
		path.join(storeDir, "scheduled_tasks.json"),
		`${JSON.stringify([
			{
				id: "cron-overdue",
				expression: "0 0 1 1 *",
				prompt: "catch up now",
				recurring: false,
				durable: true,
				createdAt: Date.now() - 120_000,
				nextFireAt: Date.now() - 60_000,
			},
		])}\n`,
	);
	const delivered = Promise.withResolvers<void>();
	let factoryReturned = false;
	let deliveredBeforeReturn = false;
	const deliver = vi.spyOn(AgentSession.prototype, "deliverScheduledPrompt").mockImplementation(async () => {
		deliveredBeforeReturn = !factoryReturned;
		delivered.resolve();
	});
	const dispose = vi.spyOn(CronManager.prototype, "dispose");
	try {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated(),
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		factoryReturned = true;
		await delivered.promise;
		expect(deliver).toHaveBeenCalledWith("catch up now");
		expect(deliveredBeforeReturn).toBe(false);
		const disposing = session.dispose();
		expect(dispose).toHaveBeenCalled();
		await disposing;
	} finally {
		deliver.mockRestore();
		dispose.mockRestore();
		authStorage.close();
	}
});

it("keeps cron-store read failures from aborting session construction", async () => {
	using tempDir = TempDir.createSync("@omp-cron-sdk-load-failure-");
	const authStorage = await AuthStorage.create(":memory:");
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const sessionManager = await SessionManager.open(sessionFile, tempDir.path());
	const storage = sessionManager.getStorage();
	const readText = storage.readText.bind(storage);
	const read = vi.spyOn(storage, "readText").mockImplementation(file => {
		if (file.endsWith("scheduled_tasks.json")) return Promise.reject(new Error("transient cron store failure"));
		return readText(file);
	});
	try {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry: new ModelRegistry(authStorage),
			settings: Settings.isolated(),
			sessionManager,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		await session.dispose();
	} finally {
		read.mockRestore();
		authStorage.close();
	}
});

it("disposes the scheduler when session registry attachment fails", async () => {
	using tempDir = TempDir.createSync("@omp-cron-sdk-attach-failure-");
	const authStorage = await AuthStorage.create(":memory:");
	const sessionFile = path.join(tempDir.path(), "session.jsonl");
	const sessionManager = await SessionManager.open(sessionFile, tempDir.path());
	const storeDir = sessionSidecarDir(sessionFile);
	await fs.mkdir(storeDir, { recursive: true });
	await Bun.write(
		path.join(storeDir, "scheduled_tasks.json"),
		`${JSON.stringify([
			{
				id: "cron-future",
				expression: "0 0 1 1 *",
				prompt: "later",
				recurring: true,
				durable: true,
				createdAt: Date.now(),
				expiresAt: Date.now() + 60_000,
				nextFireAt: Date.now() + 30_000,
			},
		])}\n`,
	);
	const registry = new AgentRegistry();
	const attach = vi.spyOn(registry, "attachSession").mockReturnValue(false);
	const dispose = vi.spyOn(CronManager.prototype, "dispose");
	try {
		await expect(
			createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated(),
				sessionManager,
				agentRegistry: registry,
				agentId: "cron-attach-failure",
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}),
		).rejects.toThrow("was replaced during session initialization");
		expect(dispose).toHaveBeenCalled();
	} finally {
		attach.mockRestore();
		dispose.mockRestore();
		authStorage.close();
	}
});

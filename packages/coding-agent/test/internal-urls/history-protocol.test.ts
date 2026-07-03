/**
 * Contracts: history:// protocol handler (rework-contracts.md §6), resolved
 * through `InternalUrlRouter.instance().resolve(...)` like real callers.
 *
 * - Bare `history://` renders an index listing registered agent ids.
 * - `history://<id>` with a live ref renders the in-memory transcript.
 * - A parked ref (session null, sessionFile retained) renders read-only from
 *   the JSONL session file.
 * - An unknown id fails with an error listing the known ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { advisorTranscriptFilename } from "@oh-my-pi/pi-coding-agent/advisor/transcript-recorder";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagentsForKnownSessions } from "@oh-my-pi/pi-coding-agent/registry/persisted-subagents";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function fakeLiveSession(messages: unknown[]): AgentSession {
	return { messages } as unknown as AgentSession;
}

/** Minimal current-version session JSONL: header + a linear user/assistant chain. */
function sessionFixtureJsonl(
	input: { id?: string; user?: string; assistant?: string; parentSession?: string } = {},
): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: input.id ?? "fixture-session",
		timestamp,
		cwd: "/tmp",
		...(input.parentSession ? { parentSession: input.parentSession } : {}),
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: input.user ?? "parked hello", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: input.assistant ?? "parked reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

describe("history:// protocol", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("bare history:// renders an index listing registered agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Agents");
		expect(resource.content).toContain("| HubAgent | idle | sub |");
	});

	it("history://<id> renders a live ref's in-memory transcript", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");

		expect(resource.content).toContain("# HubAgent (idle)");
		expect(resource.content).toContain("## user");
		expect(resource.content).toContain("hello from live");
		expect(resource.notes).toContain("Source: live session");
	});

	it("resolves agent ids case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://hubagent");
		expect(resource.content).toContain("# HubAgent (idle)");
	});

	it("history://<id> renders a parked ref read-only from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Sleeper",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sleeper");

			expect(resource.content).toContain("# Sleeper (parked)");
			expect(resource.content).toContain("parked hello");
			expect(resource.content).toContain("parked reply");
			expect(resource.sourcePath).toBe(sessionFile);
			expect(resource.notes?.join("\n")).toContain("read-only");
		});
	});

	it("discovers a past-session child transcript from a registered parent session file", async () => {
		await withTempDir(async dir => {
			const parentFile = path.join(dir, "parent.jsonl");
			const childDir = path.join(dir, "parent");
			const childFile = path.join(childDir, "PastChild.jsonl");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(parentFile, sessionFixtureJsonl({ id: "parent-session", user: "parent hello" }));
			await Bun.write(
				childFile,
				sessionFixtureJsonl({
					id: "child-session",
					user: "past child hello",
					assistant: "past child reply",
					parentSession: parentFile,
				}),
			);
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: fakeLiveSession([]),
				sessionFile: parentFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://PastChild");

			expect(resource.content).toContain("# PastChild (parked)");
			expect(resource.content).toContain("past child hello");
			expect(resource.content).toContain("past child reply");
			expect(resource.sourcePath).toBe(childFile);
			expect(AgentRegistry.global().get("PastChild")?.sessionFile).toBe(childFile);
		});
	});

	it("shared persisted-child discovery is idempotent, keeps live refs, and leaves advisors hidden", async () => {
		await withTempDir(async dir => {
			const parentFile = path.join(dir, "main.jsonl");
			const childDir = path.join(dir, "main");
			const pastChildFile = path.join(childDir, "PastChild.jsonl");
			const liveChildFile = path.join(childDir, "LiveChild.jsonl");
			const advisorFile = path.join(childDir, advisorTranscriptFilename(""));
			const liveSessionFile = path.join(dir, "live-current.jsonl");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(parentFile, sessionFixtureJsonl({ id: "main-session", user: "parent hello" }));
			await Bun.write(
				pastChildFile,
				sessionFixtureJsonl({
					id: "past-child-session",
					user: "past child hello",
					assistant: "past child reply",
					parentSession: parentFile,
				}),
			);
			await Bun.write(
				liveChildFile,
				sessionFixtureJsonl({
					id: "live-child-session",
					user: "stale file copy",
					parentSession: parentFile,
				}),
			);
			await Bun.write(
				advisorFile,
				sessionFixtureJsonl({
					id: "advisor-session",
					user: "advisor private note",
					parentSession: parentFile,
				}),
			);
			const registry = AgentRegistry.global();
			registry.register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: fakeLiveSession([]),
				sessionFile: parentFile,
				status: "idle",
			});
			const liveSession = fakeLiveSession([{ role: "user", content: "live child state", timestamp: 1 }]);
			const liveRef = registry.register({
				id: "LiveChild",
				displayName: "live",
				kind: "sub",
				parentId: "Main",
				session: liveSession,
				sessionFile: liveSessionFile,
				status: "running",
			});
			const events: string[] = [];
			const unsubscribe = registry.onChange(event => events.push(`${event.type}:${event.ref.id}`));

			await registerPersistedSubagentsForKnownSessions({ registry });
			await registerPersistedSubagentsForKnownSessions({ registry });
			unsubscribe();

			const pastRefs = registry.list().filter(ref => ref.id === "PastChild");
			const advisorRefs = registry.list().filter(ref => ref.id === "Main/advisor");
			const liveAfterScan = registry.get("LiveChild");
			expect(pastRefs).toHaveLength(1);
			expect(pastRefs[0]?.sessionFile).toBe(pastChildFile);
			expect(pastRefs[0]?.status).toBe("parked");
			expect(advisorRefs).toHaveLength(1);
			expect(advisorRefs[0]?.sessionFile).toBe(advisorFile);
			expect(liveAfterScan).toBe(liveRef);
			expect(liveAfterScan?.session).toBe(liveSession);
			expect(liveAfterScan?.sessionFile).toBe(liveSessionFile);
			expect(liveAfterScan?.status).toBe("running");
			expect(events.filter(event => event === "registered:PastChild")).toHaveLength(1);
			expect(events.filter(event => event === "registered:Main/advisor")).toHaveLength(1);
			expect(events.some(event => event.endsWith(":LiveChild"))).toBe(false);

			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("PastChild");
			expect(index.content).toContain("LiveChild");
			expect(index.content).not.toContain("advisor private note");
			expect(index.content).not.toContain("Main/advisor");

			const advisorLookup = await InternalUrlRouter.instance()
				.resolve("history://Main%2Fadvisor")
				.then(
					() => null,
					err => err as Error,
				);
			expect(advisorLookup).toBeInstanceOf(Error);
			expect(advisorLookup?.message).toContain("Unknown agent");
			expect(advisorLookup?.message).not.toContain("advisor private note");
		});
	});

	it("history:// renders a terminal transcript-only ref from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "aborted.jsonl");
			await Bun.write(
				sessionFile,
				sessionFixtureJsonl({
					id: "aborted-session",
					user: "work before abort",
					assistant: "partial result before abort",
				}),
			);
			AgentRegistry.global().register({
				id: "AbortedChild",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "aborted",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://AbortedChild");

			expect(resource.content).toContain("# AbortedChild (aborted)");
			expect(resource.content).toContain("work before abort");
			expect(resource.content).toContain("partial result before abort");
			expect(resource.sourcePath).toBe(sessionFile);
		});
	});
	it("rejects an unknown id with the list of known agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Nope")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		expect(error?.message).toContain("HubAgent");
	});

	it("rejects a ref with neither session nor session file", async () => {
		AgentRegistry.global().register({
			id: "Husk",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Husk")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error?.message).toContain("no transcript");
	});

	it("hides advisor transcripts from the index and direct lookup", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});

		// Index lists the subagent but never the advisor.
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect(index.content).toContain("HubAgent");
		expect(index.content).not.toContain("advisor");

		// Direct lookup of an advisor-kind ref is reported as unknown — the driving
		// agent must not be able to read it via history://.
		const error = await InternalUrlRouter.instance()
			.resolve("history://AdvisorProbe")
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent");
	});

	it("omits advisor refs from history:// completions", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});

		const completions = await new HistoryProtocolHandler().complete();
		const values = completions.map(c => c.value);
		expect(values).toContain("HubAgent");
		expect(values).not.toContain("AdvisorProbe");
	});
});

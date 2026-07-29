import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type { DaemonCompletionNotification, DaemonRpcResult } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("launch broker protocol compatibility", () => {
	it("replays raw terminal text returned by an already-running legacy broker", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			close() {},
			onCompletion: () => () => {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
			op: "logs",
			name: "web",
			lines: 10,
			head: false,
		});

		expect(result.details?.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
	});

	it("routes a broker completion into the owning session queue", async () => {
		const projectDir = process.cwd();
		const owner = "owner-session";
		const queued: DaemonCompletionNotification[] = [];
		let deliver: ((notification: DaemonCompletionNotification) => void) | undefined;
		const completion = {
			event: "daemon-completed",
			owner,
			daemon: {
				name: "web",
				id: "daemon-id",
				state: "exited",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				exitCode: 0,
				restartCount: 0,
				outputBytes: 0,
				owner,
				persist: false,
				detached: false,
			},
		} satisfies DaemonCompletionNotification;
		const client = {
			projectDir,
			onCompletion: (_owner: string, sink: (notification: DaemonCompletionNotification) => void) => {
				deliver = sink;
				return () => {
					deliver = undefined;
				};
			},
			request: async () => {
				deliver?.(completion);
				return { op: "start", daemon: completion.daemon, readyTimedOut: false } as const;
			},
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		await executeLaunch(
			{
				cwd: projectDir,
				getSessionId: () => owner,
				isDisposed: () => false,
				queueLaunchCompletion: (notification: DaemonCompletionNotification) => queued.push(notification),
			} as unknown as ToolSession,
			{ op: "start", name: "web", application: process.execPath, args: [] },
		);

		expect(queued).toEqual([completion]);
	});
});

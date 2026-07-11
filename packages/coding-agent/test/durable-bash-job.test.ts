import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { DurableBashJobStore, type DurableBashMetadata } from "../src/async/durable-bash";

const fixture = path.join(import.meta.dir, "fixtures", "durable-bash-job-process.ts");
const roots: string[] = [];

function runFixture(mode: "start" | "start-short" | "list" | "cancel", root: string): Record<string, unknown> {
	const proc = Bun.spawnSync([process.execPath, fixture, mode, root], {
		cwd: root,
		env: process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = proc.stdout.toString().trim();
	expect(proc.exitCode, proc.stderr.toString() || stdout).toBe(0);
	return JSON.parse(stdout) as Record<string, unknown>;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		removeSyncWithRetries(root);
	}
});

describe("durable bash background jobs", () => {
	test("survives the spawning process and resumes with readable output and safe cancellation", async () => {
		const root = path.join(os.tmpdir(), `omp-durable-bash-${Snowflake.next()}`);
		roots.push(root);
		fs.mkdirSync(root, { recursive: true });

		const started = runFixture("start", root);
		expect(started).toMatchObject({ async: { state: "running", jobId: "bg_1", type: "bash" } });

		const metadataPath = path.join(root, "session", "jobs", "bg_1.json");
		expect(fs.existsSync(metadataPath), "background job metadata was not persisted").toBe(true);
		const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as DurableBashMetadata;
		const processRef = Process.fromPid(metadata.pid);
		expect(processRef?.status(), "background process died with the spawning OMP process").toBe(ProcessStatus.Running);
		const store = new DurableBashJobStore(path.join(root, "session.jsonl"));
		expect(await store.cancel({ ...metadata, token: "reused-pid-identity" })).toBe(false);
		expect(processRef?.status(), "identity mismatch killed an unrelated process").toBe(ProcessStatus.Running);

		const listed = runFixture("list", root) as {
			details: { jobs: Array<{ id: string; status: string }> };
		};
		expect(listed.details.jobs).toContainEqual(expect.objectContaining({ id: "bg_1", status: "running" }));

		const cancelled = runFixture("cancel", root) as {
			details: { cancelled: Array<{ id: string; status: string }> };
		};
		expect(cancelled.details.cancelled).toEqual([{ id: "bg_1", status: "cancelled" }]);
		expect(await processRef!.waitForExit({ timeoutMs: 3_000 }), "cancel did not stop the durable process").toBe(true);
		expect(fs.existsSync(metadata.statusPath), "cancel did not persist a terminal status").toBe(true);
	});

	test("recovers a completed job with its exit status and durable output", async () => {
		const root = path.join(os.tmpdir(), `omp-durable-bash-complete-${Snowflake.next()}`);
		roots.push(root);
		fs.mkdirSync(root, { recursive: true });

		runFixture("start-short", root);
		const metadata = JSON.parse(fs.readFileSync(path.join(root, "session", "jobs", "bg_1.json"), "utf8")) as {
			pid: number;
			statusPath: string;
		};
		const processRef = Process.fromPid(metadata.pid);
		expect(processRef).not.toBeNull();
		expect(await processRef!.waitForExit({ timeoutMs: 3_000 })).toBe(true);
		expect(JSON.parse(fs.readFileSync(metadata.statusPath, "utf8"))).toMatchObject({ exitCode: 0 });

		const listed = runFixture("list", root) as {
			text: string;
			details: { jobs: Array<{ id: string; status: string; resultText?: string }> };
		};
		expect(listed.details.jobs).toContainEqual(
			expect.objectContaining({ id: "bg_1", status: "completed", resultText: expect.stringContaining("finished") }),
		);
		expect(listed.text).toContain("started");
		expect(listed.text).toContain("finished");
	});
});

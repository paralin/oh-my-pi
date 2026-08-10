import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CronManager } from "../../src/cron.js";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { IpythonCronService } from "../../src/ipython/cron-service.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function request(
	root: string,
	data: Record<string, unknown>,
	signal = new AbortController().signal,
): IpythonHostRequest {
	return {
		requestId: "request-1",
		commId: "comm-1",
		targetName: "host.request",
		data: { type: "cron.create", ...data },
		signal,
		executionId: "execution-1",
		sessionId: "session-1",
		cwd: root,
		cellId: "cell-1",
		sequence: 1,
		origin: "direct",
		authority: "trusted-cell",
		publishProgress: async () => {},
		publishDisplay: async () => {},
		allocateArtifact: async artifact => ({ path: path.join(root, artifact.label + artifact.suffix) }),
	};
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-cron-"));
	roots.push(root);
	const manager = new CronManager({
		sessionFile: path.join(root, "session.jsonl"),
		enqueuePrompt: async () => {},
	});
	const service = new IpythonCronService({ owner: () => manager });
	const call = (operation: string, data: Record<string, unknown> = {}, signal?: AbortSignal) =>
		service.handlers[operation]!(request(root, data, signal));
	return { root, manager, service, call };
}

describe("IPython cron service", () => {
	test("creates, lists, updates, and deletes public jobs", async () => {
		const f = await fixture();
		try {
			const created = await f.call("cron.create", {
				expression: "*/5 * * * *",
				prompt: "check status",
				recurring: false,
			});
			const job = created.job as Record<string, unknown>;
			expect(job).toMatchObject({ expression: "*/5 * * * *", prompt: "check status", recurring: false });
			expect(Object.keys(job).sort()).toEqual([
				"created_at",
				"durable",
				"expression",
				"id",
				"next_fire_at",
				"prompt",
				"recurring",
			]);
			expect(await f.call("cron.list")).toEqual({ jobs: [job] });
			const updated = await f.call("cron.update", { id: String(job.id), prompt: "updated" });
			expect(updated).toEqual({ job: { ...job, prompt: "updated" } });
			expect(await f.call("cron.delete", { id: String(job.id) })).toEqual({ deleted: true });
			expect(await f.call("cron.list")).toEqual({ jobs: [] });
		} finally {
			await f.manager.dispose();
		}
	});

	test("rejects unknown, empty, and malformed fields", async () => {
		const f = await fixture();
		try {
			await expect(f.call("cron.create", { expression: "* * * * *", prompt: "x", extra: true })).rejects.toThrow(
				"unknown field",
			);
			await expect(f.call("cron.create", { expression: "* * * * *", prompt: " " })).rejects.toThrow("nonempty");
			await expect(f.call("cron.update", { id: "x" })).rejects.toThrow("at least one");
			await expect(f.call("cron.update", { id: "x", durable: true })).rejects.toThrow("unknown field");
			await expect(f.call("cron.update", { id: "x", recurring: "yes" })).rejects.toThrow("boolean");
		} finally {
			await f.manager.dispose();
		}
	});

	test("checks cancellation before and after owner calls", async () => {
		const f = await fixture();
		try {
			const before = new AbortController();
			before.abort(new Error("cancelled before"));
			await expect(f.call("cron.list", {}, before.signal)).rejects.toThrow("cancelled before");
			const after = new AbortController();
			// The request signal is checked after prepare/list; aborting from the owner
			// callback proves the boundary without changing manager persistence.
			const ownerService = new IpythonCronService({
				owner: request => {
					request.signal.addEventListener("abort", () => {}, { once: true });
					return f.manager;
				},
			});
			const signal = after.signal;
			const prepare = f.manager.prepare.bind(f.manager);
			(f.manager as unknown as { prepare: () => Promise<void> }).prepare = async () => {
				after.abort(new Error("cancelled after"));
				await prepare();
			};
			await expect(ownerService.handlers["cron.list"]!(request(f.root, {}, signal))).rejects.toThrow(
				"cancelled after",
			);
		} finally {
			await f.manager.dispose();
		}
	});
});

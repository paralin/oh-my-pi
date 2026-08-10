import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { OmpHarnessService } from "../../src/ipython/harness-service";
import { parseAgent } from "../../src/task/agents";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-harness-test-"));
	roots.push(root);
	let refreshes = 0;
	let now = Date.parse("2026-08-06T10:00:00.000Z");
	const service = new OmpHarnessService({
		localRoot: () => path.join(root, "local"),
		globalRoot: path.join(root, "global"),
		refresh: async () => {
			refreshes++;
		},
		now: () => {
			now += 1_000;
			return new Date(now);
		},
	});
	return { root, service, refreshes: () => refreshes };
}

describe("OmpHarnessService", () => {
	test("creates, reads, updates, lists, and deletes scoped entries", async () => {
		const { service, refreshes } = await fixture();
		const created = await service.create({
			kind: "memory",
			id: "test-memory",
			title: "Remember this",
			content: "Source-backed lesson.",
			path: "runtime",
			metadata: { evidence: true },
			global: false,
		});
		expect(created).toMatchObject({
			id: "test-memory",
			kind: "memory",
			scope: "local",
			path: "runtime",
			version: 1,
			metadata: { evidence: true },
		});
		expect(await service.get("memory", "test-memory", false)).toEqual(created);
		expect(await service.get("memory", "test-memory", true)).toBeNull();
		await expect(
			service.create({ kind: "memory", id: "test-memory", title: "Duplicate", content: "No.", global: false }),
		).rejects.toThrow("already exists");

		const updated = await service.update({
			kind: "memory",
			id: "test-memory",
			title: "Remember this now",
			content: "Updated source-backed lesson.",
			global: false,
		});
		expect(updated.version).toBe(2);
		expect(updated.created_at).toBe(created.created_at);
		expect(updated.updated_at).not.toBe(created.updated_at);
		expect(updated.path).toBe("runtime");
		expect(updated.metadata).toEqual({ evidence: true });
		expect(await service.list(undefined, false)).toEqual([updated]);
		expect(await service.delete("memory", "test-memory", false)).toBeTrue();
		expect(await service.delete("memory", "test-memory", false)).toBeFalse();
		expect(refreshes()).toBe(4);
	});

	test("upserts typed entries and exposes a deterministic snapshot and overview", async () => {
		const { root, service } = await fixture();
		const first = await service.upsert({
			kind: "skill",
			id: "review-runtime",
			title: "Review runtime",
			content: "Inspect the runtime.",
			reference: { module: "review_runtime" },
			arguments: { path: "string" },
			global: true,
		});
		const second = await service.upsert({
			kind: "skill",
			id: "review-runtime",
			title: "Review runtime",
			content: "Inspect and verify the runtime.",
			global: true,
		});
		expect(second.version).toBe(2);
		expect(second.reference).toEqual(first.reference);
		expect(second.arguments).toEqual(first.arguments);
		const event = await service.recordRefinement({
			trigger: "Repeated validation gap",
			changes: ["Updated skill:review-runtime"],
			evidence: "Two failed audits",
			outcome: "Audit now runs",
			global: true,
		});
		expect(event.id).toStartWith("refine_");
		const snapshot = await service.snapshot(true);
		expect((snapshot.entries as Record<string, unknown[]>).skill).toEqual([second]);
		expect(snapshot.refinements).toEqual([event]);
		expect(await service.overview(true, 20)).toContain("- review-runtime: Review runtime");
		const skillText = await fs.readFile(
			path.join(root, "global", "managed-skills", "review-runtime", "SKILL.md"),
			"utf8",
		);
		expect(skillText).toContain("name: review-runtime");
		expect(skillText).toContain("Inspect and verify the runtime.");
		const subagent = await service.create({
			kind: "subagent",
			id: "runtime-reviewer",
			title: "Review the runtime",
			content: "Inspect the runtime and report concrete findings.",
			global: true,
		});
		const subagentFile = path.join(root, "global", "managed-agents", "runtime-reviewer.md");
		const parsed = parseAgent(subagentFile, await fs.readFile(subagentFile, "utf8"), "user");
		expect(parsed).toMatchObject({
			name: "runtime-reviewer",
			description: "Review the runtime",
			systemPrompt: subagent.content,
		});
		await expect(fs.stat(path.join(root, "global", "managed-harness"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects unsafe ids, oversized input, and aborted writes", async () => {
		const { service, root } = await fixture();
		await expect(
			service.create({ kind: "prompt", id: "../escape", title: "Unsafe", content: "No", global: false }),
		).rejects.toThrow("harness id");
		await expect(
			service.create({ kind: "prompt", id: "safe", title: "Safe", content: "x".repeat(64_001), global: false }),
		).rejects.toThrow("64000");
		await expect(
			service.create({ kind: "skill", id: "Not_Discoverable", title: "Bad skill", content: "No", global: true }),
		).rejects.toThrow("OMP discovery");
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await expect(
			service.create(
				{ kind: "prompt", id: "safe", title: "Safe", content: "yes", global: false },
				controller.signal,
			),
		).rejects.toThrow("stop");
		await expect(fs.access(path.join(root, "escape.json"))).rejects.toThrow();
		if (process.platform !== "win32") {
			const outside = path.join(root, "outside");
			await fs.mkdir(outside);
			await fs.mkdir(path.join(root, "global"), { recursive: true });
			await fs.symlink(outside, path.join(root, "global", "managed-memory"));
			await expect(
				service.create({ kind: "memory", id: "outside", title: "No escape", content: "No", global: true }),
			).rejects.toThrow("symlink");
			await expect(fs.access(path.join(outside, "outside.md"))).rejects.toThrow();
		}
	});
	test("serializes concurrent upserts through the managed OMP mutation lock", async () => {
		const { service } = await fixture();
		const entries = await Promise.all([
			service.upsert({ kind: "prompt", id: "one-policy", title: "One", content: "First", global: true }),
			service.upsert({ kind: "prompt", id: "one-policy", title: "One", content: "Second", global: true }),
		]);
		expect(entries.map(entry => entry.version).sort()).toEqual([1, 2]);
		expect((await service.get("prompt", "one-policy", true))?.version).toBe(2);
	});
});

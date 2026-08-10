import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { type IpythonGithubOwner, IpythonGithubService } from "../../src/ipython/github-service.js";
import type { GithubInput } from "../../src/tools/gh.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeGithubOwner implements IpythonGithubOwner {
	readonly calls: Array<{ operation: string; params: unknown; signal: AbortSignal }> = [];
	largeIssue = false;

	async execute(params: GithubInput, signal: AbortSignal) {
		this.calls.push({ operation: "execute", params, signal });
		return { content: [{ type: "text" as const, text: "ok" }], details: { repo: params.op } };
	}

	async issue(params: { issue: string; repo?: string; comments: boolean }, signal: AbortSignal) {
		this.calls.push({ operation: "issue", params, signal });
		return this.largeIssue
			? { payload: { body: "x".repeat(600_000) }, status: "fresh" }
			: { payload: { number: Number(params.issue), title: "Issue" }, status: "fresh" };
	}

	async pullRequest(params: { number: number; repo?: string; comments: boolean }, signal: AbortSignal) {
		this.calls.push({ operation: "pullRequest", params, signal });
		return { payload: { number: params.number, title: "Pull request" }, status: "cached" };
	}

	async pullRequestDiff(params: { number: number; repo?: string }, signal: AbortSignal) {
		this.calls.push({ operation: "pullRequestDiff", params, signal });
		return { payload: { unified: "diff --git a/a b/a", files: [{ path: "a" }] }, status: "fresh" };
	}
}

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-github-"));
	roots.push(root);
	const owner = new FakeGithubOwner();
	const service = new IpythonGithubService(owner);
	const progress: string[] = [];
	const call = async (
		operation: string,
		data: Record<string, unknown>,
		signal: AbortSignal = new AbortController().signal,
	) => {
		const handler = service.handlers[operation];
		if (!handler) throw new Error(`missing handler: ${operation}`);
		const request: IpythonHostRequest = {
			requestId: "request-1",
			executionId: "execution-1",
			commId: "comm-1",
			targetName: "host.request",
			data: { type: operation, ...data },
			signal,
			sessionId: "session-1",
			cwd: root,
			cellId: "cell-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			publishProgress: async message => {
				progress.push(message);
			},
			publishDisplay: async () => {},
			allocateArtifact: async artifact => ({ path: path.join(root, `artifact${artifact.suffix}`) }),
		};
		return await handler(request);
	};
	return { root, owner, progress, call };
}

describe("IPython GitHub service", () => {
	test("maps explicit read operations into command, cache, and search owners", async () => {
		const f = await fixture();
		await f.call("github.repo_view", { repo: "owner/repo", branch: "main" });
		await f.call("github.file_read", { repo: "owner/repo", path: "README.md" });
		expect(await f.call("github.issue", { issue: "12", repo: "owner/repo", comments: true })).toMatchObject({
			payload: { number: 12 },
			status: "fresh",
		});
		expect(await f.call("github.pull_request", { number: 13, repo: "owner/repo" })).toMatchObject({
			payload: { number: 13 },
			status: "cached",
		});
		await f.call("github.pull_request_diff", { number: 13, repo: "owner/repo" });
		await f.call("github.search", {
			kind: "pull_requests",
			query: "is:open fix",
			repo: "owner/repo",
			since: "2026-01-01",
			date_field: "updated",
			limit: 5,
		});
		await f.call("github.run", { run: "42", repo: "owner/repo", tail: 20 });
		const executed = f.owner.calls.filter(call => call.operation === "execute").map(call => call.params);
		expect(executed).toEqual([
			{ op: "repo_view", repo: "owner/repo", branch: "main" },
			{ op: "file_read", repo: "owner/repo", path: "README.md", branch: undefined },
			{
				op: "search_prs",
				query: "is:open fix",
				repo: "owner/repo",
				since: "2026-01-01",
				until: undefined,
				dateField: "updated",
				limit: 5,
			},
			{ op: "run_watch", run: "42", repo: "owner/repo", branch: undefined, tail: 20 },
		]);
		expect(f.progress).toContain("GitHub operation completed: search");
	});

	test("maps bounded pull request mutations without exposing a generic tool call", async () => {
		const f = await fixture();
		await f.call("github.create_pull_request", {
			repo: "owner/repo",
			title: "Title",
			body: "Body",
			base: "main",
			head: "feature",
			reviewers: ["octocat"],
		});
		await f.call("github.checkout_pull_request", { pull_requests: ["1", "2"], force: true });
		await f.call("github.push_pull_request", { branch: "feature", force_with_lease: true });
		const executed = f.owner.calls.filter(call => call.operation === "execute").map(call => call.params);
		expect(executed[0]).toMatchObject({
			op: "pr_create",
			title: "Title",
			body: "Body",
			reviewer: ["octocat"],
		});
		expect(executed[1]).toMatchObject({ op: "pr_checkout", pr: ["1", "2"], force: true });
		expect(executed[2]).toMatchObject({ op: "pr_push", branch: "feature", forceWithLease: true });
		await expect(f.call("github.search", { kind: "raw", query: "q" })).rejects.toThrow("kind must be");
		await expect(f.call("github.repo_view", { command: "gh auth token" })).rejects.toThrow("unknown field");
	});

	test("forwards cancellation and spills oversized cached payloads", async () => {
		const f = await fixture();
		const cancelled = new AbortController();
		cancelled.abort(new Error("cell cancelled"));
		await expect(f.call("github.issue", { issue: "1" }, cancelled.signal)).rejects.toThrow("cell cancelled");
		f.owner.largeIssue = true;
		const spilled = await f.call("github.issue", { issue: "1" });
		expect(spilled.truncated).toBe(true);
		const artifact = spilled.artifact as { path: string; mime_type: string; bytes: number };
		expect(artifact.mime_type).toBe("application/json");
		expect(artifact.bytes).toBeGreaterThan(500_000);
		expect((await fs.stat(artifact.path)).size).toBe(artifact.bytes);
	});
});

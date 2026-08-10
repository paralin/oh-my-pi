import * as fs from "node:fs/promises";
import type { ToolSession } from "../session/tool-session";
import {
	executeGithubOperation,
	type GithubInput,
	type GithubOperationResult,
	getOrFetchIssue,
	getOrFetchPr,
	getOrFetchPrDiff,
	resolveDefaultRepoMemoized,
} from "../tools/gh";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_JSON_CHARS = 500_000;
const MAX_STRING_CHARS = 64_000;
const MAX_BODY_CHARS = 1024 * 1024;
const MAX_LIST_ITEMS = 100;

export interface IpythonGithubOwner {
	execute(params: GithubInput, signal: AbortSignal): Promise<GithubOperationResult>;
	issue(params: { issue: string; repo?: string; comments: boolean }, signal: AbortSignal): Promise<unknown>;
	pullRequest(params: { number: number; repo?: string; comments: boolean }, signal: AbortSignal): Promise<unknown>;
	pullRequestDiff(params: { number: number; repo?: string }, signal: AbortSignal): Promise<unknown>;
}

function strict(data: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
	const unknown = Object.keys(data).find(key => key !== "type" && !allowed.includes(key));
	if (unknown) throw new TypeError(`unknown field: ${unknown}`);
}

function stringValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; max?: number } = {},
): string {
	const value = data[name];
	if (value === undefined && options.optional) return "";
	if (typeof value !== "string" || (!options.optional && value.trim().length === 0)) {
		throw new TypeError(`${name} must be ${options.optional ? "a string" : "a nonempty string"}`);
	}
	if (value.length > (options.max ?? MAX_STRING_CHARS)) throw new RangeError(`${name} is too large`);
	return value;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function integerValue(
	data: Readonly<Record<string, unknown>>,
	name: string,
	options: { optional?: boolean; fallback?: number; min?: number; max?: number } = {},
): number | undefined {
	const value = data[name] ?? options.fallback;
	if (value === undefined && options.optional) return undefined;
	const min = options.min ?? 1;
	const max = options.max ?? Number.MAX_SAFE_INTEGER;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function stringList(data: Readonly<Record<string, unknown>>, name: string): string[] {
	const value = data[name];
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS)
		throw new TypeError(`${name} must be a bounded string list`);
	return value.map((item, index) => {
		if (typeof item !== "string" || item.trim().length === 0 || item.length > 512) {
			throw new TypeError(`${name}[${index}] must be a nonempty bounded string`);
		}
		return item;
	});
}

function optionalString(
	data: Readonly<Record<string, unknown>>,
	name: string,
	max = MAX_STRING_CHARS,
): string | undefined {
	return stringValue(data, name, { optional: true, max }) || undefined;
}

function normalizeResult(value: unknown): Readonly<Record<string, unknown>> {
	if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
	return Array.isArray(value) ? { items: value } : { value: value ?? null };
}

async function boundedResult(
	request: IpythonHostRequest,
	label: string,
	value: unknown,
): Promise<Readonly<Record<string, unknown>>> {
	const normalized = normalizeResult(value);
	const encoded = JSON.stringify(normalized, null, 2);
	if (encoded.length <= MAX_JSON_CHARS) return normalized;
	const artifact = await request.allocateArtifact({ label, mimeType: "application/json", suffix: ".json" });
	await fs.writeFile(artifact.path, encoded, "utf8");
	return {
		truncated: true,
		artifact: { ...artifact, bytes: Buffer.byteLength(encoded), mime_type: "application/json" },
	};
}

async function run(
	request: IpythonHostRequest,
	owner: IpythonGithubOwner,
	label: string,
	params: GithubInput,
): Promise<Readonly<Record<string, unknown>>> {
	request.signal.throwIfAborted();
	await request.publishProgress(`GitHub operation started: ${label}`);
	const result = await owner.execute(params, request.signal);
	request.signal.throwIfAborted();
	await request.publishProgress(`GitHub operation completed: ${label}`);
	return await boundedResult(request, `github-${label}`, result);
}

/** Exposes explicit GitHub operations backed by the existing gh and cache owners. */
export class IpythonGithubService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly owner: IpythonGithubOwner) {
		this.handlers = {
			"github.repo_view": request => this.#repoView(request),
			"github.file_read": request => this.#fileRead(request),
			"github.issue": request => this.#issue(request),
			"github.pull_request": request => this.#pullRequest(request),
			"github.pull_request_diff": request => this.#pullRequestDiff(request),
			"github.search": request => this.#search(request),
			"github.run": request => this.#runWatch(request),
			"github.create_pull_request": request => this.#createPullRequest(request),
			"github.checkout_pull_request": request => this.#checkoutPullRequest(request),
			"github.push_pull_request": request => this.#pushPullRequest(request),
		};
	}

	#repoView(request: IpythonHostRequest) {
		strict(request.data, ["repo", "branch"]);
		return run(request, this.owner, "repo-view", {
			op: "repo_view",
			repo: optionalString(request.data, "repo", 256),
			branch: optionalString(request.data, "branch", 512),
		});
	}

	#fileRead(request: IpythonHostRequest) {
		strict(request.data, ["repo", "path", "branch"]);
		return run(request, this.owner, "file-read", {
			op: "file_read",
			repo: optionalString(request.data, "repo", 256),
			path: stringValue(request.data, "path", { max: 4_096 }),
			branch: optionalString(request.data, "branch", 512),
		});
	}

	async #issue(request: IpythonHostRequest) {
		strict(request.data, ["issue", "repo", "comments"]);
		request.signal.throwIfAborted();
		await request.publishProgress("GitHub issue lookup started");
		const result = await this.owner.issue(
			{
				issue: stringValue(request.data, "issue", { max: 2_048 }),
				repo: optionalString(request.data, "repo", 256),
				comments: booleanValue(request.data, "comments", false),
			},
			request.signal,
		);
		request.signal.throwIfAborted();
		await request.publishProgress("GitHub issue lookup completed");
		return await boundedResult(request, "github-issue", result);
	}

	async #pullRequest(request: IpythonHostRequest) {
		strict(request.data, ["number", "repo", "comments"]);
		request.signal.throwIfAborted();
		const result = await this.owner.pullRequest(
			{
				number: integerValue(request.data, "number", { min: 1 }) ?? 1,
				repo: optionalString(request.data, "repo", 256),
				comments: booleanValue(request.data, "comments", false),
			},
			request.signal,
		);
		request.signal.throwIfAborted();
		return await boundedResult(request, "github-pull-request", result);
	}

	async #pullRequestDiff(request: IpythonHostRequest) {
		strict(request.data, ["number", "repo"]);
		request.signal.throwIfAborted();
		const result = await this.owner.pullRequestDiff(
			{
				number: integerValue(request.data, "number", { min: 1 }) ?? 1,
				repo: optionalString(request.data, "repo", 256),
			},
			request.signal,
		);
		request.signal.throwIfAborted();
		return await boundedResult(request, "github-pull-request-diff", result);
	}

	#search(request: IpythonHostRequest) {
		strict(request.data, ["kind", "query", "repo", "since", "until", "date_field", "limit"]);
		const kind = stringValue(request.data, "kind", { max: 16 });
		const operations = {
			issues: "search_issues",
			pull_requests: "search_prs",
			code: "search_code",
			commits: "search_commits",
			repositories: "search_repos",
		} as const;
		const op = operations[kind as keyof typeof operations];
		if (!op) throw new RangeError("kind must be issues, pull_requests, code, commits, or repositories");
		const dateField = optionalString(request.data, "date_field", 16);
		if (dateField && dateField !== "created" && dateField !== "updated") {
			throw new RangeError("date_field must be created or updated");
		}
		return run(request, this.owner, "search", {
			op,
			query: stringValue(request.data, "query", { max: MAX_STRING_CHARS }),
			repo: optionalString(request.data, "repo", 256),
			since: optionalString(request.data, "since", 64),
			until: optionalString(request.data, "until", 64),
			dateField: dateField as "created" | "updated" | undefined,
			limit: integerValue(request.data, "limit", { optional: true, min: 1, max: 50 }),
		});
	}

	#runWatch(request: IpythonHostRequest) {
		strict(request.data, ["run", "repo", "branch", "tail"]);
		return run(request, this.owner, "run-watch", {
			op: "run_watch",
			run: optionalString(request.data, "run", 2_048),
			repo: optionalString(request.data, "repo", 256),
			branch: optionalString(request.data, "branch", 512),
			tail: integerValue(request.data, "tail", { optional: true, min: 1, max: 200 }),
		});
	}

	#createPullRequest(request: IpythonHostRequest) {
		strict(request.data, [
			"repo",
			"title",
			"body",
			"base",
			"head",
			"draft",
			"fill",
			"reviewers",
			"assignees",
			"labels",
		]);
		return run(request, this.owner, "create-pull-request", {
			op: "pr_create",
			repo: optionalString(request.data, "repo", 256),
			title: optionalString(request.data, "title", 4_096),
			body: optionalString(request.data, "body", MAX_BODY_CHARS),
			base: optionalString(request.data, "base", 512),
			head: optionalString(request.data, "head", 512),
			draft: booleanValue(request.data, "draft", false),
			fill: booleanValue(request.data, "fill", false),
			reviewer: stringList(request.data, "reviewers"),
			assignee: stringList(request.data, "assignees"),
			label: stringList(request.data, "labels"),
		});
	}

	#checkoutPullRequest(request: IpythonHostRequest) {
		strict(request.data, ["pull_requests", "repo", "force"]);
		const pulls = stringList(request.data, "pull_requests");
		if (pulls.length === 0) throw new TypeError("pull_requests must not be empty");
		return run(request, this.owner, "checkout-pull-request", {
			op: "pr_checkout",
			pr: pulls,
			repo: optionalString(request.data, "repo", 256),
			force: booleanValue(request.data, "force", false),
		});
	}

	#pushPullRequest(request: IpythonHostRequest) {
		strict(request.data, ["branch", "force_with_lease"]);
		return run(request, this.owner, "push-pull-request", {
			op: "pr_push",
			branch: optionalString(request.data, "branch", 512),
			forceWithLease: booleanValue(request.data, "force_with_lease", false),
		});
	}
}

/** Binds GitHub command, cache, and repository resolution to one tool session. */
export function createIpythonGithubService(session: ToolSession): IpythonGithubService {
	const repo = async (provided: string | undefined, signal: AbortSignal): Promise<string> =>
		provided ?? (await resolveDefaultRepoMemoized(session.cwd, signal));
	return new IpythonGithubService({
		execute: async (params, signal) =>
			(await executeGithubOperation(session, params, signal)) as GithubOperationResult,
		issue: async (params, signal) =>
			await getOrFetchIssue({
				cwd: session.cwd,
				repo: params.repo,
				issue: params.issue,
				includeComments: params.comments,
				signal,
				settings: session.settings,
			}),
		pullRequest: async (params, signal) =>
			await getOrFetchPr({
				cwd: session.cwd,
				repo: await repo(params.repo, signal),
				number: params.number,
				includeComments: params.comments,
				signal,
				settings: session.settings,
			}),
		pullRequestDiff: async (params, signal) =>
			await getOrFetchPrDiff({
				cwd: session.cwd,
				repo: await repo(params.repo, signal),
				number: params.number,
				signal,
				settings: session.settings,
			}),
	});
}

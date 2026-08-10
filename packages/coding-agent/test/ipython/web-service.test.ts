import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { IpythonHostRequest } from "../../src/ipython/controller.js";
import { IpythonWebService } from "../../src/ipython/web-service.js";
import type { SearchQueryParams } from "../../src/web/search/index.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ipython-web-"));
	roots.push(root);
	const searches: Array<{ params: SearchQueryParams; signal: AbortSignal }> = [];
	const fetches: Array<{ params: { path: string; raw?: boolean }; signal: AbortSignal }> = [];
	const progress: string[] = [];
	let largeFetch = false;
	const service = new IpythonWebService({
		search: async (params, signal) => {
			searches.push({ params, signal });
			return {
				content: [{ type: "text" as const, text: "answer" }],
				details: {
					response: {
						provider: "exa" as const,
						answer: "answer",
						sources: [{ title: "Source", url: "https://example.test/source" }],
					},
				},
			};
		},
		fetch: async (params, signal) => {
			fetches.push({ params, signal });
			return {
				content: largeFetch ? "x".repeat(210_000) : "rendered body",
				details: {
					url: params.path,
					finalUrl: params.path,
					contentType: "text/markdown",
					method: "native",
					truncated: false,
					notes: [],
				},
			};
		},
	});
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
	return { root, searches, fetches, progress, call, setLargeFetch: (value: boolean) => (largeFetch = value) };
}

describe("IPython web service", () => {
	test("uses the configured provider owner with typed bounds and cell cancellation", async () => {
		const f = await fixture();
		const result = await f.call("web.search", {
			query: "persistent IPython",
			provider: "exa",
			recency: "week",
			limit: 4,
			max_tokens: 500,
			temperature: 0.2,
			num_search_results: 6,
		});
		expect(result).toMatchObject({ response: { provider: "exa", answer: "answer" }, error: null });
		expect(f.searches[0]?.params).toEqual({
			query: "persistent IPython",
			provider: "exa",
			recency: "week",
			limit: 4,
			max_tokens: 500,
			temperature: 0.2,
			num_search_results: 6,
		});
		expect(f.progress).toEqual(["Web search started", "Web search completed"]);
		await expect(f.call("web.search", { query: "q", provider: "invalid" })).rejects.toThrow(
			"unknown web search provider",
		);
		await expect(f.call("web.search", { query: "q", recency: "hour" })).rejects.toThrow("recency");
		await expect(f.call("web.search", { query: "q", extra: true })).rejects.toThrow("unknown field");
		const cancelled = new AbortController();
		cancelled.abort(new Error("cell cancelled"));
		await expect(f.call("web.search", { query: "q" }, cancelled.signal)).rejects.toThrow("cell cancelled");
	});

	test("fetches and scrapes HTTP resources and spills large bodies", async () => {
		const f = await fixture();
		expect(await f.call("web.fetch", { url: "https://example.test/page", raw: true })).toMatchObject({
			finalUrl: "https://example.test/page",
			content: "rendered body",
			method: "native",
		});
		expect(f.fetches[0]?.params).toEqual({ path: "https://example.test/page", raw: true });
		await f.call("web.scrape", { url: "http://example.test/docs" });
		expect(f.fetches[1]?.params).toEqual({ path: "http://example.test/docs", raw: false });
		await expect(f.call("web.fetch", { url: "file:///tmp/secret" })).rejects.toThrow("HTTP or HTTPS");

		f.setLargeFetch(true);
		const spilled = await f.call("web.fetch", { url: "https://example.test/large" });
		expect(spilled.truncated).toBe(true);
		expect((spilled.content as string).length).toBe(200_000);
		const artifact = spilled.artifact as { path: string; mime_type: string; bytes: number };
		expect(artifact.mime_type).toBe("text/markdown");
		expect(artifact.bytes).toBe(210_000);
		expect((await fs.stat(artifact.path)).size).toBe(210_000);
	});
});

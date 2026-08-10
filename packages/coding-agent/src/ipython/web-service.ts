import * as fs from "node:fs/promises";
import type { ToolSession } from "../session/tool-session";
import { fetchReadUrl } from "../tools/fetch";
import { runSearchQuery, type SearchQueryParams } from "../web/search";
import { isSearchProviderId } from "../web/search/types";
import type { IpythonHostHandlers, IpythonHostRequest } from "./controller";

const MAX_QUERY_CHARS = 16_384;
const MAX_URL_CHARS = 8_192;
const MAX_INLINE_CONTENT_CHARS = 200_000;

interface WebFetchResult {
	readonly content: string;
	readonly details: {
		readonly url: string;
		readonly finalUrl: string;
		readonly contentType: string;
		readonly method: string;
		readonly truncated: boolean;
		readonly notes: readonly string[];
	};
}

export interface IpythonWebServiceOptions {
	readonly search: (params: SearchQueryParams, signal: AbortSignal) => ReturnType<typeof runSearchQuery>;
	readonly fetch: (params: { path: string; raw?: boolean }, signal: AbortSignal) => Promise<WebFetchResult>;
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
	if (value.length > (options.max ?? 16_384)) throw new RangeError(`${name} is too large`);
	return value;
}

function optionalInteger(
	data: Readonly<Record<string, unknown>>,
	name: string,
	min: number,
	max: number,
): number | undefined {
	const value = data[name];
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
		throw new RangeError(`${name} must be an integer from ${min} through ${max}`);
	}
	return value as number;
}

function optionalNumber(
	data: Readonly<Record<string, unknown>>,
	name: string,
	min: number,
	max: number,
): number | undefined {
	const value = data[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new RangeError(`${name} must be a number from ${min} through ${max}`);
	}
	return value;
}

function booleanValue(data: Readonly<Record<string, unknown>>, name: string, fallback: boolean): boolean {
	const value = data[name] ?? fallback;
	if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
	return value;
}

function searchParams(data: Readonly<Record<string, unknown>>): SearchQueryParams {
	strict(data, ["query", "provider", "recency", "limit", "max_tokens", "temperature", "num_search_results"]);
	const provider = stringValue(data, "provider", { optional: true, max: 64 }) || "auto";
	if (provider !== "auto" && !isSearchProviderId(provider))
		throw new RangeError(`unknown web search provider: ${provider}`);
	const recency = stringValue(data, "recency", { optional: true, max: 16 });
	if (recency && !["day", "week", "month", "year"].includes(recency)) {
		throw new RangeError("recency must be day, week, month, or year");
	}
	return {
		query: stringValue(data, "query", { max: MAX_QUERY_CHARS }),
		provider,
		recency: (recency || undefined) as SearchQueryParams["recency"],
		limit: optionalInteger(data, "limit", 1, 20),
		max_tokens: optionalInteger(data, "max_tokens", 1, 32_000),
		temperature: optionalNumber(data, "temperature", 0, 2),
		num_search_results: optionalInteger(data, "num_search_results", 1, 50),
	};
}

function webUrl(data: Readonly<Record<string, unknown>>): string {
	const input = stringValue(data, "url", { max: MAX_URL_CHARS });
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new TypeError("url must be an absolute HTTP or HTTPS URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new TypeError("url must be an absolute HTTP or HTTPS URL");
	}
	return parsed.toString();
}

async function boundedFetchResult(
	request: IpythonHostRequest,
	result: WebFetchResult,
): Promise<Readonly<Record<string, unknown>>> {
	if (result.content.length <= MAX_INLINE_CONTENT_CHARS) {
		return { ...result.details, content: result.content };
	}
	const mimeType = result.details.contentType || "text/plain";
	const suffix = mimeType.includes("html") ? ".html" : ".txt";
	const artifact = await request.allocateArtifact({ label: "web-fetch", mimeType, suffix });
	await fs.writeFile(artifact.path, result.content, "utf8");
	return {
		...result.details,
		content: result.content.slice(0, MAX_INLINE_CONTENT_CHARS),
		truncated: true,
		artifact: { ...artifact, bytes: Buffer.byteLength(result.content), mime_type: mimeType },
	};
}

/** Exposes web search and fetch owners without forwarding through an AgentTool. */
export class IpythonWebService {
	readonly handlers: IpythonHostHandlers;

	constructor(private readonly options: IpythonWebServiceOptions) {
		this.handlers = {
			"web.search": request => this.#search(request),
			"web.fetch": request => this.#fetch(request),
			"web.scrape": request => this.#fetch(request),
		};
	}

	async #search(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		request.signal.throwIfAborted();
		const params = searchParams(request.data);
		await request.publishProgress("Web search started", { query: params.query, provider: params.provider ?? "auto" });
		const result = await this.options.search(params, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress("Web search completed", { provider: result.details.response.provider });
		return { response: result.details.response, error: result.details.error ?? null };
	}

	async #fetch(request: IpythonHostRequest): Promise<Readonly<Record<string, unknown>>> {
		strict(request.data, ["url", "raw"]);
		request.signal.throwIfAborted();
		const url = webUrl(request.data);
		const raw = booleanValue(request.data, "raw", false);
		await request.publishProgress("Web fetch started", { url });
		const result = await this.options.fetch({ path: url, raw }, request.signal);
		request.signal.throwIfAborted();
		await request.publishProgress("Web fetch completed", { url: result.details.finalUrl });
		return await boundedFetchResult(request, result);
	}
}

/** Binds the web service to one session's settings, credentials, and artifact owner. */
export function createIpythonWebService(session: ToolSession): IpythonWebService {
	return new IpythonWebService({
		search: async (params, signal) =>
			await runSearchQuery(params, {
				authStorage: session.authStorage,
				modelRegistry: session.modelRegistry,
				sessionId: session.getSessionId?.() ?? undefined,
				signal,
			}),
		fetch: async (params, signal) => {
			if (!session.settings.get("fetch.enabled")) throw new Error("URL reads are disabled by settings.");
			return await fetchReadUrl(session, params, signal);
		},
	});
}

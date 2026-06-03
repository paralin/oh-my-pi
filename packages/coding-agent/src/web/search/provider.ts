// Lazy registry of web search providers.
//
// `PROVIDER_META` is the **single source of truth** for the web-search provider
// chain: order, label, credential hint, and lazy loader all live here. The
// settings schema (`providers.webSearch`), the TUI setup wizard, and the CLI
// `omp web-search` command derive their option lists from this table, so a new
// provider only needs an entry here (plus its module) to be exposed
// everywhere.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchProvider } from "./providers/base";
import type { SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";

interface ProviderMeta {
	readonly id: SearchProviderId;
	readonly label: string;
	/** Short credential/setup hint surfaced in the TUI selector. */
	readonly description: string;
	readonly load: () => Promise<SearchProvider>;
}

/**
 * Canonical chain order. `resolveProviderChain` walks providers in this order
 * during `auto` resolution, and `SEARCH_PROVIDER_OPTIONS` mirrors it (after
 * `auto`) so the TUI/CLI preference list reflects the same priority the
 * resolver uses.
 */
const PROVIDER_META = [
	{
		id: "tavily",
		label: "Tavily",
		description: "Requires TAVILY_API_KEY",
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	{
		id: "perplexity",
		label: "Perplexity",
		description: "Requires PERPLEXITY_COOKIES or PERPLEXITY_API_KEY",
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	{
		id: "brave",
		label: "Brave",
		description: "Requires BRAVE_API_KEY",
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	{
		id: "jina",
		label: "Jina",
		description: "Requires JINA_API_KEY",
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	{
		id: "kimi",
		label: "Kimi",
		description: "Requires MOONSHOT_SEARCH_API_KEY or MOONSHOT_API_KEY",
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	{
		id: "anthropic",
		label: "Anthropic",
		description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)",
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	{
		id: "gemini",
		label: "Gemini",
		description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)",
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	{
		id: "codex",
		label: "OpenAI",
		description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)",
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	{
		id: "zai",
		label: "Z.AI",
		description: "Calls Z.AI webSearchPrime MCP",
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	{
		id: "exa",
		label: "Exa",
		description: "Requires EXA_API_KEY",
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	{
		id: "parallel",
		label: "Parallel",
		description: "Requires PARALLEL_API_KEY",
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	{
		id: "kagi",
		label: "Kagi",
		description: "Requires KAGI_API_KEY (Kagi V1 Search API)",
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	{
		id: "synthetic",
		label: "Synthetic",
		description: "Requires SYNTHETIC_API_KEY",
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	{
		id: "searxng",
		label: "SearXNG",
		description: "Requires SEARXNG_ENDPOINT or searxng.endpoint",
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
] as const satisfies readonly ProviderMeta[];

// Compile-time exhaustiveness: a new `SearchProviderId` without a
// `PROVIDER_META` entry fails type-checking here, which in turn means it would
// be missing from the TUI/CLI selectors.
type _AllIdsRegistered = Exclude<SearchProviderId, (typeof PROVIDER_META)[number]["id"]> extends never
	? true
	: never;
const _allIdsRegistered: _AllIdsRegistered = true;
void _allIdsRegistered;

const META_BY_ID: ReadonlyMap<SearchProviderId, ProviderMeta> = new Map(
	PROVIDER_META.map(meta => [meta.id, meta]),
);

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return META_BY_ID.get(id)?.label ?? id;
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = META_BY_ID.get(id);
	if (!meta) {
		throw new Error(`Unknown search provider: ${id}`);
	}
	const provider = await meta.load();
	instanceCache.set(id, provider);
	return provider;
}

/** Canonical provider chain — the order `auto` resolution walks providers. */
export const SEARCH_PROVIDER_ORDER: readonly SearchProviderId[] = PROVIDER_META.map(meta => meta.id);

/**
 * Allowed values for `providers.webSearch`: `auto` followed by every registered
 * provider id, in chain order. Used as the settings schema enum domain.
 */
export const SEARCH_PROVIDER_PREFERENCES = ["auto", ...PROVIDER_META.map(meta => meta.id)] as const;

/** Stored preference value: `auto` or one of the registered provider ids. */
export type SearchProviderPreference = (typeof SEARCH_PROVIDER_PREFERENCES)[number];

/** UI option metadata for the TUI selector — `auto` first, then providers in chain order. */
export const SEARCH_PROVIDER_OPTIONS: ReadonlyArray<{
	readonly value: SearchProviderPreference;
	readonly label: string;
	readonly description: string;
}> = [
	{ value: "auto", label: "Auto", description: "Preferred web-search provider" },
	...PROVIDER_META.map(meta => ({
		value: meta.id,
		label: meta.label,
		description: meta.description,
	})),
];

/** Preferred provider set via settings (default: auto) */
let preferredProvId: SearchProviderPreference = "auto";

/** Set the preferred web search provider from settings */
export function setPreferredSearchProvider(provider: SearchProviderPreference): void {
	preferredProvId = provider;
}

/**
 * Determine which providers are configured and currently available.
 * Each candidate is loaded (and its `isAvailable()` called) only as the chain
 * is walked, so unconfigured providers never pay the load cost.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	preferredProvider: SearchProviderPreference = preferredProvId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	if (preferredProvider !== "auto") {
		const provider = await getSearchProvider(preferredProvider);
		if (await provider.isAvailable(authStorage)) {
			providers.push(provider);
		}
	}

	for (const id of SEARCH_PROVIDER_ORDER) {
		if (id === preferredProvider) continue;
		const provider = await getSearchProvider(id);
		if (await provider.isAvailable(authStorage)) {
			providers.push(provider);
		}
	}

	return providers;
}

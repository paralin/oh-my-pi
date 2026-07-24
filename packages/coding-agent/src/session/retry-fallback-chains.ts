import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, formatModelStringWithRouting, parseModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";

/** Configured fallback chains keyed by role or model selector. */
export type RetryFallbackChains = Record<string, string[]>;

/** Policy controlling restoration of a fallback chain's primary model. */
export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

/** Parsed model selector used by retry fallback resolution. */
export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

/** Active retry fallback state retained until the primary can be restored. */
export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Calculates capped exponential retry delay with downward jitter. */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** Parses a configured retry fallback selector. */
export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/** Whether a fallback-chain key is a model selector rather than a role. */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/** Whether a fallback-chain key or entry is a provider wildcard. */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/** Splits a wildcard selector into provider and optional model-id prefix. */
export function parseRetryFallbackWildcard(
	key: string,
	isKnownProvider: (provider: string) => boolean,
): { provider: string; idPrefix: string | undefined } {
	const template = key.slice(0, -2);
	const slash = template.indexOf("/");
	if (slash < 0 || isKnownProvider(template)) return { provider: template, idPrefix: undefined };
	return { provider: template.slice(0, slash), idPrefix: template.slice(slash + 1) };
}

/** Formats a concrete model and thinking level as a fallback selector. */
export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

/** Formats the model-only portion of a parsed fallback selector. */
export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** Whether a provider is registered or configured for discovery. */
export function isKnownProvider(modelRegistry: ModelRegistry, provider: string): boolean {
	return modelRegistry.hasProvider(provider);
}

/** Resolves configured fallback chains, applying the default chain to named roles. */
export function getRetryFallbackChains(settings: Settings): RetryFallbackChains {
	const configuredChains = settings.get("retry.fallbackChains");
	if (!configuredChains || typeof configuredChains !== "object") return {};
	const chains: RetryFallbackChains = { ...configuredChains };
	const defaultChain = chains.default;
	if (Array.isArray(defaultChain)) {
		for (const role in settings.getModelRoles()) {
			if (role !== "default" && chains[role] === undefined) chains[role] = defaultChain;
		}
	}
	return chains;
}

/** Validates configured fallback chains and reports each warning. */
export function validateRetryFallbackChains(
	settings: Settings,
	modelRegistry: ModelRegistry,
	warn: (message: string) => void,
): void {
	const configuredChains = settings.get("retry.fallbackChains");
	if (configuredChains === undefined) return;
	const report = (message: string) => {
		logger.warn(message);
		warn(message);
	};
	if (!configuredChains || typeof configuredChains !== "object" || Array.isArray(configuredChains)) {
		report("retry.fallbackChains must be a mapping of role names or model selectors to selector arrays.");
		return;
	}

	for (const key in configuredChains) {
		const chain = configuredChains[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				const { provider } = parseRetryFallbackWildcard(key, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, modelRegistry);
				if (!parsedKey) {
					report(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (!modelRegistry.find(parsedKey.provider, parsedKey.id)) {
					report(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (!Array.isArray(chain)) {
			report(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		for (const selectorStr of chain) {
			if (typeof selectorStr !== "string") {
				report(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (isRetryFallbackWildcardKey(selectorStr)) {
				const { provider } = parseRetryFallbackWildcard(selectorStr, candidate =>
					isKnownProvider(modelRegistry, candidate),
				);
				if (!isKnownProvider(modelRegistry, provider)) {
					report(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selectorStr}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selectorStr, modelRegistry);
			if (!parsed) {
				report(`Invalid fallback selector format in ${keyKind} '${key}': ${selectorStr}`);
				continue;
			}
			if (!modelRegistry.find(parsed.provider, parsed.id)) {
				report(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selectorStr}`);
			}
		}
	}
}

/** Returns the configured fallback-primary restoration policy. */
export function getRetryFallbackRevertPolicy(settings: Settings): RetryFallbackRevertPolicy {
	return settings.get("retry.fallbackRevertPolicy") === "never" ? "never" : "cooldown-expiry";
}

/** Resolves the primary selector represented by a fallback-chain key. */
export function getRetryFallbackPrimarySelector(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(role)) return undefined;
	if (isRetryFallbackModelKey(role)) return parseRetryFallbackSelector(role, modelRegistry);
	const configuredSelector = settings.getModelRole(role);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, modelRegistry) : undefined;
}

/** Parses one configured fallback-chain entry relative to the current model. */
export function parseRetryFallbackChainEntry(
	entry: string,
	current: RetryFallbackSelector | undefined,
	modelRegistry: ModelRegistry,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(entry)) {
		if (!current) return undefined;
		const { provider, idPrefix } = parseRetryFallbackWildcard(entry, candidate =>
			isKnownProvider(modelRegistry, candidate),
		);
		const bareId = current.id.slice(current.id.lastIndexOf("/") + 1);
		let id: string;
		if (idPrefix !== undefined) {
			id = `${idPrefix}/${bareId}`;
		} else if (
			bareId !== current.id &&
			!modelRegistry.find(provider, current.id) &&
			modelRegistry.find(provider, bareId)
		) {
			// Aggregator → direct: the failing id carries a vendor prefix the
			// target provider does not use (openrouter/google/x → google-vertex/x).
			id = bareId;
		} else {
			id = current.id;
		}
		return { raw: `${provider}/${id}`, provider, id, thinkingLevel: undefined };
	}
	return parseRetryFallbackSelector(entry, modelRegistry);
}

/** Builds a fallback chain beginning with its effective primary selector. */
export function getRetryFallbackEffectiveChain(
	settings: Settings,
	modelRegistry: ModelRegistry,
	role: string,
	currentSelector?: string,
): RetryFallbackSelector[] {
	const parsedCurrent = currentSelector ? parseRetryFallbackSelector(currentSelector, modelRegistry) : undefined;
	const seen = new Set<string>();
	const chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(role)) {
		if (parsedCurrent) {
			chain.push(parsedCurrent);
			seen.add(parsedCurrent.raw);
		}
	} else {
		const primarySelector = getRetryFallbackPrimarySelector(settings, modelRegistry, role);
		if (!primarySelector) return [];
		chain.push(primarySelector);
		seen.add(primarySelector.raw);
	}
	for (const selector of getRetryFallbackChains(settings)[role] ?? []) {
		const parsed = parseRetryFallbackChainEntry(selector, parsedCurrent, modelRegistry);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Model resolution for a walk.
 *
 * The prototype resolves against the bundled catalog and leans on the ai
 * package's environment-key fallback, so a walk needs no auth wiring of its own
 * and no credential ever passes through the graph.
 */
import { getEnvApiKey, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";

/** A model plus the provider whose environment key must be present to use it. */
export interface ResolvedModel {
	model: Model;
	provider: string;
}

/**
 * Resolve `provider/model-id` (or a bare model id) against the bundled catalog.
 *
 * Fails when the provider has no environment key rather than at the first LLM
 * call, so a misconfigured run costs nothing.
 */
export function resolveModel(reference: string): ResolvedModel {
	const [head, ...rest] = reference.split(":");
	const provider = rest.length > 0 ? head : "openrouter";
	const modelId = rest.length > 0 ? rest.join(":") : reference;
	if (!getBundledProviders().includes(provider as never)) {
		throw new Error(`unknown provider: ${provider}`);
	}
	const model = getBundledModels(provider as never).find(candidate => candidate.id === modelId);
	if (!model) throw new Error(`model not found in bundled catalog: ${provider}:${modelId}`);
	if (!getEnvApiKey(provider)) throw new Error(`no environment API key available for provider: ${provider}`);
	return { model, provider };
}

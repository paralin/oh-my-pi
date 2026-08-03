import { resolveThresholdTokens, type TokenizerMode } from "@oh-my-pi/pi-agent-core";
import { deriveClaudeDeviceId } from "@oh-my-pi/pi-ai";
import { getInstallId } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { SettingValue } from "../config/settings-schema";
import type { AuthStorage } from "./auth-storage";
import { resolveCompactionStrategy } from "./compaction-strategy";

export interface EffectiveSessionProfile {
	thresholdTokens: number;
	strategy: SettingValue<"compaction.strategy">;
	tokenizerMode: TokenizerMode;
}

const MAX_METADATA_USER_ID_LENGTH = 256;

function serializeBoundedUserId(userId: Record<string, unknown>): string {
	let serialized = JSON.stringify(userId);
	if (serialized.length <= MAX_METADATA_USER_ID_LENGTH) return serialized;

	delete userId.profile;
	serialized = JSON.stringify(userId);
	if (serialized.length <= MAX_METADATA_USER_ID_LENGTH) return serialized;

	const sessionId = String(userId.session_id);
	for (const key of ["device_id", "account_uuid"]) {
		const candidate = { ...userId };
		delete candidate[key];
		if (JSON.stringify(candidate).length <= MAX_METADATA_USER_ID_LENGTH) return JSON.stringify(candidate);
	}

	for (const key of ["device_id", "account_uuid"]) {
		userId.session_id = "";
		if (JSON.stringify(userId).length <= MAX_METADATA_USER_ID_LENGTH) {
			userId.session_id = sessionId;
			break;
		}
		delete userId[key];
	}
	userId.session_id = sessionId;

	const sessionIdSuffix = `-${Bun.hash(sessionId).toString(16).padStart(16, "0")}`;
	const serializeSessionId = (length: number): string => {
		userId.session_id = `${sessionId.slice(0, length)}${sessionIdSuffix}`;
		return JSON.stringify(userId);
	};
	serialized = serializeSessionId(0);
	if (serialized.length > MAX_METADATA_USER_ID_LENGTH) {
		for (const key of ["device_id", "account_uuid"]) {
			delete userId[key];
			serialized = serializeSessionId(0);
			if (serialized.length <= MAX_METADATA_USER_ID_LENGTH) break;
		}
	}

	let low = 0;
	let high = sessionId.length;
	while (low < high) {
		const candidateLength = Math.ceil((low + high) / 2);
		serialized = serializeSessionId(candidateLength);
		if (serialized.length <= MAX_METADATA_USER_ID_LENGTH) {
			low = candidateLength;
		} else {
			high = candidateLength - 1;
		}
	}
	serialized = serializeSessionId(low);
	return serialized;
}

function resolveProfileCompactionStrategy(
	settings: Pick<Settings, "get">,
	imageInputSupported: boolean,
): SettingValue<"compaction.strategy"> {
	const strategy = resolveCompactionStrategy(settings.get("compaction.enabled"), settings.get("compaction.strategy"));
	return strategy === "snapcompact" && !imageInputSupported ? "context-full" : strategy;
}

export function buildEffectiveSessionProfile(
	settings: Pick<Settings, "get" | "getGroup">,
	tokenizerMode: TokenizerMode,
	contextWindow: number,
	imageInputSupported = true,
): EffectiveSessionProfile {
	return {
		thresholdTokens: resolveThresholdTokens(contextWindow, settings.getGroup("compaction")),
		strategy: resolveProfileCompactionStrategy(settings, imageInputSupported),
		tokenizerMode,
	};
}
export function overrideSessionMetadataCompactionStrategy(
	metadata: Record<string, unknown> | undefined,
	strategy: SettingValue<"compaction.strategy">,
): Record<string, unknown> | undefined {
	if (typeof metadata?.user_id !== "string") return metadata;
	try {
		const userId: unknown = JSON.parse(metadata.user_id);
		if (typeof userId !== "object" || userId === null || Array.isArray(userId)) return metadata;
		const profile = "profile" in userId ? userId.profile : undefined;
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return metadata;
		return {
			...metadata,
			user_id: serializeBoundedUserId({
				...userId,
				profile: { ...profile, s: strategy },
			}),
		};
	} catch {
		return metadata;
	}
}

/**
 * Build the per-request `metadata` payload for the Anthropic provider, shaped
 * like real Claude Code's `getAPIMetadata` output (`{ session_id, account_uuid,
 * device_id }`) so the backend buckets requests under one session and attributes
 * them to the authenticated OAuth account when available. Resolved at request
 * time so token refreshes and login/logout transitions don't strand a stale
 * account UUID in memory. `account_uuid` and `device_id` are omitted for
 * non-Anthropic providers to avoid leaking the user's Claude identity to
 * third-party APIs (including Anthropic-format-compatible proxies such as
 * cloudflare-ai-gateway or gitlab-duo).
 *
 * Installed via `Agent#setMetadataResolver` on the main `AgentSession`, each
 * subagent session, and the separately constructed advisor `Agent` — each with
 * its own provider session id — so Main, subagent, and Advisor requests each
 * expose a distinct, stable provider-facing session identity.
 *
 * `provider` is the target provider string (e.g. `"anthropic"`) and gates the
 * `account_uuid` and `device_id` lookups — only `"anthropic"` requests carry them.
 *
 * `sessionId` is forwarded to the auth-storage session-sticky lookup so that
 * multi-credential setups attribute to the same OAuth account used for the
 * actual API request rather than always picking the first credential.
 *
 * `authStorage` is treated as optional so test fixtures that stub `modelRegistry`
 * without a real storage layer still work; the resolver simply skips the lookup
 * and emits `{ session_id }` alone, matching the no-OAuth-credential path.
 */
export function buildSessionMetadata(
	sessionId: string,
	provider: string,
	authStorage: AuthStorage | undefined,
	profile?: EffectiveSessionProfile,
): Record<string, unknown> {
	const userId: Record<string, unknown> = { session_id: sessionId };
	if (provider === "anthropic" && profile) {
		userId.profile = {
			t: profile.thresholdTokens,
			s: profile.strategy,
			z: profile.tokenizerMode,
		};
	}
	// Only look up account_uuid when the request is going to Anthropic. Injecting
	// a Claude OAuth account_uuid into requests bound for other providers (including
	// Anthropic-format-compatible proxies like cloudflare-ai-gateway or gitlab-duo)
	// would leak the user's Anthropic identity to unrelated third-party APIs.
	if (provider === "anthropic") {
		const accountUuid = authStorage?.getOAuthAccountId("anthropic", sessionId);
		if (typeof accountUuid === "string" && accountUuid.length > 0) {
			userId.account_uuid = accountUuid;
			// Claude Code's `device_id` is a stable 64-hex account-scoped install
			// identifier. Include both omp's persistent install id and the Claude
			// account UUID so two accounts on the same install do not share a device.
			userId.device_id = deriveClaudeDeviceId(getInstallId(), accountUuid);
		}
	}
	return { user_id: serializeBoundedUserId(userId) };
}

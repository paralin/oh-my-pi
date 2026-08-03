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

/**
 * Effective threshold policy for requests the idle compaction timer triggers.
 *
 * Idle compaction has its own gate and its own token count
 * (`compaction.idleEnabled` / `compaction.idleThresholdTokens`, applied by
 * `#scheduleIdleCompaction`) and still runs when `compaction.enabled` is false,
 * so an idle-triggered request is never governed by the normal
 * `compaction.threshold*` policy that {@link EffectiveSessionProfile} records.
 */
export interface EffectiveIdleThreshold {
	/** Whether the idle threshold is in force for this session at all. */
	enabled: boolean;
	/** Token count above which idle compaction triggers; 0 when unconfigured. */
	thresholdTokens: number;
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
	const strategy = resolveProfileCompactionStrategy(settings, imageInputSupported);
	return {
		thresholdTokens: strategy === "off" ? 0 : resolveThresholdTokens(contextWindow, settings.getGroup("compaction")),
		strategy,
		tokenizerMode,
	};
}

export function buildEffectiveIdleThreshold(settings: Pick<Settings, "getGroup">): EffectiveIdleThreshold {
	const { idleEnabled, idleThresholdTokens } = settings.getGroup("compaction");
	// The idle timer compares usage against the configured count directly — no
	// context-window clamp and no reserve — so the raw value is the policy.
	return {
		enabled: idleEnabled,
		thresholdTokens: Number.isFinite(idleThresholdTokens) && idleThresholdTokens > 0 ? idleThresholdTokens : 0,
	};
}

/**
 * Relabel the profile a live request already carries with the compaction policy
 * that actually governs that request.
 *
 * `strategy` is the action the request performs, which can differ from the
 * session's configured strategy: an auto-handoff that fell back to a
 * context-full summary, or idle compaction running while `compaction.enabled` is
 * false and the profile therefore reports `off`.
 *
 * `idleThreshold` additionally relabels the threshold for idle-triggered
 * requests, which fire on `compaction.idleThresholdTokens`. Leaving the normal
 * `compaction.threshold*` value in place would attribute them to a threshold
 * that did not fire — and, with `compaction.enabled` false, to one that is not in
 * force at all. A disabled idle gate reports `0`, distinguishing "no threshold
 * governs this request" from "the threshold is N". Omit it for ordinary
 * compaction, whose profile already records the threshold that governs it.
 */
export function overrideSessionMetadataCompactionStrategy(
	metadata: Record<string, unknown> | undefined,
	strategy: SettingValue<"compaction.strategy">,
	idleThreshold?: EffectiveIdleThreshold,
): Record<string, unknown> | undefined {
	if (typeof metadata?.user_id !== "string") return metadata;
	try {
		const userId: unknown = JSON.parse(metadata.user_id);
		if (typeof userId !== "object" || userId === null || Array.isArray(userId)) return metadata;
		const profile = "profile" in userId ? userId.profile : undefined;
		if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return metadata;
		const thresholdOverride = idleThreshold
			? { t: idleThreshold.enabled ? idleThreshold.thresholdTokens : 0 }
			: undefined;
		return {
			...metadata,
			user_id: serializeBoundedUserId({
				...userId,
				profile: { ...profile, ...thresholdOverride, s: strategy },
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
 * It also gates the 256-character `user_id` bounding, which is Anthropic's own
 * limit: other providers forward the caller-supplied session id verbatim.
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
	// The 256-character cap is Anthropic's own `metadata.user_id` limit, so only
	// Anthropic requests are bounded. Other providers receive this value as the
	// caller-supplied session identity and key prompt affinity on it (in the
	// Anthropic-format transports an explicit `metadata.user_id` takes precedence
	// over the prompt-cache-key fallback), so truncating and hash-suffixing a long
	// `--provider-session-id` there would both drop the identity the caller passed
	// in full and rotate the affinity key of an already-warmed session on resume.
	return { user_id: provider === "anthropic" ? serializeBoundedUserId(userId) : JSON.stringify(userId) };
}

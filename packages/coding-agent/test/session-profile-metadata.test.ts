import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AuthStorage } from "../src/session/auth-storage";
import {
	buildEffectiveIdleThreshold,
	buildEffectiveSessionProfile,
	buildSessionMetadata,
	overrideSessionMetadataCompactionStrategy,
} from "../src/session/session-metadata";

const ACCOUNT_UUID = "abcd1234-abcd-1234-abcd-1234abcd1234";
const SESSION_ID = "12345678-1234-4234-8234-123456789012";

describe("session profile metadata", () => {
	it("preserves OAuth attribution in bounded effective profile metadata", () => {
		const syntheticConfigPath = "/home/tester/private/config.yml";
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 120000,
			"compaction.strategy": "scratch-handoff",
		});
		const profile = buildEffectiveSessionProfile(settings, "accurate", 200_000);
		const profileWithPath = { ...profile, configPaths: [syntheticConfigPath] };
		const authStorage = {
			getOAuthAccountId: () => ACCOUNT_UUID,
		} as unknown as AuthStorage;
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", authStorage, profileWithPath);
		const resumedMetadata = buildSessionMetadata(SESSION_ID, "anthropic", authStorage, profileWithPath);
		const userId = JSON.parse(String(metadata.user_id)) as Record<string, unknown>;
		const profileMetadata = userId.profile as Record<string, unknown>;

		expect(metadata).toEqual(resumedMetadata);
		expect(String(metadata.user_id)).not.toContain(syntheticConfigPath);
		expect(userId).toMatchObject({
			session_id: SESSION_ID,
			account_uuid: ACCOUNT_UUID,
			device_id: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(profileMetadata).toEqual({ t: 120000, s: "scratch-handoff", z: "accurate" });
		expect(String(metadata.user_id).length).toBeLessThan(256);
	});

	it("reports disabled compaction as off", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.strategy": "handoff",
		});

		expect(buildEffectiveSessionProfile(settings, "estimate", 200_000)).toMatchObject({
			thresholdTokens: 0,
			strategy: "off",
		});
	});

	it("reports the text-only snapcompact fallback as context-full", () => {
		const settings = Settings.isolated({
			"compaction.strategy": "snapcompact",
		});

		expect(buildEffectiveSessionProfile(settings, "estimate", 200_000, false).strategy).toBe("context-full");
		expect(buildEffectiveSessionProfile(settings, "estimate", 200_000, true).strategy).toBe("snapcompact");
	});

	it("reports the actual context-full strategy for fallback compaction requests", () => {
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, {
			thresholdTokens: 120_000,
			strategy: "handoff",
			tokenizerMode: "accurate",
		});
		const overridden = overrideSessionMetadataCompactionStrategy(metadata, "context-full");
		const userId = JSON.parse(String(overridden?.user_id)) as { profile: Record<string, unknown> };

		// Ordinary compaction keeps the threshold that actually governs it.
		expect(userId.profile).toEqual({ t: 120_000, s: "context-full", z: "accurate" });
	});

	it("overrides disabled profile metadata for an independent idle handoff", () => {
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, {
			thresholdTokens: 120_000,
			strategy: "off",
			tokenizerMode: "accurate",
		});
		const overridden = overrideSessionMetadataCompactionStrategy(metadata, "handoff");
		const userId = JSON.parse(String(overridden?.user_id)) as { profile: { s: string } };

		expect(userId.profile.s).toBe("handoff");
	});

	it("reports the idle threshold when it differs from the normal compaction threshold", () => {
		const settings = Settings.isolated({
			"compaction.strategy": "context-full",
			"compaction.thresholdTokens": 120_000,
			"compaction.idleEnabled": true,
			"compaction.idleThresholdTokens": 40_000,
		});
		const metadata = buildSessionMetadata(
			SESSION_ID,
			"anthropic",
			undefined,
			buildEffectiveSessionProfile(settings, "estimate", 200_000),
		);
		const overridden = overrideSessionMetadataCompactionStrategy(
			metadata,
			"context-full",
			buildEffectiveIdleThreshold(settings),
		);
		const ordinaryUserId = JSON.parse(String(metadata.user_id)) as { profile: Record<string, unknown> };
		const idleUserId = JSON.parse(String(overridden?.user_id)) as { profile: Record<string, unknown> };

		expect(ordinaryUserId.profile).toEqual({ t: 120_000, s: "context-full", z: "estimate" });
		expect(idleUserId.profile).toEqual({ t: 40_000, s: "context-full", z: "estimate" });
	});

	it("reports the idle threshold for an idle handoff while ordinary compaction is disabled", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.strategy": "handoff",
			"compaction.thresholdTokens": 120_000,
			"compaction.idleEnabled": true,
			"compaction.idleThresholdTokens": 40_000,
		});
		const profile = buildEffectiveSessionProfile(settings, "estimate", 200_000);
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, profile);
		const overridden = overrideSessionMetadataCompactionStrategy(
			metadata,
			"handoff",
			buildEffectiveIdleThreshold(settings),
		);
		const userId = JSON.parse(String(overridden?.user_id)) as { profile: Record<string, unknown> };

		expect(profile.strategy).toBe("off");
		expect(userId.profile).toEqual({ t: 40_000, s: "handoff", z: "estimate" });
	});

	it("reports no threshold in force when the idle gate is off", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 120_000,
			"compaction.idleEnabled": false,
			"compaction.idleThresholdTokens": 40_000,
		});
		const metadata = buildSessionMetadata(
			SESSION_ID,
			"anthropic",
			undefined,
			buildEffectiveSessionProfile(settings, "estimate", 200_000),
		);
		const overridden = overrideSessionMetadataCompactionStrategy(
			metadata,
			"context-full",
			buildEffectiveIdleThreshold(settings),
		);
		const userId = JSON.parse(String(overridden?.user_id)) as { profile: Record<string, unknown> };

		expect(userId.profile).toEqual({ t: 0, s: "context-full", z: "estimate" });
	});

	it("reports the tokenizer implementation's module-load mode", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				'import { getTokenizerMode } from "@oh-my-pi/pi-agent-core"; process.env.PI_TOKENIZER_ACCURATE = "0"; console.log(getTokenizerMode());',
			],
			{
				env: { ...Bun.env, PI_TOKENIZER_ACCURATE: "1", NODE_ENV: "production" },
				stdout: "pipe",
			},
		);

		expect(await child.exited).toBe(0);
		expect((await new Response(child.stdout).text()).trim()).toBe("accurate");
	});

	it("records the effective percentage threshold for the active context window", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": -1,
			"compaction.thresholdPercent": 80,
		});
		const profile = buildEffectiveSessionProfile(settings, "estimate", 200_000);
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, profile);
		const userId = JSON.parse(String(metadata.user_id)) as Record<string, unknown>;

		expect((userId.profile as Record<string, unknown>).t).toBe(160_000);
	});

	it("records the effective default reserve-based threshold", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": -1,
			"compaction.thresholdPercent": -1,
			"compaction.reserveTokens": undefined,
		});
		const profile = buildEffectiveSessionProfile(settings, "estimate", 100_000);
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, profile);
		const userId = JSON.parse(String(metadata.user_id)) as Record<string, unknown>;

		expect((userId.profile as Record<string, unknown>).t).toBe(83_616);
	});

	it("clamps oversized fixed thresholds to the active context window", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 250_000,
			"compaction.thresholdPercent": -1,
		});
		const profile = buildEffectiveSessionProfile(settings, "estimate", 200_000);
		const metadata = buildSessionMetadata(SESSION_ID, "anthropic", undefined, profile);
		const userId = JSON.parse(String(metadata.user_id)) as Record<string, unknown>;

		expect((userId.profile as Record<string, unknown>).t).toBe(199_999);
	});

	it("bounds long custom session IDs without emitting oversized metadata", () => {
		const settings = Settings.isolated({
			"compaction.thresholdTokens": 120000,
			"compaction.strategy": "scratch-handoff",
		});
		const profile = buildEffectiveSessionProfile(settings, "accurate", 200_000);
		const authStorage = {
			getOAuthAccountId: () => ACCOUNT_UUID,
		} as unknown as AuthStorage;
		const sessionId = "custom-session-".repeat(5);
		const metadata = buildSessionMetadata(sessionId, "anthropic", authStorage, profile);
		const userId = JSON.parse(String(metadata.user_id)) as Record<string, unknown>;

		expect(String(metadata.user_id).length).toBeLessThanOrEqual(256);
		expect(userId).toMatchObject({
			session_id: sessionId,
			account_uuid: ACCOUNT_UUID,
			device_id: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(userId.profile).toBeUndefined();
		const veryLongSessionId = "custom-session-".repeat(30);
		const oversizedMetadata = buildSessionMetadata(veryLongSessionId, "anthropic", authStorage, profile);
		const resumedOversizedMetadata = buildSessionMetadata(veryLongSessionId, "anthropic", authStorage, profile);
		const oversizedUserId = JSON.parse(String(oversizedMetadata.user_id)) as Record<string, unknown>;

		expect(oversizedMetadata).toEqual(resumedOversizedMetadata);
		expect(String(oversizedMetadata.user_id).length).toBeLessThanOrEqual(256);
		expect(String(oversizedUserId.session_id)).toMatch(/^custom-session-/);
		expect(oversizedUserId).toMatchObject({
			account_uuid: ACCOUNT_UUID,
			device_id: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		expect(oversizedUserId.profile).toBeUndefined();
	});
	it("keeps distinct long session IDs distinct after bounding", () => {
		const authStorage = {
			getOAuthAccountId: () => ACCOUNT_UUID,
		} as unknown as AuthStorage;
		const sharedPrefix = "custom-session-".repeat(30);
		const firstSessionId = `${sharedPrefix}first-tail`;
		const secondSessionId = `${sharedPrefix}second-tail`;
		const firstMetadata = buildSessionMetadata(firstSessionId, "anthropic", authStorage);
		const secondMetadata = buildSessionMetadata(secondSessionId, "anthropic", authStorage);
		const resumedFirstMetadata = buildSessionMetadata(firstSessionId, "anthropic", authStorage);
		const firstUserId = JSON.parse(String(firstMetadata.user_id)) as Record<string, unknown>;
		const secondUserId = JSON.parse(String(secondMetadata.user_id)) as Record<string, unknown>;
		const firstSession = String(firstUserId.session_id);
		const secondSession = String(secondUserId.session_id);
		const firstMatch = firstSession.match(/^(.*)-([0-9a-f]{16})$/);
		const secondMatch = secondSession.match(/^(.*)-([0-9a-f]{16})$/);

		expect(firstMetadata).toEqual(resumedFirstMetadata);
		expect(String(firstMetadata.user_id).length).toBeLessThanOrEqual(256);
		expect(String(secondMetadata.user_id).length).toBeLessThanOrEqual(256);
		expect(firstMatch).not.toBeNull();
		expect(secondMatch).not.toBeNull();
		expect(firstMatch?.[1]).toBe(secondMatch?.[1]);
		expect(firstMatch?.[1]).toStartWith("custom-session-");
		expect(firstMatch?.[2]).toBe(Bun.hash(firstSessionId).toString(16).padStart(16, "0"));
		expect(secondMatch?.[2]).toBe(Bun.hash(secondSessionId).toString(16).padStart(16, "0"));
		expect(firstSession).not.toBe(secondSession);
	});

	it("keeps non-Anthropic cache affinity stable across profile changes", () => {
		const firstProfile = buildEffectiveSessionProfile(
			Settings.isolated({
				"compaction.thresholdTokens": 80000,
				"compaction.strategy": "context-full",
			}),
			"estimate",
			200_000,
		);
		const secondProfile = buildEffectiveSessionProfile(
			Settings.isolated({
				"compaction.thresholdTokens": 120000,
				"compaction.strategy": "scratch-handoff",
			}),
			"accurate",
			200_000,
		);
		const firstMetadata = buildSessionMetadata(SESSION_ID, "kimi-code", undefined, firstProfile);
		const secondMetadata = buildSessionMetadata(SESSION_ID, "kimi-code", undefined, secondProfile);

		expect(firstMetadata).toEqual(secondMetadata);
		expect(JSON.parse(String(firstMetadata.user_id))).toEqual({ session_id: SESSION_ID });
	});

	it("forwards a long non-Anthropic session ID whole instead of bounding it", () => {
		// The 256-character cap is Anthropic's limit. Bounding a non-Anthropic
		// request truncates and hash-suffixes the caller's --provider-session-id,
		// which rotates the prompt-affinity key of an already-warmed session.
		const authStorage = {
			getOAuthAccountId: () => ACCOUNT_UUID,
		} as unknown as AuthStorage;
		const longSessionId = "custom-session-".repeat(30);
		expect(longSessionId.length).toBeGreaterThan(256);

		const passthrough = buildSessionMetadata(longSessionId, "kimi-code", authStorage);
		const bounded = buildSessionMetadata(longSessionId, "anthropic", authStorage);

		// Verbatim for the non-Anthropic provider, and no Claude identity leaks.
		expect(JSON.parse(String(passthrough.user_id))).toEqual({ session_id: longSessionId });
		// Anthropic still gets the bounded form, so ordinary behavior is unchanged.
		expect(String(bounded.user_id).length).toBeLessThanOrEqual(256);
		expect(String((JSON.parse(String(bounded.user_id)) as { session_id: string }).session_id)).not.toBe(
			longSessionId,
		);
	});

	it("treats the 256-character cap as inclusive and rewrites only past it", () => {
		// The cap is a maximum, not an exclusive bound: a payload landing exactly on
		// 256 still fits Anthropic's limit and must survive whole. Without a case
		// sitting on the boundary, `serialized.length <= MAX_METADATA_USER_ID_LENGTH`
		// could become `<` and every other test here would still pass while ids that
		// legitimately fit started getting truncated and hash-suffixed.
		const wrapperLength = JSON.stringify({ session_id: "" }).length;
		const atCapSessionId = "b".repeat(256 - wrapperLength);
		const overCapSessionId = "b".repeat(256 - wrapperLength + 1);

		// No authStorage and no profile, so the payload is exactly `{ session_id }`
		// and the arithmetic above is the whole serialized length.
		const atCap = buildSessionMetadata(atCapSessionId, "anthropic", undefined);
		const overCap = buildSessionMetadata(overCapSessionId, "anthropic", undefined);

		// Exactly on the cap: untouched, and pinned with toBe so a narrower bound
		// cannot satisfy it.
		expect(String(atCap.user_id).length).toBe(256);
		expect(JSON.parse(String(atCap.user_id))).toEqual({ session_id: atCapSessionId });

		// One character over: rewritten, and still within the cap afterwards.
		expect(String(overCap.user_id).length).toBeLessThanOrEqual(256);
		expect(String((JSON.parse(String(overCap.user_id)) as { session_id: string }).session_id)).not.toBe(
			overCapSessionId,
		);

		// The boundary is Anthropic's alone — non-Anthropic forwards both whole.
		expect(JSON.parse(String(buildSessionMetadata(atCapSessionId, "kimi-code", undefined).user_id))).toEqual({
			session_id: atCapSessionId,
		});
		expect(JSON.parse(String(buildSessionMetadata(overCapSessionId, "kimi-code", undefined).user_id))).toEqual({
			session_id: overCapSessionId,
		});
	});
});

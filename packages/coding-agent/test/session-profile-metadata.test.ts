import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import type { AuthStorage } from "../src/session/auth-storage";
import {
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
		expect(profileMetadata).toEqual({ t: 120000, s: "context-full", z: "accurate" });
		expect(String(metadata.user_id).length).toBeLessThan(256);
	});

	it("reports disabled compaction as off", () => {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.strategy": "handoff",
		});

		expect(buildEffectiveSessionProfile(settings, "estimate", 200_000).strategy).toBe("off");
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
		const userId = JSON.parse(String(overridden?.user_id)) as { profile: { s: string } };

		expect(userId.profile.s).toBe("context-full");
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
});

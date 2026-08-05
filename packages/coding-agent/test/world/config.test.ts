import { describe, expect, test } from "bun:test";
import {
	isWorldConfigured,
	isWorldRuntimeConfigured,
	resolveWorldInteractive,
	resolveWorldSessionKey,
	resolveWorldSocketPath,
	validateWorldInteractiveConfiguration,
	WORLD_INTERACTIVE_ENV,
	WORLD_SESSION_ENV,
	WORLD_SOCKET_ENV,
} from "@oh-my-pi/pi-coding-agent/world/config";

describe("world socket configuration", () => {
	test("is unconfigured when neither the environment nor the setting names a socket", () => {
		expect(resolveWorldSocketPath({ env: {}, setting: undefined })).toBeUndefined();
		expect(isWorldConfigured({ env: {}, setting: undefined })).toBe(false);
	});

	test("treats blank values as unconfigured", () => {
		expect(resolveWorldSocketPath({ env: { [WORLD_SOCKET_ENV]: "   " }, setting: "  " })).toBeUndefined();
	});

	test("reads the configured setting", () => {
		expect(resolveWorldSocketPath({ env: {}, setting: "/run/glados/console.sock" })).toBe("/run/glados/console.sock");
		expect(isWorldConfigured({ env: {}, setting: "/run/glados/console.sock" })).toBe(true);
	});

	test("lets the environment override the configured setting", () => {
		expect(
			resolveWorldSocketPath({
				env: { [WORLD_SOCKET_ENV]: "/run/env/console.sock" },
				setting: "/run/setting/console.sock",
			}),
		).toBe("/run/env/console.sock");
	});

	test("falls through to the setting when the environment value is blank", () => {
		expect(
			resolveWorldSocketPath({
				env: { [WORLD_SOCKET_ENV]: "" },
				setting: "/run/setting/console.sock",
			}),
		).toBe("/run/setting/console.sock");
	});

	// The client connects only to a local Unix socket. A relative path or a URL
	// is a configuration error, not something to normalize into a guess.
	test("rejects a configured value that is not an absolute path", () => {
		expect(() => resolveWorldSocketPath({ env: {}, setting: "relative/console.sock" })).toThrow(
			/world\.socket must be an absolute Unix socket path/,
		);
		expect(() =>
			resolveWorldSocketPath({ env: { [WORLD_SOCKET_ENV]: "unix:///run/console.sock" }, setting: undefined }),
		).toThrow(/OMP_WORLD_SOCKET must be an absolute Unix socket path/);
	});
});

describe("world caller session configuration", () => {
	test("is unconfigured when neither the environment nor the setting names a caller", () => {
		expect(resolveWorldSessionKey({ env: {}, sessionSetting: undefined })).toBeUndefined();
		expect(resolveWorldSessionKey({ env: { [WORLD_SESSION_ENV]: "   " }, sessionSetting: "  " })).toBeUndefined();
	});

	test("reads the configured setting", () => {
		expect(resolveWorldSessionKey({ env: {}, sessionSetting: "glados/llm-session/a" })).toBe("glados/llm-session/a");
	});

	// The same precedence as the socket, so one shell binds both halves without
	// editing config and neither half can come from a different place.
	test("lets the environment override the configured setting", () => {
		expect(
			resolveWorldSessionKey({
				env: { [WORLD_SESSION_ENV]: "glados/llm-session/env" },
				sessionSetting: "glados/llm-session/setting",
			}),
		).toBe("glados/llm-session/env");
	});

	test("falls through to the setting when the environment value is blank", () => {
		expect(
			resolveWorldSessionKey({
				env: { [WORLD_SESSION_ENV]: "" },
				sessionSetting: "glados/llm-session/setting",
			}),
		).toBe("glados/llm-session/setting");
	});

	// A caller key is a World object key: checking it here means a typo fails at
	// configuration rather than as a daemon rejection after a dial.
	test("rejects a value that is not a canonical World object key", () => {
		expect(() => resolveWorldSessionKey({ env: {}, sessionSetting: "/glados/llm-session/a" })).toThrow(
			/world\.session must not start or end with/,
		);
		expect(() => resolveWorldSessionKey({ env: {}, sessionSetting: "glados//a" })).toThrow(
			/empty object key segment/,
		);
		expect(() => resolveWorldSessionKey({ env: {}, sessionSetting: "glados/../a" })).toThrow(/is reserved/);
		expect(() => resolveWorldSessionKey({ env: {}, sessionSetting: "glados/-" })).toThrow(/is reserved/);
		expect(() =>
			resolveWorldSessionKey({ env: { [WORLD_SESSION_ENV]: "glados/llm session" }, sessionSetting: undefined }),
		).toThrow(new RegExp(`${WORLD_SESSION_ENV} segment`));
	});
});

describe("world runtime configuration", () => {
	// Both halves or nothing. A socket-only root keeps W2 reads, so it must not
	// report itself able to perform authority-checked operations.
	test("needs both a socket and a caller session", () => {
		expect(isWorldRuntimeConfigured({ env: {}, setting: undefined, sessionSetting: undefined })).toBe(false);
		expect(
			isWorldRuntimeConfigured({ env: {}, setting: "/run/glados/console.sock", sessionSetting: undefined }),
		).toBe(false);
		expect(isWorldRuntimeConfigured({ env: {}, setting: undefined, sessionSetting: "glados/llm-session/a" })).toBe(
			false,
		);
		expect(
			isWorldRuntimeConfigured({
				env: {},
				setting: "/run/glados/console.sock",
				sessionSetting: "glados/llm-session/a",
			}),
		).toBe(true);
	});

	test("treats malformed values as unavailable to admission predicates", () => {
		expect(
			isWorldRuntimeConfigured({
				env: {},
				setting: "relative/console.sock",
				sessionSetting: "glados/llm-session/a",
			}),
		).toBe(false);
		expect(
			isWorldRuntimeConfigured({
				env: {},
				setting: "/run/glados/console.sock",
				sessionSetting: "glados//a",
			}),
		).toBe(false);
	});

	test("a socket-only root is still a configured World", () => {
		expect(isWorldConfigured({ env: {}, setting: "/run/glados/console.sock" })).toBe(true);
	});
});

describe("interactive World configuration", () => {
	test("is default-off and environment wins over settings", () => {
		expect(resolveWorldInteractive({ env: {}, interactiveSetting: undefined })).toBe(false);
		expect(resolveWorldInteractive({ env: { [WORLD_INTERACTIVE_ENV]: "true" }, interactiveSetting: false })).toBe(
			true,
		);
		expect(resolveWorldInteractive({ env: { [WORLD_INTERACTIVE_ENV]: "0" }, interactiveSetting: true })).toBe(false);
	});

	test("rejects missing socket and static caller before key validation", () => {
		expect(() =>
			validateWorldInteractiveConfiguration({
				env: { [WORLD_INTERACTIVE_ENV]: "true", [WORLD_SESSION_ENV]: "not a key" },
				setting: undefined,
				sessionSetting: undefined,
			}),
		).toThrow(/requires a World socket/);
		expect(() =>
			validateWorldInteractiveConfiguration({
				env: { [WORLD_INTERACTIVE_ENV]: "true", [WORLD_SOCKET_ENV]: "/run/glados.sock" },
				setting: undefined,
				sessionSetting: "glados/llm-session/root",
			}),
		).toThrow(/cannot be combined/);
	});
});

import { describe, expect, test } from "bun:test";
import { isWorldConfigured, resolveWorldSocketPath, WORLD_SOCKET_ENV } from "../config.js";

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

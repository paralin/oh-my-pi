import { describe, expect, test } from "bun:test";
import { resolveParentSocketPath } from "@oh-my-pi/pi-coding-agent/parent/config";

describe("parent configuration", () => {
	test("selects local mode only when the endpoint is absent", () => {
		expect(resolveParentSocketPath({ env: {} })).toBeUndefined();
		expect(resolveParentSocketPath({ env: { OMP_PARENT_SOCKET: "/tmp/parent.sock" } })).toBe("/tmp/parent.sock");
	});
	test("rejects a relative configured endpoint", () => {
		expect(() => resolveParentSocketPath({ env: { OMP_PARENT_SOCKET: "relative.sock" } })).toThrow(
			"must be an absolute Unix socket path",
		);
	});
	test("captures the process endpoint before later environment mutation", () => {
		const script = `import { resolveParentSocketPath } from ${JSON.stringify(new URL("../../src/parent/config.ts", import.meta.url).pathname)}; process.env.OMP_PARENT_SOCKET = "/tmp/redirect.sock"; console.log(resolveParentSocketPath() ?? "local")`;
		const result = Bun.spawnSync([process.execPath, "-e", script], {
			env: { ...process.env, OMP_PARENT_SOCKET: "/tmp/original.sock" },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("/tmp/original.sock");
	});
});

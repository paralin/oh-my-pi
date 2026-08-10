import { afterEach, describe, expect, it } from "bun:test";
import {
	__resetWindowsConsoleProbeCache,
	consoleAttached,
	hostHasInheritableConsole,
} from "../../src/launch/host-console";

describe("consoleAttached", () => {
	it("treats a ConPTY TTY as attached when GetConsoleWindow returns null", () => {
		expect(
			consoleAttached({
				nativeConsole: false,
				stdinIsTTY: true,
				stdoutIsTTY: true,
				stderrIsTTY: true,
			}),
		).toBe(true);
	});

	it("trusts the native console for fully redirected stdio", () => {
		expect(
			consoleAttached({
				nativeConsole: true,
				stdinIsTTY: false,
				stdoutIsTTY: false,
				stderrIsTTY: false,
			}),
		).toBe(true);
	});

	it("treats `omp -p '...' > out.txt` (stdout-only redirect) as console-attached", () => {
		expect(consoleAttached({ stdinIsTTY: true, stdoutIsTTY: false, stderrIsTTY: true })).toBe(true);
	});

	it("treats stdin-only redirects (`< in.txt`) as console-attached", () => {
		expect(consoleAttached({ stdinIsTTY: false, stdoutIsTTY: true, stderrIsTTY: true })).toBe(true);
	});

	it("treats stderr-only redirects (`2> err.log`) as console-attached", () => {
		expect(consoleAttached({ stdinIsTTY: true, stdoutIsTTY: true, stderrIsTTY: false })).toBe(true);
	});

	it("returns false without native-console or TTY evidence", () => {
		expect(
			consoleAttached({
				nativeConsole: false,
				stdinIsTTY: false,
				stdoutIsTTY: false,
				stderrIsTTY: false,
			}),
		).toBe(false);
	});
});

describe("hostHasInheritableConsole", () => {
	afterEach(() => {
		__resetWindowsConsoleProbeCache();
	});

	if (process.platform !== "win32") {
		it("matches the TTY evidence off-Windows", () => {
			const expected = consoleAttached({
				nativeConsole: null,
				stdinIsTTY: !!process.stdin.isTTY,
				stdoutIsTTY: !!process.stdout.isTTY,
				stderrIsTTY: !!process.stderr.isTTY,
			});
			expect(hostHasInheritableConsole()).toBe(expected);
		});
	}
});

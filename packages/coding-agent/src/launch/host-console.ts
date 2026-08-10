/** Detects whether child processes can inherit the host console. */
import { dlopen, FFIType } from "bun:ffi";

export function consoleAttached(opts: {
	nativeConsole?: boolean | null;
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	stderrIsTTY: boolean;
}): boolean {
	if (opts.nativeConsole === true) return true;
	return opts.stdinIsTTY || opts.stdoutIsTTY || opts.stderrIsTTY;
}

/**
 * Probe `kernel32.dll!GetConsoleWindow()` to detect whether the current
 * Windows process owns a console window.
 *
 * Returns `true` for a non-NULL HWND, `false` when NULL, and `null` when the
 * probe itself fails (off-Windows, FFI disabled, or unexpected kernel32
 * layout). A false result is not conclusive for ConPTY-backed terminals, so
 * callers must also inspect the stdio TTY signals.
 *
 * Cached on first call because in practice the console attachment of a
 * long-lived OMP host never changes for the lifetime of the process, and
 * we don't want to re-dlopen kernel32 on every kernel spawn.
 */
type ConsoleProbeResult = boolean | null;
let cachedWindowsConsoleProbe: { value: ConsoleProbeResult } | undefined;

function probeWindowsConsoleWindow(): ConsoleProbeResult {
	if (cachedWindowsConsoleProbe) return cachedWindowsConsoleProbe.value;
	let value: ConsoleProbeResult = null;
	try {
		const lib = dlopen("kernel32.dll", {
			GetConsoleWindow: { args: [], returns: FFIType.ptr },
		});
		try {
			const hwnd = lib.symbols.GetConsoleWindow();
			// FFIType.ptr returns `Pointer | null`; a 0 pointer should also be
			// treated as NULL defensively in case Bun ever returns 0n / 0.
			value = hwnd !== null && hwnd !== 0;
		} finally {
			lib.close();
		}
	} catch {
		value = null;
	}
	cachedWindowsConsoleProbe = { value };
	return value;
}

/** Reset the cached Win32 probe result. Test-only; not part of the public surface. */
export function __resetWindowsConsoleProbeCache(): void {
	cachedWindowsConsoleProbe = undefined;
}

/**
 * Whether the host process owns a console its children can inherit.
 *
 * On Windows, `GetConsoleWindow()` detects classic consoles and all-stdio-
 * redirected launches while stdio TTYs detect ConPTY-backed terminals. Either
 * signal is sufficient. Other platforms use the same TTY evidence, although
 * `windowsHide` is a no-op there.
 */
export function hostHasInheritableConsole(): boolean {
	const nativeConsole = process.platform === "win32" ? probeWindowsConsoleWindow() : null;
	return consoleAttached({
		nativeConsole,
		stdinIsTTY: !!process.stdin.isTTY,
		stdoutIsTTY: !!process.stdout.isTTY,
		stderrIsTTY: !!process.stderr.isTTY,
	});
}

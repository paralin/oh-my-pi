import path from "node:path";

export const PARENT_SOCKET_ENV = "OMP_PARENT_SOCKET";
export const PARENT_SESSION_ENV = "OMP_PARENT_SESSION";
export const PARENT_EXTENSION_ENV = "OMP_PARENT_EXTENSION";

export interface ParentEnvironmentSources {
	env?: Record<string, string | undefined>;
}

function parseParentSocket(value: string | undefined): string | undefined {
	value = value?.trim();
	if (!value) return undefined;
	if (!path.isAbsolute(value)) throw new Error(`${PARENT_SOCKET_ENV} must be an absolute Unix socket path`);
	return value;
}

// Capture the process endpoint exactly once. Later environment mutation cannot
// redirect a configured process or turn local mode into remote mode.
const processParentSocket = parseParentSocket(process.env[PARENT_SOCKET_ENV]);

/** Resolve the immutable process parent endpoint. Absence selects local mode. */
export function resolveParentSocketPath(options: ParentEnvironmentSources = {}): string | undefined {
	return options.env ? parseParentSocket(options.env[PARENT_SOCKET_ENV]) : processParentSocket;
}

/** Resolve the opaque parent session inherited by a managed child process. */
export function resolveParentSessionId(options: ParentEnvironmentSources = {}): string | undefined {
	const value = (options.env ?? process.env)[PARENT_SESSION_ENV]?.trim();
	return value || undefined;
}

export function isParentEnvironmentConfigured(env?: Record<string, string | undefined>): boolean {
	return resolveParentSocketPath(env ? { env } : undefined) !== undefined;
}

/** Resolve the optional provider extension package supplied by the parent. */
export function resolveParentExtensionPath(env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[PARENT_EXTENSION_ENV]?.trim();
	if (!value) return undefined;
	if (!path.isAbsolute(value)) throw new Error(`${PARENT_EXTENSION_ENV} must be an absolute path`);
	return value;
}

import { settings } from "../config/settings.js";

/** Environment override for the configured World socket path. */
export const WORLD_SOCKET_ENV = "OMP_WORLD_SOCKET";

/** Environment override for the configured caller LlmSession object key. */
export const WORLD_SESSION_ENV = "OMP_WORLD_SESSION";

export interface WorldSocketSources {
	/** Environment map to read {@link WORLD_SOCKET_ENV} from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Configured daemon Console socket path. Defaults to the `world.socket` setting. */
	setting?: string | undefined;
}

export interface WorldSessionSources {
	/** Environment map to read {@link WORLD_SESSION_ENV} from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Configured caller LlmSession object key. Defaults to the `world.session` setting. */
	sessionSetting?: string | undefined;
}

/** Both halves of the World configuration, resolved the same way. */
export interface WorldSources extends WorldSocketSources, WorldSessionSources {}

/**
 * Resolve the configured GLaDOS daemon Console socket path, or `undefined` when
 * the integration is not configured.
 *
 * The value names the daemon Console socket (`GLADOS_CONSOLE_SOCKET`, by
 * default `<state>/glados/console.sock`), which is the only socket whose root
 * resource is the GLaDOS resource surface. The Spacewave socket answers the
 * same handshake but mounts a session and space first, so aiming this there
 * connects and then fails every call.
 *
 * `OMP_WORLD_SOCKET` wins over `world.socket` so one shell can point at a
 * different daemon without editing config. Both are optional: an unset value is
 * the normal case and MUST leave the runtime with no transport and no dial.
 *
 * A configured value has to be an absolute path. The client connects only to a
 * local Unix socket, so a relative path or a URL is a configuration error
 * rather than something to normalize into a guess.
 */
export function resolveWorldSocketPath(sources: WorldSocketSources = {}): string | undefined {
	const env = sources.env ?? process.env;
	const fromEnv = env[WORLD_SOCKET_ENV]?.trim();
	if (fromEnv) return requireAbsoluteSocketPath(fromEnv, WORLD_SOCKET_ENV);

	const fromSetting = (sources.setting !== undefined ? sources.setting : readWorldSocketSetting())?.trim();
	if (fromSetting) return requireAbsoluteSocketPath(fromSetting, "world.socket");

	return undefined;
}

/**
 * Resolve the caller LlmSession object key, or `undefined` when none is
 * configured.
 *
 * This is the identity every authority-checked World operation is charged to:
 * GLaDOS reads this session's frozen capability manifest and answers from it.
 * The local Unix socket remains the trust boundary — the key selects which
 * caller's permissions apply, it does not prove who opened the socket.
 *
 * `OMP_WORLD_SESSION` wins over `world.session`, matching {@link
 * WORLD_SOCKET_ENV}, so one shell can bind to one session without editing
 * configuration.
 *
 * A socket without a session is a complete configuration: that root keeps its
 * read-only `spacewave://` access and is simply not allowed to change anything.
 * A session without a socket names a caller with nowhere to send it, which is a
 * configuration error rather than something to ignore.
 */
export function resolveWorldSessionKey(sources: WorldSessionSources = {}): string | undefined {
	const env = sources.env ?? process.env;
	const fromEnv = env[WORLD_SESSION_ENV]?.trim();
	if (fromEnv) return requireWorldObjectKey(fromEnv, WORLD_SESSION_ENV);

	const fromSetting = (
		sources.sessionSetting !== undefined ? sources.sessionSetting : readWorldSessionSetting()
	)?.trim();
	if (fromSetting) return requireWorldObjectKey(fromSetting, "world.session");

	return undefined;
}

/** Whether a World socket is configured at all. */
export function isWorldConfigured(sources: WorldSocketSources = {}): boolean {
	return resolveWorldSocketPath(sources) !== undefined;
}

/**
 * Whether this root may perform authority-checked World operations.
 *
 * Both halves are required. This is what decides whether the `world` tool is
 * registered, so it must not report true for a root that could only receive a
 * denial it has no caller identity to be denied under.
 */
export function isWorldRuntimeConfigured(sources: WorldSources = {}): boolean {
	try {
		return resolveWorldSocketPath(sources) !== undefined && resolveWorldSessionKey(sources) !== undefined;
	} catch {
		return false;
	}
}

function requireAbsoluteSocketPath(value: string, source: string): string {
	if (!value.startsWith("/")) {
		throw new Error(`${source} must be an absolute Unix socket path: ${value}`);
	}
	return value;
}

/**
 * One object-key segment, mirroring the daemon's `ObjectKeySegmentPattern`.
 *
 * The grammar lives here rather than beside the URI parser because the caller
 * identity is configuration and has to be checked before anything is dialed.
 * One grammar written down twice is a grammar that eventually differs, so the
 * address parser in `client.ts` reads this same constant.
 */
export const WORLD_OBJECT_KEY_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._:-]*$/;

/**
 * Reject a configured value that is not a canonical World object key.
 *
 * A caller key is an LlmSession World object key, so it has to survive a URL
 * path unchanged like every other key. Checking it here means a typo fails at
 * configuration rather than as a daemon rejection after a dial. GLaDOS
 * re-validates the key it receives and remains the authority.
 */
function requireWorldObjectKey(value: string, source: string): string {
	if (value.startsWith("/") || value.endsWith("/")) {
		throw new Error(`${source} must not start or end with "/": ${value}`);
	}
	for (const segment of value.split("/")) {
		if (!segment) throw new Error(`${source} has an empty object key segment: ${value}`);
		if (segment === "-" || segment === "." || segment === "..") {
			throw new Error(`${source} segment "${segment}" is reserved: ${value}`);
		}
		if (!WORLD_OBJECT_KEY_SEGMENT.test(segment)) {
			throw new Error(`${source} segment "${segment}" must match ${WORLD_OBJECT_KEY_SEGMENT.source}: ${value}`);
		}
	}
	return value;
}

function readWorldSocketSetting(): string | undefined {
	// Settings are absent in contexts that never initialized them (early
	// startup, standalone scripts). An unconfigured World is the default, so a
	// missing settings singleton reads as "not configured" rather than throwing.
	try {
		return settings.get("world.socket");
	} catch {
		return undefined;
	}
}

function readWorldSessionSetting(): string | undefined {
	try {
		return settings.get("world.session");
	} catch {
		return undefined;
	}
}

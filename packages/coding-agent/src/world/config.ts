import { settings } from "../config/settings.js";

/** Environment override for the configured World socket path. */
export const WORLD_SOCKET_ENV = "OMP_WORLD_SOCKET";

export interface WorldSocketSources {
	/** Environment map to read {@link WORLD_SOCKET_ENV} from. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** Configured daemon Console socket path. Defaults to the `world.socket` setting. */
	setting?: string | undefined;
}

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

/** Whether a World socket is configured at all. */
export function isWorldConfigured(sources: WorldSocketSources = {}): boolean {
	return resolveWorldSocketPath(sources) !== undefined;
}

function requireAbsoluteSocketPath(value: string, source: string): string {
	if (!value.startsWith("/")) {
		throw new Error(`${source} must be an absolute Unix socket path: ${value}`);
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

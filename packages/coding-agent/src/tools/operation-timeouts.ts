export interface OperationTimeoutConfig {
	/** Default timeout in seconds when the caller omits the field */
	default: number;
	/** Minimum allowed timeout in seconds */
	min: number;
	/** Maximum allowed timeout in seconds (per-operation ceiling) */
	max: number;
}

export const OPERATION_TIMEOUTS = {
	bash: { default: 300, min: 1, max: 3600 },
	browser: { default: 30, min: 1, max: 300 },
	computer: { default: 120, min: 1, max: 300 },
	fetch: { default: 20, min: 1, max: 45 },
} as const satisfies Record<string, OperationTimeoutConfig>;

export type OperationWithTimeout = keyof typeof OPERATION_TIMEOUTS;

/**
 * Clamp a raw timeout to the allowed range for a host operation.
 *
 * When `rawTimeout` is undefined the operation's `default` is used. A positive
 * `maxTimeout` (the `tools.maxTimeout` global ceiling) caps the *resolved*
 * value — including the default-fallback path — before the per-operation `min`/`max`
 * floor and ceiling apply, so a configured global cap governs calls where the
 * caller omits `timeout`, not only explicitly-passed values. `maxTimeout <= 0`
 * means no global cap.
 */
export function clampTimeout(operation: OperationWithTimeout, rawTimeout?: number, maxTimeout?: number): number {
	const config = OPERATION_TIMEOUTS[operation];
	const timeout = rawTimeout ?? config.default;
	const capped = maxTimeout !== undefined && maxTimeout > 0 ? Math.min(timeout, maxTimeout) : timeout;
	return Math.max(config.min, Math.min(config.max, capped));
}

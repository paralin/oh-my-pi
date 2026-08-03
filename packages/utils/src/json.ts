/**
 * Try to parse JSON, returning null on failure.
 */
export function tryParseJson<T = unknown>(content: string): T | null {
	try {
		return JSON.parse(content) as T;
	} catch {
		return null;
	}
}

/**
 * Serialize JSON while preserving bigint precision as decimal strings.
 *
 * Tool arguments normally arrive from JSON providers, but extension hooks and
 * host integrations can supply JavaScript bigint values. Native
 * `JSON.stringify` throws for those values, which makes otherwise valid agent
 * history impossible to persist, replay, or compact. A decimal string is the
 * only lossless JSON representation.
 */
export function stringifyJson(value: unknown, space?: string | number): string | undefined {
	return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), space);
}

/**
 * Only plain objects carry unordered members, so only they may be reordered.
 *
 * Arrays, typed arrays, and other exotic objects encode position in their keys:
 * sorting `Uint8Array` indices lexicographically would reorder the bytes.
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Serialize JSON so that values equal under JSON semantics produce equal text.
 *
 * JSON gives object member order no meaning, so a peer that reconstructs a
 * semantically identical payload may emit its members in another order. Hashing
 * raw `JSON.stringify` output turns that into a spurious digest mismatch. This
 * sorts plain-object keys at every depth while preserving array order, scalar
 * types, and the byte order of binary views, so only a genuine value change
 * moves the digest.
 *
 * `toJSON` hooks still run first, bigints follow {@link stringifyJson}, and a
 * top-level `undefined` canonicalizes to `null` to keep the result total for
 * callers that feed it straight into a hash.
 */
export function canonicalJsonStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") return item.toString();
			if (!isPlainJsonObject(item)) return item;
			const canonical: Record<string, unknown> = {};
			for (const key of Object.keys(item).sort()) canonical[key] = item[key];
			return canonical;
		}) ?? "null"
	);
}

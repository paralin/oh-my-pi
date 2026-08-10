export const DEFAULT_MAX_LINES = 3000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
export const DEFAULT_MAX_COLUMN = 512; // Max chars per grep match line

export interface ByteTruncationResult {
	text: string;
	bytes: number;
}

/** Return a UTF-8-safe prefix without importing renderer or settings modules. */
export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	if (maxBytes === 0) return { text: "", bytes: 0 };
	const buf =
		typeof data === "string"
			? Buffer.from(data.substring(0, Math.min(data.length, maxBytes)), "utf-8")
			: Buffer.isBuffer(data)
				? data
				: Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
	if (end <= 0) return { text: "", bytes: 0 };
	const slice = buf.subarray(0, end);
	return { text: slice.toString("utf-8"), bytes: slice.length };
}

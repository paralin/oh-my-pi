/** Text normalization shared by read and commit validation. */

export type LineEnding = "\r\n" | "\n";

/** Detect the first line-ending style, defaulting to LF. */
export function detectLineEnding(content: string): LineEnding {
	const crlf = content.indexOf("\r\n");
	const lf = content.indexOf("\n");
	return crlf !== -1 && (lf === -1 || crlf < lf) ? "\r\n" : "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface BomResult {
	bom: string;
	text: string;
}

/** Split a leading UTF-8 BOM from text. */
export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

const UNICODE_REPLACEMENTS: [RegExp, string][] = [
	[/[\u2010-\u2015\u2212]/g, "-"],
	[/[\u2018-\u201B]/g, "'"],
	[/[\u201C-\u201F]/g, '"'],
	[/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " "],
	[/\u2260/g, "!="],
	[/\u00BD/g, "1/2"],
	[/[\u200B-\u200D\uFEFF]/g, ""],
];

/** Normalize common pasted punctuation before a textual comparison. */
export function normalizeUnicode(text: string): string {
	let result = text.trim();
	for (const [pattern, replacement] of UNICODE_REPLACEMENTS) {
		result = result.replace(pattern, replacement);
	}
	return result.normalize("NFC");
}

/** Generic unified-diff parser used by commit and ACP renderers. */

export interface DiffHunk {
	changeContext?: string;
	oldStartLine?: number;
	newStartLine?: number;
	hasContextLines: boolean;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export class DiffParseError extends Error {
	constructor(
		message: string,
		readonly lineNumber?: number,
	) {
		super(lineNumber !== undefined ? `Line ${lineNumber}: ${message}` : message);
		this.name = "DiffParseError";
	}
}

const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const UNIFIED_HUNK_HEADER_REGEX = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s*(.*))?$/;
const LINE_HINT_REGEX = /^lines?\s+(\d+)(?:\s*-\s*(\d+))?(?:\s*@@)?$/i;
const TOP_OF_FILE_REGEX = /^(top|start|beginning)\s+of\s+file$/i;
const MULTI_FILE_MARKERS = ["*** Update File:", "*** Add File:", "*** Delete File:", "diff --git "];
const DIFF_METADATA_PREFIXES = [
	"*** Update File:",
	"*** Add File:",
	"*** Delete File:",
	"diff --git ",
	"index ",
	"--- ",
	"+++ ",
	"new file mode ",
	"deleted file mode ",
	"rename from ",
	"rename to ",
	"similarity index ",
	"dissimilarity index ",
	"old mode ",
	"new mode ",
];
const PATCH_WRAPPER_PREFIXES = ["*** Begin Patch", "*** End Patch"];

function isDiffContentLine(line: string): boolean {
	const firstChar = line[0];
	if (firstChar === " ") return true;
	if (firstChar === "+") {
		return !line.startsWith("+++ ");
	}
	if (firstChar === "-") {
		return !line.startsWith("--- ");
	}
	return false;
}

function matchesTrimmedPrefix(line: string, prefixes: string[]): boolean {
	return prefixes.some(prefix => line.startsWith(prefix));
}

function isPatchWrapperLine(line: string): boolean {
	return line === "***" || matchesTrimmedPrefix(line, PATCH_WRAPPER_PREFIXES);
}

export function normalizeDiff(diff: string): string {
	let lines = diff.split("\n");

	while (lines.length > 0) {
		const lastLine = lines[lines.length - 1];
		if (lastLine === "" || (lastLine?.trim() === "" && !isDiffContentLine(lastLine ?? ""))) {
			lines = lines.slice(0, -1);
		} else {
			break;
		}
	}

	if (lines[0] && isPatchWrapperLine(lines[0].trim())) {
		lines = lines.slice(1);
	}
	if (lines.length > 0 && isPatchWrapperLine(lines[lines.length - 1]?.trim() ?? "")) {
		lines = lines.slice(0, -1);
	}

	lines = lines.filter(line => {
		if (isDiffContentLine(line)) {
			return true;
		}

		return !matchesTrimmedPrefix(line.trim(), DIFF_METADATA_PREFIXES);
	});

	return lines.join("\n");
}

interface UnifiedHunkHeader {
	oldStartLine: number;
	oldLineCount: number;
	newStartLine: number;
	newLineCount: number;
	changeContext?: string;
}

function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | undefined {
	const match = line.match(UNIFIED_HUNK_HEADER_REGEX);
	if (!match) return undefined;

	const oldStartLine = Number(match[1]);
	const oldLineCount = match[2] ? Number(match[2]) : 1;
	const newStartLine = Number(match[3]);
	const newLineCount = match[4] ? Number(match[4]) : 1;
	const changeContext = match[5]?.trim();

	return {
		oldStartLine,
		oldLineCount,
		newStartLine,
		newLineCount,
		changeContext: changeContext && changeContext.length > 0 ? changeContext : undefined,
	};
}

function isUnifiedDiffMetadataLine(line: string): boolean {
	return matchesTrimmedPrefix(
		line,
		DIFF_METADATA_PREFIXES.filter(prefix => !prefix.startsWith("*** ")),
	);
}

interface ParseHunkResult {
	hunk: DiffHunk;
	linesConsumed: number;
}

function parseOneHunk(lines: string[], lineNumber: number, allowMissingContext: boolean): ParseHunkResult {
	if (lines.length === 0) {
		throw new DiffParseError("Diff does not contain any lines", lineNumber);
	}

	const changeContexts: string[] = [];
	let oldStartLine: number | undefined;
	let newStartLine: number | undefined;
	let startIndex: number;

	const headerLine = lines[0];
	const headerTrimmed = headerLine.trimEnd();
	const isHeaderLine = headerLine.startsWith("@@");
	const unifiedHeader = isHeaderLine ? parseUnifiedHunkHeader(headerTrimmed) : undefined;
	const isEmptyContextMarker = /^@@\s*@@$/.test(headerTrimmed);

	if (isHeaderLine && (headerTrimmed === EMPTY_CHANGE_CONTEXT_MARKER || isEmptyContextMarker)) {
		startIndex = 1;
	} else if (unifiedHeader) {
		if (unifiedHeader.oldStartLine < 1 || unifiedHeader.newStartLine < 1) {
			throw new DiffParseError("Line numbers in @@ header must be >= 1", lineNumber);
		}
		if (unifiedHeader.changeContext) {
			changeContexts.push(unifiedHeader.changeContext);
		}
		oldStartLine = unifiedHeader.oldStartLine;
		newStartLine = unifiedHeader.newStartLine;
		startIndex = 1;
	} else if (isHeaderLine && headerTrimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
		const contextValue = headerTrimmed.slice(CHANGE_CONTEXT_MARKER.length);
		const trimmedContextValue = contextValue.trim();
		const normalizedContextValue = trimmedContextValue.replace(/^@@\s*/u, "");

		const lineHintMatch = normalizedContextValue.match(LINE_HINT_REGEX);
		if (lineHintMatch) {
			oldStartLine = Number(lineHintMatch[1]);
			newStartLine = oldStartLine;
			if (oldStartLine < 1) {
				throw new DiffParseError("Line hint must be >= 1", lineNumber);
			}
		} else if (TOP_OF_FILE_REGEX.test(normalizedContextValue)) {
			oldStartLine = 1;
			newStartLine = 1;
		} else if (trimmedContextValue.length > 0) {
			changeContexts.push(contextValue);
		}
		startIndex = 1;
	} else if (isHeaderLine) {
		const contextValue = headerTrimmed.slice(2).trim();
		if (contextValue.length > 0) {
			changeContexts.push(contextValue);
		}
		startIndex = 1;
	} else {
		if (!allowMissingContext) {
			throw new DiffParseError(`Expected hunk to start with @@ context marker, got: '${lines[0]}'`, lineNumber);
		}
		startIndex = 0;
	}

	if (oldStartLine !== undefined && oldStartLine < 1) {
		throw new DiffParseError(`Line numbers must be >= 1 (got ${oldStartLine})`, lineNumber);
	}
	if (newStartLine !== undefined && newStartLine < 1) {
		throw new DiffParseError(`Line numbers must be >= 1 (got ${newStartLine})`, lineNumber);
	}

	while (startIndex < lines.length) {
		const nextLine = lines[startIndex];
		if (!nextLine.startsWith("@@")) {
			break;
		}
		const trimmed = nextLine.trimEnd();
		if (trimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
			const nestedContext = trimmed.slice(CHANGE_CONTEXT_MARKER.length);
			if (nestedContext.trim().length > 0) {
				changeContexts.push(nestedContext);
			}
			startIndex++;
		} else if (trimmed === EMPTY_CHANGE_CONTEXT_MARKER) {
			startIndex++;
		} else {
			break;
		}
	}

	if (startIndex >= lines.length) {
		throw new DiffParseError("Hunk does not contain any lines", lineNumber + 1);
	}

	const changeContext = changeContexts.length > 0 ? changeContexts.join("\n") : undefined;

	const hunk: DiffHunk = {
		changeContext,
		oldStartLine,
		newStartLine,
		hasContextLines: false,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
	};

	let parsedLines = 0;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const nextLine = lines[i + 1];

		if (line === "" && parsedLines > 0 && nextLine?.trimStart().startsWith("@@")) {
			break;
		}

		if (!isDiffContentLine(line) && line.trimEnd() === EOF_MARKER && line.startsWith(EOF_MARKER)) {
			if (parsedLines === 0) {
				throw new DiffParseError("Hunk does not contain any lines", lineNumber + 1);
			}
			hunk.isEndOfFile = true;
			parsedLines++;
			break;
		}

		if (trimmed === "..." || trimmed === "…") {
			hunk.hasContextLines = true;
			parsedLines++;
			continue;
		}

		const firstChar = line[0];

		if (firstChar === undefined || firstChar === "") {
			hunk.hasContextLines = true;
			hunk.oldLines.push("");
			hunk.newLines.push("");
		} else if (firstChar === " ") {
			hunk.hasContextLines = true;
			hunk.oldLines.push(line.slice(1));
			hunk.newLines.push(line.slice(1));
		} else if (firstChar === "+") {
			hunk.newLines.push(line.slice(1));
		} else if (firstChar === "-") {
			hunk.oldLines.push(line.slice(1));
		} else if (!line.startsWith("@@")) {
			hunk.hasContextLines = true;
			hunk.oldLines.push(line);
			hunk.newLines.push(line);
		} else {
			if (parsedLines === 0) {
				throw new DiffParseError(
					`Unexpected line in hunk: '${line}'. Lines must start with ' ' (context), '+' (add), or '-' (remove)`,
					lineNumber + 1,
				);
			}
			break;
		}
		parsedLines++;
	}

	if (parsedLines === 0) {
		throw new DiffParseError("Hunk does not contain any lines", lineNumber + startIndex);
	}

	stripLineNumberPrefixes(hunk);
	return { hunk, linesConsumed: parsedLines + startIndex };
}

function stripLineNumberPrefixes(hunk: DiffHunk): void {
	const allLines = [...hunk.oldLines, ...hunk.newLines].filter(line => line.trim().length > 0);
	if (allLines.length < 2) return;

	const numberMatches = allLines
		.map(line => line.match(/^\s*(\d{1,6})\s+(.+)$/u))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (numberMatches.length < Math.max(2, Math.ceil(allLines.length * 0.6))) {
		return;
	}

	const numbers = numberMatches.map(match => Number(match[1]));
	let sequential = 0;
	for (let i = 1; i < numbers.length; i++) {
		if (numbers[i] === numbers[i - 1] + 1) {
			sequential++;
		}
	}

	if (numbers.length >= 3 && sequential < Math.max(1, numbers.length - 2)) {
		return;
	}

	const strip = (line: string): string => {
		const match = line.match(/^\s*\d{1,6}\s+(.+)$/u);
		return match ? match[1] : line;
	};

	hunk.oldLines = hunk.oldLines.map(strip);
	hunk.newLines = hunk.newLines.map(strip);
}

function countMultiFileMarkers(diff: string): number {
	const counts = new Map<string, number>();
	const paths = new Set<string>();
	const lines = diff.split("\n");
	for (const line of lines) {
		if (isDiffContentLine(line)) {
			continue;
		}
		const trimmed = line.trim();
		for (const marker of MULTI_FILE_MARKERS) {
			if (trimmed.startsWith(marker)) {
				const filePath = extractMarkerPath(trimmed);
				if (filePath) {
					paths.add(filePath);
				}
				counts.set(marker, (counts.get(marker) ?? 0) + 1);
				break;
			}
		}
	}
	if (paths.size > 0) {
		return paths.size;
	}
	let maxCount = 0;
	for (const count of counts.values()) {
		if (count > maxCount) {
			maxCount = count;
		}
	}
	return maxCount;
}

function extractMarkerPath(line: string): string | undefined {
	if (line.startsWith("diff --git ")) {
		const parts = line.split(/\s+/);
		const candidate = parts[3] ?? parts[2];
		if (!candidate) return undefined;
		return candidate.replace(/^(a|b)\//, "");
	}
	if (line.startsWith("*** Update File:")) {
		return line.slice("*** Update File:".length).trim();
	}
	if (line.startsWith("*** Add File:")) {
		return line.slice("*** Add File:".length).trim();
	}
	if (line.startsWith("*** Delete File:")) {
		return line.slice("*** Delete File:".length).trim();
	}
	return undefined;
}

export function parseDiffHunks(diff: string): DiffHunk[] {
	const multiFileCount = countMultiFileMarkers(diff);
	if (multiFileCount > 1) {
		throw new DiffParseError(
			`Diff contains ${multiFileCount} file markers. Single-file patches cannot contain multi-file markers.`,
		);
	}

	const normalizedDiff = normalizeDiff(diff);
	const lines = normalizedDiff.split("\n");
	const hunks: DiffHunk[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "") {
			i++;
			continue;
		}

		const firstChar = line[0];
		const isDiffContent = firstChar === " " || firstChar === "+" || firstChar === "-";
		if (!isDiffContent && isUnifiedDiffMetadataLine(trimmed)) {
			i++;
			continue;
		}

		if (trimmed.startsWith("@@") && lines.slice(i + 1).every(next => next.trim() === "")) {
			break;
		}

		const { hunk, linesConsumed } = parseOneHunk(lines.slice(i), i + 1, true);
		hunks.push(hunk);
		i += linesConsumed;
	}

	return hunks;
}

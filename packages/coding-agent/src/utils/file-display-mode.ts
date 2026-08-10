/** Resolve numbered versus raw workspace read output. */

export interface FileDisplayMode {
	lineNumbers: boolean;
}

/** Session-like object providing the read display preference. */
export interface FileDisplayModeSession {
	settings: {
		get(key: "readLineNumbers"): unknown;
	};
}

/** Raw reads are verbatim; other reads follow the line-number preference. */
export function resolveFileDisplayMode(session: FileDisplayModeSession, options?: { raw?: boolean }): FileDisplayMode {
	return { lineNumbers: options?.raw !== true && session.settings.get("readLineNumbers") === true };
}

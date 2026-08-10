/**
 * Return the first 12 hex characters of a commit SHA, or undefined when the
 * input is missing. Shared between GitHub operation argument normalization and the
 * run-watch renderer.
 */
export function formatShortSha(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.slice(0, 12);
}

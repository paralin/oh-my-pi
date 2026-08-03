/**
 * Audience marker for the `omp://` documentation corpus.
 *
 * A page declares who it is written for with an HTML comment on its first line:
 *
 *     <!-- omp-audience: maintainer -->
 *
 * Markdown renderers drop HTML comments, so the marker is invisible on GitHub,
 * in the docs site, and in the page an agent reads. A page that carries no
 * marker is written for an agent using OMP and is listed by default. The marker
 * travels with the page, so adding, renaming, or moving one changes its
 * visibility without touching any code.
 */

/** Who a documentation page is written for. */
export type DocAudience = "agent" | "maintainer";

const AUDIENCE_MARKER = /^[ \t]*<!--[ \t]*omp-audience:[ \t]*([^\r\n]*?)[ \t]*-->/;
const AUDIENCE_DECLARATION = /^[ \t]*<!--[ \t]*omp-audience:/;

/** Read the audience a page declares on its first line, defaulting to `agent`. */
export function readDocAudience(body: string): DocAudience {
	const match = AUDIENCE_MARKER.exec(body);
	if (!match) {
		if (AUDIENCE_DECLARATION.test(body)) throw new Error("Malformed omp-audience declaration");
		return "agent";
	}
	const value = match[1]?.trim() ?? "";
	if (value === "agent" || value === "maintainer") return value;
	throw new Error(`Unknown omp-audience value: ${value || "(empty)"}`);
}

/** Remove a valid first-line audience marker before serving a page over `omp://`. */
export function stripDocAudienceMarker(body: string): string {
	readDocAudience(body);
	const match = AUDIENCE_MARKER.exec(body);
	if (!match) return body;
	return body.slice(match[0].length);
}

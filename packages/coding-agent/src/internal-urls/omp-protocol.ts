/**
 * Protocol handler for omp:// URLs.
 *
 * Serves statically embedded documentation files bundled at build time.
 *
 * URL forms:
 * - omp:// - Lists all available documentation files
 * - omp://<file>.md - Reads a specific documentation file
 */
import * as path from "node:path";
import { isSettingsInitialized, settings } from "../config/settings";
import { getDefault } from "../config/settings-schema";
import { booleanSettingFromContext } from "./context-settings";
import { stripDocAudienceMarker } from "./doc-audience";
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

/** Whether the calling session's listing leaves out pages marked `omp-audience: maintainer`. */
function hideMaintainerDocs(context?: ResolveContext): boolean {
	const fromContext = booleanSettingFromContext(context, "docs.hideMaintainer");
	if (fromContext !== undefined) return fromContext;
	if (!isSettingsInitialized()) return getDefault("docs.hideMaintainer");
	try {
		return settings.get("docs.hideMaintainer");
	} catch {
		return getDefault("docs.hideMaintainer");
	}
}

/**
 * Handler for omp:// URLs.
 *
 * Resolves documentation file names to their content, or lists available docs.
 */
export class OmpProtocolHandler implements ProtocolHandler {
	readonly scheme = "omp";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// Extract filename from host + path
		const host = url.rawHost || url.hostname;
		const pathname = url.rawPathname ?? url.pathname;
		const filename = host ? (pathname && pathname !== "/" ? host + pathname : host) : "";

		if (!filename) {
			return this.#listDocs(url, context);
		}

		return this.#readDoc(filename, url, context);
	}

	async complete(_query?: string, context?: ResolveContext): Promise<UrlCompletion[]> {
		return this.#listedFilenames(context).map(value => ({ value }));
	}

	/**
	 * The corpus a listing or completion offers. Reading is never restricted to
	 * this set: a maintainer page stays reachable by its exact path.
	 */
	#listedFilenames(context: ResolveContext | undefined): readonly string[] {
		return getDocFilenames({ includeMaintainer: !hideMaintainerDocs(context) });
	}

	async #listDocs(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const filenames = this.#listedFilenames(context);
		if (filenames.length === 0) {
			throw new Error("No documentation files found");
		}

		const listing = filenames.map(f => `- [${f}](omp://${f})`).join("\n");
		const content = `# Documentation\n\n${filenames.length} files available:\n\n${listing}\n`;

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	async #readDoc(filename: string, url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		// Validate: no traversal, no absolute paths
		if (path.isAbsolute(filename)) {
			throw new Error("Absolute paths are not allowed in omp:// URLs");
		}

		const normalized = path.posix.normalize(filename.replaceAll("\\", "/"));
		if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
			throw new Error("Path traversal (..) is not allowed in omp:// URLs");
		}

		const docPath =
			normalized === "docs" ? "" : normalized.startsWith("docs/") ? normalized.slice("docs/".length) : normalized;
		if (!docPath) {
			return this.#listDocs(url, context);
		}

		const embedded = await getEmbeddedDoc(docPath);
		if (embedded === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = this.#listedFilenames(context)
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse omp:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}
		const content = stripDocAudienceMarker(embedded);

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}
}

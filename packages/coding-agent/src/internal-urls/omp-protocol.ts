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
import { getDocFilenames, getEmbeddedDoc } from "./docs-index";
import { isMaintainerDocPath } from "./omp-doc-visibility";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

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
		return this.#docFilenames(context).map(value => ({ value }));
	}

	async #listDocs(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const filenames = this.#docFilenames(context);
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

		const filenames = this.#docFilenames(context);
		const content = filenames.includes(docPath) ? await getEmbeddedDoc(docPath) : undefined;
		if (content === undefined) {
			const lookup = docPath.replace(/\.md$/, "");
			const suggestions = filenames
				.filter(f => f.includes(lookup) || lookup.includes(f.replace(/\.md$/, "")))
				.slice(0, 5);
			const suffix =
				suggestions.length > 0
					? `\nDid you mean: ${suggestions.join(", ")}`
					: "\nUse omp:// to list available files.";
			throw new Error(`Documentation file not found: ${filename}${suffix}`);
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
		};
	}

	#docFilenames(context: ResolveContext | undefined): readonly string[] {
		const settings = context?.settings;
		if (settings !== null && typeof settings === "object") {
			const get = Reflect.get(settings, "get");
			if (typeof get === "function" && Reflect.apply(get, settings, ["docs.hideInternal"]) === false) {
				return getDocFilenames();
			}
		}
		return getDocFilenames().filter(filename => !isMaintainerDocPath(filename));
	}
}

import * as path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Glob } from "bun";
import { readDocAudience } from "../src/internal-urls/doc-audience";

const packageDir = path.resolve(import.meta.dir, "..");
const docsDir = path.resolve(packageDir, "../../docs");

export interface DocsIndexPayload {
	readonly files: readonly string[];
	readonly maintainer: readonly string[];
	readonly bodies: readonly string[];
	readonly payload: string;
}

export interface DecodedDocsIndexPayload {
	readonly files: readonly string[];
	readonly maintainer: readonly string[];
	readonly bodies: readonly string[];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

/**
 * Build the exact two-line `omp://` docs embed from the source `docs` Markdown
 * corpus. Each page's audience marker is read here so a listing at runtime can
 * split the corpus from the header alone, without inflating the body blob.
 */
export async function buildDocsIndexPayload(): Promise<DocsIndexPayload> {
	const glob = new Glob("**/*.md");
	const files: string[] = [];
	for await (const relativePath of glob.scan(docsDir)) {
		files.push(relativePath.split(path.sep).join("/"));
	}
	files.sort();

	const bodies = await Promise.all(files.map(file => Bun.file(path.join(docsDir, file)).text()));
	const maintainer = files.filter((_file, i) => readDocAudience(bodies[i]) === "maintainer");
	const bodiesB64 = Buffer.from(gzipSync(Buffer.from(JSON.stringify(bodies)), { level: 9 })).toString("base64");
	return {
		files,
		maintainer,
		bodies,
		payload: `${JSON.stringify({ files, maintainer })}\n${bodiesB64}`,
	};
}

/** Decode a populated docs embed payload into its header and `files`-aligned Markdown bodies. */
export function decodeDocsIndexPayload(embed: string): DecodedDocsIndexPayload | null {
	const newline = embed.indexOf("\n");
	if (newline === -1) return null;

	const header: unknown = JSON.parse(embed.slice(0, newline));
	if (typeof header !== "object" || header === null) {
		throw new Error("Embedded docs index header line is not a JSON object.");
	}
	const { files, maintainer } = header as { files?: unknown; maintainer?: unknown };
	if (!isStringArray(files)) {
		throw new Error("Embedded docs index header has no `files` string array.");
	}
	if (!isStringArray(maintainer)) {
		throw new Error("Embedded docs index header has no `maintainer` string array.");
	}

	const inflated = gunzipSync(Buffer.from(embed.slice(newline + 1), "base64"));
	const bodies: unknown = JSON.parse(inflated.toString("utf8"));
	if (!isStringArray(bodies)) {
		throw new Error("Embedded docs index body blob is not a JSON string array.");
	}

	return { files, maintainer, bodies };
}

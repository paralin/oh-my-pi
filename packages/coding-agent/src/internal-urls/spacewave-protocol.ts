/**
 * Protocol handler for `spacewave://` URLs.
 *
 * Read-only by construction: there is no `write` hook, so the write tool
 * reports the scheme as not writable rather than reaching a World.
 *
 * The URL is an address into one mounted World, not a path into a filesystem.
 * The local form has an empty authority — three slashes — because the whole
 * address lives in the path:
 *
 *   spacewave:///u/{session_idx}/so/{space_id}/-/{objectKey}
 *   spacewave:///u/{session_idx}/so/{space_id}/-/{prefix}/-     (key listing)
 *
 * A nonempty authority is refused rather than absorbed. `spacewave://u/1/...`
 * parses `u` as a host, which is a different address that happens to look
 * right; accepting it would make two spellings mean one thing and let a host
 * position silently swallow a path segment.
 *
 * `rawPathname` is used rather than `pathname` because the parsed URL has
 * already normalized traversal and percent escapes away, and the whole point of
 * this address is that nothing rewrites it: object keys are restricted to a
 * grammar that survives a URL path unchanged, so the bytes the caller wrote are
 * the bytes the daemon validates.
 */
import type { ProjectionRow, WorldClient, WorldRead } from "../world/index.js";
import { assertCanonicalWorldPath, MAX_WORLD_READ_PAGE } from "../world/index.js";
import { parseInternalUrl } from "./parse";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

/** The `spacewave://` scheme, registered once. */
export const SPACEWAVE_SCHEME = "spacewave";

/**
 * Recover the World address from a parsed `spacewave://` URL.
 *
 * The address is the raw path verbatim. With an empty authority there is no
 * host to fold back in, which is why the empty authority is the canonical form:
 * the path the caller wrote is the path the daemon receives.
 */
export function worldAddressFromUrl(url: InternalUrl): string {
	const raw = url.rawHref ?? url.href;
	if (raw.includes("#")) throw new Error(`spacewave:// url must not carry a fragment marker: ${raw}`);
	if (raw.includes("?")) throw new Error(`spacewave:// url must not carry a query marker: ${raw}`);
	const authority = url.rawHost || url.hostname;
	if (authority) {
		throw new Error(
			`spacewave:// urls have an empty authority; write spacewave:///${authority}${url.rawPathname ?? ""} ` +
				`instead of ${url.rawHref ?? url.href}`,
		);
	}
	const address = url.rawPathname ?? url.pathname ?? "";
	if (!address) throw new Error(`spacewave:// url is missing its address: ${url.rawHref ?? url.href}`);
	return address;
}

/** Parse one canonical `spacewave://` URL without decoding its address. */
export function worldAddressFromInput(input: string): string {
	const url = parseInternalUrl(input);
	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	if (scheme !== SPACEWAVE_SCHEME) {
		throw new Error(`world_read requires a ${SPACEWAVE_SCHEME}:// URL: ${input}`);
	}
	return worldAddressFromUrl(url);
}

/**
 * Render one resolved World read as stable reader output.
 *
 * Shared by the native handler and the Claude `world_read` tool so both produce
 * the same text for the same address. Divergence between them would be a second
 * rendering of the same data, which is the thing the shared renderer prevents.
 */
export function renderWorldRead(uri: string, read: WorldRead): { content: string; contentType: "text/markdown" } {
	const lines: string[] = [`# ${uri}`, ""];
	if (!read.found) {
		lines.push(`No object at \`${read.objectKey}\`.`);
		return { content: `${lines.join("\n")}\n`, contentType: "text/markdown" };
	}
	lines.push(`Object key: \`${read.objectKey}\``, "");
	switch (read.kind) {
		case "snapshot": {
			lines.push(`Type: \`${read.snapshot.objectTypeId ?? ""}\``, "");
			for (const row of read.snapshot.rows ?? []) lines.push(renderProjectionRow(row));
			break;
		}
		case "agentTree": {
			const agents = read.agentTree.agents ?? [];
			lines.push(`Agent tree: ${agents.length} agent${agents.length === 1 ? "" : "s"}`, "");
			// Serialized whole rather than flattened into rows: the tree's value
			// is its Agent/Goal/custody structure, which rows would discard.
			lines.push("```json", JSON.stringify(read.agentTree, jsonSafe, 2), "```");
			break;
		}
		case "listing": {
			const keys = read.keys;
			lines.push(`${keys.length} key${keys.length === 1 ? "" : "s"}${read.truncated ? " (truncated)" : ""}`, "");
			for (const key of keys) lines.push(`- \`${key}\``);
			if (read.truncated) {
				lines.push("", "More keys exist than the requested limit; raise the limit to see them.");
			}
			break;
		}
	}
	return { content: `${lines.join("\n")}\n`, contentType: "text/markdown" };
}

/** Revisions and seqnos arrive as bigints, which JSON.stringify refuses. */
function jsonSafe(_key: string, value: unknown): unknown {
	return typeof value === "bigint" ? value.toString() : value;
}

/** One projection row as a single reader line. */
function renderProjectionRow(row: ProjectionRow): string {
	const parts = [row.objectTypeId, row.state, row.title, row.summary].filter(part => (part ?? "") !== "");
	return `- ${parts.join(" · ")}`;
}

/**
 * Read one `spacewave://` address through a client its owner already bound.
 *
 * The client is required, not resolved here. Configuration is selected once by
 * whoever owns the runtime — the router at registration, the task bridge when
 * its tools are built — so every read in that runtime goes to the backend the
 * root chose. Resolving configuration per call would let a mid-run change to
 * `OMP_WORLD_SOCKET` silently move some reads to a different daemon.
 *
 * Validation runs before the client is touched, so a malformed address performs
 * no dial.
 */
export async function readWorldAddress(
	uri: string,
	client: WorldClient,
	options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WorldRead> {
	assertCanonicalWorldPath(uri);
	return await client.readWorldURI(uri, {
		limit: options.limit ?? MAX_WORLD_READ_PAGE,
		signal: options.signal,
	});
}

/**
 * Handler for read-only `spacewave://` World addresses.
 *
 * It holds the client the router bound at registration. The handler is only
 * registered where one could be created, so there is no unconfigured case to
 * represent here.
 */
export class SpacewaveProtocolHandler implements ProtocolHandler {
	readonly scheme = SPACEWAVE_SCHEME;
	readonly immutable = true;

	readonly #client: WorldClient;

	constructor(client: WorldClient) {
		this.#client = client;
	}

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const uri = worldAddressFromUrl(url);
		const read = await readWorldAddress(uri, this.#client);
		const rendered = renderWorldRead(uri, read);
		return {
			url: url.rawHref ?? url.href,
			content: rendered.content,
			contentType: rendered.contentType,
			size: Buffer.byteLength(rendered.content, "utf-8"),
		};
	}
}

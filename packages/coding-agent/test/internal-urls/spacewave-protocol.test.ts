/**
 * `spacewave://` address behavior.
 *
 * The canonical syntax matrix is loaded from `world-uri-vectors.json`, a file
 * byte-identical to the GLaDOS copy under
 * `core/resource/llmsession/testdata/`. Both suites pin its digest, so the two
 * runtimes cannot drift: a URI one accepts and the other rejects is a key that
 * mints in one place and cannot be addressed from the second.
 *
 * The file carries syntax only. Identity — whether an address names the World
 * a daemon mounted — is the daemon's, and lives in the Go tests. Client-only
 * behavior lives here.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import {
	readWorldAddress,
	renderWorldRead,
	SpacewaveProtocolHandler,
	worldAddressFromUrl,
} from "../../src/internal-urls/spacewave-protocol";
import type { ProtocolHandler } from "../../src/internal-urls/types";
import type { WorldRead } from "../../src/world/index.js";
import {
	assertCanonicalWorldPath,
	formatWorldURI,
	formatWorldURL,
	WORLD_LISTING_SELECTOR,
	WorldClient,
} from "../../src/world/index.js";
import vectors from "./world-uri-vectors.json" with { type: "json" };

/**
 * The GLaDOS suite pins this same digest against its own copy of the file.
 * Prose cannot keep two files in two repositories identical; this can, and a
 * drifted copy fails on the side that drifted rather than silently testing
 * something else.
 */
const VECTORS_DIGEST = "622387fdd1833c3648ec6152295dae9381f4852a5ed8010a52c84302f3dc1d19";
const VECTORS_PATH = new URL("./world-uri-vectors.json", import.meta.url);

const SPACE = "test-space";
const KEY = "glados/live/omp/abc/llm-session";
const URI = `/u/1/so/${SPACE}/-/${KEY}`;
const URL_FORM = `spacewave://${URI}`;

/** A client that records every read and never opens anything. */
function fakeClient(read?: WorldRead): { client: WorldClient; reads: string[]; closes: number } {
	const reads: string[] = [];
	const state = { closes: 0 };
	const client = {
		readWorldURI: async (uri: string) => {
			reads.push(uri);
			return read ?? { found: false as const, objectKey: KEY };
		},
		close: async () => {
			state.closes++;
		},
	};
	return {
		client: client as unknown as WorldClient,
		reads,
		get closes() {
			return state.closes;
		},
	};
}

interface WorldUriVector {
	name: string;
	uri: string;
	reason?: string;
}

interface WorldUriVectorFile {
	space: string;
	objectKey: string;
	accepted: WorldUriVector[];
	rejected: WorldUriVector[];
}

const golden = vectors as WorldUriVectorFile;

describe("shared canonical uri vectors", () => {
	test("reads the same vector file GLaDOS pins", () => {
		const digest = createHash("sha256").update(readFileSync(VECTORS_PATH)).digest("hex");
		expect(digest).toBe(VECTORS_DIGEST);
	});

	// The constants above are the file's, so an edit to the matrix moves both
	// runtimes rather than leaving one testing a Space nothing addresses.
	test("agrees with the constants these tests are built from", () => {
		expect(golden.space).toBe(SPACE);
		expect(golden.objectKey).toBe(KEY);
	});

	for (const vector of golden.accepted) {
		test(`accepts ${vector.name}`, () => {
			expect(() => assertCanonicalWorldPath(vector.uri)).not.toThrow();
		});
	}
	for (const vector of golden.rejected) {
		test(`rejects ${vector.name}`, () => {
			// The reason travels with the vector, so a failure says what the
			// address would have meant rather than only that it was allowed.
			expect(() => assertCanonicalWorldPath(vector.uri), vector.reason).toThrow();
		});
	}

	// Identity is the daemon's to enforce, not the client's: a foreign session
	// or Space is well-formed here and refused there. Pinning that split keeps
	// the client from inventing a second authority over which World is which.
	test("a well-formed foreign address is the daemon's to refuse", () => {
		expect(() => assertCanonicalWorldPath(`/u/9/so/elsewhere/-/${KEY}`)).not.toThrow();
	});

	// The Space id is opaque here: only its shape is checked, because the value
	// is whatever the mount resolved and the daemon's exact comparison owns it.
	test("an opaque Space id is accepted on shape alone", () => {
		expect(() =>
			assertCanonicalWorldPath(`/u/1/so/QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx/-/${KEY}`),
		).not.toThrow();
	});
});

describe("canonical url form", () => {
	// Three slashes. The whole address is the path, so the authority is empty.
	test("the formatter emits an empty authority", () => {
		expect(formatWorldURL({ sessionIdx: 1, spaceId: SPACE, objectKey: KEY })).toBe(URL_FORM);
		expect(URL_FORM.startsWith("spacewave:///")).toBe(true);
	});

	test("format then parse recovers the same address directly", () => {
		const url = formatWorldURL({ sessionIdx: 1, spaceId: SPACE, objectKey: KEY });
		expect(worldAddressFromUrl(parseInternalUrl(url))).toBe(URI);
	});

	test("the listing selector survives format and parse", () => {
		const url = formatWorldURL({ sessionIdx: 1, spaceId: SPACE, objectKey: "glados/live", listing: true });
		expect(url).toBe(`spacewave:///u/1/so/${SPACE}/-/glados/live${WORLD_LISTING_SELECTOR}`);
		expect(worldAddressFromUrl(parseInternalUrl(url))).toBe(
			`/u/1/so/${SPACE}/-/glados/live${WORLD_LISTING_SELECTOR}`,
		);
	});

	test("the path formatter refuses to emit an unaddressable key", () => {
		expect(() => formatWorldURI({ sessionIdx: 1, spaceId: SPACE, objectKey: "glados/a@b" })).toThrow();
		expect(() => formatWorldURI({ sessionIdx: 1, spaceId: "", objectKey: KEY })).toThrow();
		// Session 0 is not a session any mount produces.
		expect(() => formatWorldURI({ sessionIdx: 0, spaceId: SPACE, objectKey: KEY })).toThrow(/positive uint32/);
	});

	// The largest index that still fits is well-formed on both sides; whether it
	// names this World is the daemon's exact comparison to make.
	test("the maximum uint32 index is well-formed", () => {
		expect(() => assertCanonicalWorldPath(`/u/4294967295/so/${SPACE}/-/${KEY}`)).not.toThrow();
	});

	// `spacewave://u/1/...` parses `u` as a host, which is a different address
	// that happens to look right.
	test("a nonempty authority is refused, not absorbed", () => {
		const parsed = parseInternalUrl(`spacewave://u/1/so/${SPACE}/-/${KEY}`);
		expect(parsed.rawHost).toBe("u");
		expect(() => worldAddressFromUrl(parsed)).toThrow(/empty authority/);
	});

	test("query and fragment markers are refused before the raw path is extracted", () => {
		expect(() => worldAddressFromUrl(parseInternalUrl(`${URL_FORM}?limit=1`))).toThrow(/query marker/);
		expect(() => worldAddressFromUrl(parseInternalUrl(`${URL_FORM}#attempt`))).toThrow(/fragment marker/);
	});
});

describe("spacewave reads", () => {
	test("a malformed address never reaches the client", async () => {
		const { client, reads } = fakeClient();
		await expect(readWorldAddress(`${URI}#1`, client)).rejects.toThrow(/fragment marker/);
		await expect(readWorldAddress(`/u/1/so/${SPACE}/-/glados/a@b`, client)).rejects.toThrow(/must match/);
		expect(reads).toEqual([]);
	});

	test("the handler sends the address unchanged and renders the arm", async () => {
		const { client, reads } = fakeClient({
			found: true,
			objectKey: KEY,
			kind: "snapshot",
			snapshot: { objectKey: KEY, objectTypeId: "LlmSession", rows: [{ title: "one", state: "LIVE" }] },
		} as WorldRead);
		const handler = new SpacewaveProtocolHandler(client);
		const resource = await handler.resolve(parseInternalUrl(URL_FORM));
		expect(reads).toEqual([URI]);
		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain(KEY);
		expect(resource.content).toContain("LIVE");
	});

	// One client per configured owner: the root selects the backend once, so two
	// reads cannot end up on two daemons because configuration moved mid-run.
	test("the handler reuses one bound client across reads", async () => {
		const bound = fakeClient();
		const handler = new SpacewaveProtocolHandler(bound.client);
		await handler.resolve(parseInternalUrl(URL_FORM));
		await handler.resolve(parseInternalUrl(formatWorldURL({ sessionIdx: 1, spaceId: SPACE, objectKey: "glados" })));
		expect(bound.reads).toEqual([URI, `/u/1/so/${SPACE}/-/glados`]);
		// The handler does not own the client's lifetime; its owner closes it.
		expect(bound.closes).toBe(0);
	});

	test("the router closes its bound World client once", async () => {
		const bound = fakeClient();
		const create = spyOn(WorldClient, "create").mockReturnValue(bound.client);
		InternalUrlRouter.resetForTests();
		try {
			InternalUrlRouter.instance();
			await InternalUrlRouter.closeWorldClient();
			await InternalUrlRouter.closeWorldClient();
			expect(bound.closes).toBe(1);
		} finally {
			InternalUrlRouter.resetForTests();
			create.mockRestore();
		}
	});

	// No write hook at all, so the router reports the scheme as not writable
	// rather than dispatching a mutation at a World.
	test("the handler is read-only", () => {
		const handler: ProtocolHandler = new SpacewaveProtocolHandler(fakeClient().client);
		expect("write" in handler).toBe(false);
		expect(handler.write).toBeUndefined();
	});
});

describe("world read rendering", () => {
	test("absence renders as absence, not as an empty object", () => {
		const rendered = renderWorldRead(URI, { found: false, objectKey: KEY });
		expect(rendered.content).toContain("No object at");
	});

	test("a truncated listing says so", () => {
		const rendered = renderWorldRead(URI, {
			found: true,
			objectKey: "glados/live",
			kind: "listing",
			keys: [KEY],
			truncated: true,
		});
		expect(rendered.content).toContain("(truncated)");
		expect(rendered.content).toContain(KEY);
	});

	test("the agent tree is not flattened into rows", () => {
		const rendered = renderWorldRead(URI, {
			found: true,
			objectKey: "glados/projections/agent-tree",
			kind: "agentTree",
			agentTree: { agents: [{ agentObjectKey: "glados/agents/root" }] },
		});
		expect(rendered.content).toContain("Agent tree: 1 agent");
		expect(rendered.content).toContain("glados/agents/root");
	});
});

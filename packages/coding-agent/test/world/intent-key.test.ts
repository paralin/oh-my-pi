import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	DEFAULT_DISPATCH_REPOSITORY,
	defaultCheckoutIdentity,
	defaultIntentOwnerArtifact,
	goTrimSpace,
	INTENT_KEY_PREFIX,
	type IntentKeySource,
	intentKey,
	normalizeIntentKeySource,
	semanticWorkingDirectory,
} from "@oh-my-pi/pi-coding-agent/world/intent-key";
import vectors from "./intent-key-vectors.json" with { type: "json" };

/**
 * The GLaDOS suite pins this same digest against its own copy of the file.
 * Prose cannot keep two files in two repositories identical; this can, and a
 * drifted copy fails on the side that drifted rather than silently testing
 * something else.
 */
const VECTORS_DIGEST = "3fb308927d177fd3a72879b01285f1f4b13db5d3740a3f9e0709d745959e6c00";
const VECTORS_PATH = new URL("./intent-key-vectors.json", import.meta.url);

interface IntentKeyVector {
	name: string;
	source: IntentKeySource;
	intentKey: string;
}

interface IntentKeyVectorFile {
	vectors: IntentKeyVector[];
	aliases: IntentKeyVector[];
}

const golden = vectors as IntentKeyVectorFile;

describe("dispatch intent key parity", () => {
	test("reads the same vector file GLaDOS pins", () => {
		const digest = createHash("sha256").update(readFileSync(VECTORS_PATH)).digest("hex");
		expect(digest).toBe(VECTORS_DIGEST);
	});

	test("derives the Go key for every shared golden vector", () => {
		expect(golden.vectors.length).toBeGreaterThan(1);
		for (const vector of [...golden.vectors, ...golden.aliases]) {
			expect(intentKey(vector.source).intentKey, vector.name).toBe(vector.intentKey);
		}
	});

	test("moves the key when any single identity field changes", () => {
		const base = golden.vectors[0];
		expect(base.name).toBe("base");
		const seen = new Map<string, string>([[base.intentKey, base.name]]);
		for (const vector of golden.vectors.slice(1)) {
			const existing = seen.get(vector.intentKey);
			expect(existing, `${vector.name} collides with ${existing}`).toBeUndefined();
			seen.set(vector.intentKey, vector.name);
		}
	});

	// The two languages disagree about whitespace by default and it bites both
	// ways: U+0085 is a space to Go but absent from the JS \s class, and U+FEFF
	// is the reverse. Either mistake derives a key the daemon never claimed and
	// reports existing work as absent.
	test("treats Go whitespace as Go does", () => {
		const base = golden.vectors[0];
		for (const alias of golden.aliases) {
			expect(intentKey(alias.source).intentKey, alias.name).toBe(base.intentKey);
		}
		const byteOrderMark = golden.vectors.find(vector => vector.name === "objectiveByteOrderMark");
		expect(byteOrderMark, "the vector file must cover U+FEFF").toBeDefined();
		expect(intentKey(byteOrderMark!.source).intentKey).not.toBe(base.intentKey);
	});

	test("trims exactly the characters Go trims", () => {
		expect(goTrimSpace("\u0085\u00a0 x \u2007")).toBe("x");
		// U+FEFF is not whitespace to Go, so it survives the trim.
		expect(goTrimSpace("\ufeffx")).toBe("\ufeffx");
	});

	test("derives one key for equal inputs written differently", () => {
		const base = golden.vectors[0].source;
		const reordered: IntentKeySource = {
			...base,
			objective: `\t${base.objective.trim().replace(/\s+/g, "\n  ")}  `,
			workingDirectory: `./${base.workingDirectory}/`,
			// Same surfaces, listed in the other order and with one duplicate.
			writeSurfaces: [...base.writeSurfaces].reverse().concat(base.writeSurfaces[0]),
		};
		expect(intentKey(reordered).intentKey).toBe(golden.vectors[0].intentKey);
	});

	test("returns the normalized source that must be submitted", () => {
		const { source } = intentKey(golden.vectors[0].source);
		expect(source).toEqual(normalizeIntentKeySource(golden.vectors[0].source));
		expect(source.objective).toBe("Implement dispatch identity");
		expect(source.writeSurfaces).toEqual(["plans/dispatch.org", "repos/glados/core"]);
	});

	test("mints keys under the dispatch owner's prefix", () => {
		expect(INTENT_KEY_PREFIX).toBe("di:");
		expect(intentKey(golden.vectors[0].source).intentKey.startsWith(INTENT_KEY_PREFIX)).toBe(true);
		for (const vector of golden.vectors) {
			expect(vector.intentKey.startsWith(INTENT_KEY_PREFIX), vector.name).toBe(true);
		}
	});

	test("exposes the daemon's own defaults so a caller can match them", () => {
		expect(defaultCheckoutIdentity(DEFAULT_DISPATCH_REPOSITORY)).toBe("glados");
		expect(defaultCheckoutIdentity("github.com/example/thing.git")).toBe("thing");
		expect(defaultIntentOwnerArtifact(DEFAULT_DISPATCH_REPOSITORY)).toBe("repos/glados");
		expect(semanticWorkingDirectory("/tmp/wt", "/tmp/wt/nested")).toBe("nested");
		expect(semanticWorkingDirectory("/tmp/wt", "/tmp/wt")).toBe(".");
		expect(() => semanticWorkingDirectory("/tmp/wt", "/tmp/other")).toThrow(/outside worktree/);
	});

	test("rejects identity tuples that are not portable", () => {
		const base = golden.vectors[0].source;
		expect(() => intentKey({ ...base, objective: "   " })).toThrow(/objective is required/);
		expect(() => intentKey({ ...base, repository: "" })).toThrow(/repository is required/);
		expect(() => intentKey({ ...base, workingDirectory: "/absolute" })).toThrow(/relative to its checkout/);
		expect(() => intentKey({ ...base, deliverablePaths: [] })).toThrow(/deliverable path/);
		expect(() => intentKey({ ...base, writeSurfaces: ["../escape"] })).toThrow(/workspace-relative/);
	});
});

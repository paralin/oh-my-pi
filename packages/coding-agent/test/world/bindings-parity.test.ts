/**
 * The vendored wire bindings are generator output, and this is what says so.
 *
 * Nothing under `src/world/generated/` is written by hand: GLaDOS owns the
 * llmsession and projection schemas, Spacewave owns the Resource transport, and
 * `scripts/sync-glados-world-bindings.ts` copies their generator output here.
 * That leaves two ways for the copies to become a lie — a hand edit, or a sync
 * that copied some files and not others — and both are silent, because a
 * hand-edited descriptor still compiles.
 *
 * This suite closes that. It rebuilds each copy's API shape from the bytes on
 * disk and compares it with the hash `BINDINGS.json` recorded at sync time, so
 * an edited field number, scalar type, enum value, or method kind fails here.
 * The cross-repository half — whether the *upstream* protos have moved since
 * that sync — needs the other checkouts and belongs to
 * `sync-glados-world-bindings --check`, which the live exit runs.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { extractApiShape } from "../../../../scripts/sync-glados-world-bindings";

const GENERATED_DIR = path.join(import.meta.dir, "../../src/world/generated");

interface CopyRecord {
	from: string;
	to: string;
	generatedBy: string;
	apiShapeSha256: string;
}

interface SourceRecord {
	id: string;
	checkout: string;
	protoPackage: string;
	toolVersions: string;
	protoPackageHash: string;
	protoFiles: { path: string; sha256: string }[];
	copiedFiles: CopyRecord[];
}

interface BindingsManifest {
	version: number;
	generatedDirectory: string;
	sources: SourceRecord[];
}

const bindings = JSON.parse(readFileSync(path.join(GENERATED_DIR, "BINDINGS.json"), "utf-8")) as BindingsManifest;

function readCopy(name: string): string {
	return readFileSync(path.join(GENERATED_DIR, name), "utf-8");
}

function shapeHash(source: string): string {
	return createHash("sha256").update(extractApiShape(source).join("\n")).digest("hex");
}

const copies = bindings.sources.flatMap(source => source.copiedFiles.map(copy => ({ source, copy })));

describe("vendored binding manifest", () => {
	test("records the three upstream packages OMP vendors", () => {
		expect(bindings.sources.map(source => source.id)).toEqual([
			"glados-llmsession",
			"glados-projection",
			"spacewave-resource",
		]);
		expect(bindings.generatedDirectory).toBe("packages/coding-agent/src/world/generated");
	});

	test("records a proto revision and generator for every package", () => {
		for (const source of bindings.sources) {
			expect(source.protoFiles.length).toBeGreaterThan(0);
			for (const proto of source.protoFiles) expect(proto.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(source.protoPackageHash).toMatch(/^[0-9a-f]{64}$/);
			// Taken from the generating checkout's manifest, not from the file
			// headers: the headers carry no version, only the parameter string.
			expect(source.toolVersions).toContain("protobuf-es-lite=");
			expect(source.toolVersions).toContain("starpc=");
		}
	});

	// A sync that copied some files and not others leaves the directory and the
	// manifest disagreeing, which is exactly the state that looks fine.
	test("accounts for every generated file on disk", () => {
		const onDisk = readdirSync(GENERATED_DIR)
			.filter(name => name.endsWith(".pb.ts"))
			.sort();
		const recorded = copies.map(({ copy }) => copy.to).sort();
		expect(recorded).toEqual(onDisk);
	});
});

describe("vendored binding parity", () => {
	test.each(copies.map(({ source, copy }) => [`${source.id}: ${copy.to}`, copy] as const))(
		"%s matches its recorded API shape",
		(_label, copy) => {
			expect(shapeHash(readCopy(copy.to))).toBe(copy.apiShapeSha256);
		},
	);

	test.each(copies.map(({ source, copy }) => [`${source.id}: ${copy.to}`, copy] as const))(
		"%s still names the generator and proto it came from",
		(_label, copy) => {
			const text = readCopy(copy.to);
			expect(text.split("\n", 1)[0]).toBe(`// ${copy.generatedBy}`);
			expect(text).toContain(`@generated from file`);
		},
	);

	// The guard on the guard: a shape extractor that returned nothing would make
	// every comparison above pass against an empty file.
	test("the extracted shape is non-trivial", () => {
		for (const { copy } of copies) {
			expect(extractApiShape(readCopy(copy.to)).length).toBeGreaterThan(10);
		}
	});

	// Both halves of a copy are covered, because they can be edited apart: a
	// field number lives in the generator's annotation, the scalar type lives in
	// the runtime descriptor, and changing either alone is a wire change.
	test.each([
		[
			"a renumbered field",
			"@generated from field: string caller_session_object_key = 1;",
			"@generated from field: string caller_session_object_key = 2;",
		],
		["a retyped scalar", "T: ScalarType.STRING,", "T: ScalarType.UINT32,"],
	])("%s changes the shape", (_label, from, to) => {
		const original = readCopy("llmsession.pb.ts");
		const edited = original.replace(from, to);
		// Guard the fixture itself: a needle that stopped matching would make this
		// pass without ever exercising the comparison.
		expect(edited).not.toBe(original);
		expect(shapeHash(edited)).not.toBe(shapeHash(original));
	});
});

describe("vendored W3 surface", () => {
	const llmsession = readCopy("llmsession.pb.ts");
	const srpc = readCopy("llmsession_srpc.pb.ts");

	test("carries the caller binding on the root GLaDOS service", () => {
		expect(srpc).toContain("@generated from rpc glados.sdk.llmsession.GladosResourceService.AccessWorldRuntime");
		expect(llmsession).toContain("@generated from field: string caller_session_object_key = 1;");
		// Only a child resource id comes back: the binding never looks the session
		// up, so it cannot itself fail on authority.
		expect(llmsession).toContain("export interface AccessWorldRuntimeResponse");
	});

	test("carries the authority-checked service with its two methods", () => {
		expect(srpc).toContain('typeName: "glados.sdk.llmsession.WorldRuntimeResourceService"');
		const shape = extractApiShape(srpc);
		expect(shape).toContain("method Mutate I=WorldRuntimeMutationRequest O=WorldRuntimeMutationResponse kind=Unary");
		// Server streaming, because a watch is a stream of complete snapshots.
		expect(shape).toContain(
			"method WatchDispatch I=WorldRuntimeWatchRequest O=WorldRuntimeWatchResponse kind=ServerStreaming",
		);
	});

	test("carries every result arm the client decodes", () => {
		for (const arm of [
			"dispatch_submit",
			"question_answer",
			"session_input",
			"session_interrupt",
			"authority_denial",
			"operation_failure",
		]) {
			expect(llmsession).toContain(`${arm} = `);
		}
	});

	test("carries the denial, failure, and watch enums", () => {
		const shape = extractApiShape(llmsession).join("\n");
		for (const value of [
			"WORLD_AUTHORITY_DENIAL_CODE_CALLER_NOT_FOUND",
			"WORLD_AUTHORITY_DENIAL_CODE_CALLER_MANIFEST_UNAVAILABLE",
			"WORLD_AUTHORITY_DENIAL_CODE_OPERATION_NOT_ALLOWED",
			"WORLD_OPERATION_FAILURE_CODE_INVALID_REQUEST",
			"WORLD_OPERATION_FAILURE_CODE_MISSING_TARGET",
			"WORLD_OPERATION_FAILURE_CODE_RETRY_CONFLICT",
			"WORLD_OPERATION_FAILURE_CODE_UNAVAILABLE",
			"WORLD_OPERATION_FAILURE_CODE_REJECTED",
			"WORLD_WATCH_COMPLETION_CURRENT",
			"WORLD_WATCH_COMPLETION_CUSTODY",
			"WORLD_WATCH_COMPLETION_TERMINAL",
		]) {
			expect(shape).toContain(value);
		}
	});

	// The reserved response field and the adoption method are wire-compatibility
	// facts an older vendored codec got wrong; they stay pinned here too.
	test("keeps the Spacewave resource compatibility facts", () => {
		const resource = readCopy("resource.pb.ts");
		expect(resource).toContain("supports_resource_adoption_ack");
		expect(resource).not.toContain('case: "clientError"');
		expect(readCopy("resource_srpc.pb.ts")).toContain("ResourceRefAdopt");
	});
});

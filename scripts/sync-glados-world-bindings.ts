#!/usr/bin/env bun

/**
 * Sync the generated GLaDOS and Spacewave wire bindings vendored under
 * `packages/coding-agent/src/world/generated/`.
 *
 * OMP owns no `.proto` and runs no protobuf generator. Every file in that
 * directory is generator output produced by its owning repository — GLaDOS for
 * `llmsession*` and `projection*`, Spacewave for `resource*` — and copied here.
 * This command is that copy, plus the receipt (`BINDINGS.json`) that says which
 * proto revision and generator produced it.
 *
 * Byte equality is not the contract. GLaDOS and Spacewave format their output
 * with prettier and import through paths that only resolve in their own trees;
 * OMP formats with biome and flattens both packages into one directory. What has
 * to match is the *API*: message fields with their numbers and types, enum
 * values, oneof arms, and service methods with their streaming kinds. That is
 * what `apiShapeSha256` covers, and it is recomputed from the checked-in copies
 * by `packages/coding-agent/test/world/bindings-parity.test.ts`.
 *
 * Usage:
 *   bun scripts/sync-glados-world-bindings.ts --glados <path> --spacewave <path>
 *   bun scripts/sync-glados-world-bindings.ts --check --glados <path> --spacewave <path>
 *
 * Copies are formatted with this repository's biome before their shape is
 * recorded. `OMP_BIOME_BIN` names the binary when the worktree has no
 * `node_modules`.
 *
 * `--check` changes no file. It re-reads the upstream protos, recomputes their
 * hashes, compares generator tool versions, and compares the upstream API shape
 * against the checked-in copies. It therefore fails on an upstream proto change
 * even when that repository's own generation manifest is stale, and it fails on
 * a hand edit here even when upstream never moved.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Where the vendored copies live, relative to the repository root. */
const GENERATED_DIR = "packages/coding-agent/src/world/generated";

/** The receipt this command writes and `--check` verifies against. */
const BINDINGS_FILE = "BINDINGS.json";

/** Schema version of {@link BindingsManifest}, bumped when its shape changes. */
const BINDINGS_VERSION = 1;

type CheckoutId = "glados" | "spacewave";

/** One upstream generator package whose TypeScript output OMP vendors. */
interface BindingSource {
	/** Stable id used in `BINDINGS.json` and in failure messages. */
	id: string;
	/** Which `--glados` / `--spacewave` checkout supplies it. */
	checkout: CheckoutId;
	/** Key of this package in the checkout's `.protoc-manifest.json`. */
	protoPackage: string;
	/** Proto sources, checkout-relative, in manifest order. */
	protoFiles: string[];
	/** Generated TypeScript: checkout-relative source, generated-dir file name. */
	copies: { from: string; to: string }[];
}

const SOURCES: BindingSource[] = [
	{
		id: "glados-llmsession",
		checkout: "glados",
		protoPackage: "github.com/aperturerobotics/glados/sdk/llmsession",
		protoFiles: ["sdk/llmsession/llmsession.proto"],
		copies: [
			{ from: "sdk/llmsession/llmsession.pb.ts", to: "llmsession.pb.ts" },
			{ from: "sdk/llmsession/llmsession_srpc.pb.ts", to: "llmsession_srpc.pb.ts" },
		],
	},
	{
		id: "glados-projection",
		checkout: "glados",
		protoPackage: "github.com/aperturerobotics/glados/sdk/projection",
		protoFiles: ["sdk/projection/projection.proto"],
		copies: [{ from: "sdk/projection/projection.pb.ts", to: "projection.pb.ts" }],
	},
	{
		id: "spacewave-resource",
		checkout: "spacewave",
		protoPackage: "github.com/s4wave/spacewave/bldr/resource",
		protoFiles: ["bldr/resource/resource.proto"],
		copies: [
			{ from: "bldr/resource/resource.pb.ts", to: "resource.pb.ts" },
			{ from: "bldr/resource/resource_srpc.pb.ts", to: "resource_srpc.pb.ts" },
		],
	},
];

/**
 * Module specifier rewrites applied to every copy.
 *
 * These are the only content changes a copy receives, and each exists because
 * the upstream specifier cannot resolve here. `../projection/projection.pb.js`
 * assumes GLaDOS's two-package layout, which this directory flattens; the `@go/`
 * prefix assumes a tsconfig alias, and starpc publishes the identical binding at
 * a real path.
 */
const IMPORT_REWRITES: readonly { from: string; to: string }[] = [
	{ from: "../projection/projection.pb.js", to: "./projection.pb.js" },
	{
		from: "@go/github.com/aperturerobotics/starpc/rpcstream/rpcstream.pb.js",
		to: "starpc/rpcstream/rpcstream.pb.js",
	},
];

/**
 * Value imports the copies must take as type-only imports.
 *
 * `verbatimModuleSyntax` keeps a value import in the emitted JavaScript. These
 * two are interfaces, so an emitted import of them resolves to nothing at
 * runtime and fails the module load.
 */
const TYPE_ONLY_IMPORTS: Readonly<Record<string, readonly string[]>> = {
	starpc: ["MessageStream", "ProtoRpc"],
};

interface ManifestPackageEntry {
	hash?: string;
	generatedFiles?: string[];
	protoFiles?: string[];
}

interface ProtocManifest {
	toolVersions?: string;
	packages?: Record<string, ManifestPackageEntry | undefined>;
}

interface CopyRecord {
	from: string;
	to: string;
	/** First line of the copy, naming the generator and its parameter string. */
	generatedBy: string;
	/** Hash of the extracted API shape; see {@link extractApiShape}. */
	apiShapeSha256: string;
}

interface SourceRecord {
	id: string;
	checkout: CheckoutId;
	protoPackage: string;
	/** `.protoc-manifest.json` `toolVersions` of the generating checkout. */
	toolVersions: string;
	/** `.protoc-manifest.json` package hash, which covers the proto inputs. */
	protoPackageHash: string;
	protoFiles: { path: string; sha256: string }[];
	copiedFiles: CopyRecord[];
}

interface BindingsManifest {
	version: number;
	generatedDirectory: string;
	sources: SourceRecord[];
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Reduce one generated TypeScript file to its API surface.
 *
 * The result is everything the wire depends on and nothing a formatter can
 * touch: the generator's own `@generated from` annotations (messages, fields
 * with their proto types and numbers, oneofs, enums and their values, services
 * and rpcs), the runtime field descriptors, and the service method table with
 * its streaming kinds.
 *
 * Descriptors are read from the source text rather than the annotations alone
 * because the two can be edited apart: a hand edit that changed
 * `ScalarType.STRING` to `ScalarType.UINT32` while leaving the comment intact
 * would otherwise compare equal.
 *
 * Whitespace is collapsed and quotes normalized before the descriptor scans, so
 * prettier's two-space single-quoted output and biome's tabbed double-quoted
 * output reduce to the same text. Import statements are not part of the shape,
 * which is what lets the specifier rewrites above stay invisible here.
 */
export function extractApiShape(source: string): string[] {
	const shape: string[] = [];
	for (const line of source.split("\n")) {
		const marker = line.indexOf("@generated from ");
		if (marker === -1) continue;
		const annotation = line
			.slice(marker + "@generated from ".length)
			.replace(/\*\/\s*$/, "")
			.replace(/\s+/g, " ")
			.trim();
		if (annotation) shape.push(`annotation ${annotation}`);
	}

	const flat = source.replaceAll("'", '"').replace(/\s+/g, " ");

	const fieldRe = /\{ no: (\d+), name: "([^"]+)", kind: "([^"]+)"([^{}]*?)\}/g;
	for (const match of flat.matchAll(fieldRe)) {
		const [, no, name, kind, rest] = match;
		const extra = rest.replace(/,\s*$/, "").replace(/\s+/g, " ").trim();
		shape.push(`field no=${no} name=${name} kind=${kind}${extra ? ` ${extra}` : ""}`);
	}

	const methodRe = /name: "([A-Za-z0-9_]+)", I: ([A-Za-z0-9_]+), O: ([A-Za-z0-9_]+), kind: MethodKind\.([A-Za-z]+)/g;
	for (const match of flat.matchAll(methodRe)) {
		const [, name, input, output, kind] = match;
		shape.push(`method ${name} I=${input} O=${output} kind=${kind}`);
	}

	// The trailing comma is optional because prettier emits the closing paren on
	// its own line (`], )` once collapsed) while biome keeps it tight (`])`).
	const enumRe = /createEnumType\(\s*"([\w.]+)",\s*\[(.*?)\]\s*,?\s*\)/g;
	for (const match of flat.matchAll(enumRe)) {
		const [, name, body] = match;
		shape.push(`enum ${name} ${body.replace(/\s+/g, "")}`);
	}

	return shape;
}

/** The one-line generator banner a copy carries, or an explicit absence. */
function generatedByLine(source: string): string {
	const first = source.split("\n", 1)[0]?.trim() ?? "";
	return first.startsWith("//") ? first.slice(2).trim() : "";
}

/**
 * Apply the copy's specifier rewrites and type-only import split.
 *
 * Nothing else in the file is touched. A rewrite that matched nothing is not an
 * error: `projection.pb.ts` imports neither of them.
 */
export function adaptGeneratedSource(source: string): string {
	let adapted = source;
	for (const rewrite of IMPORT_REWRITES) {
		adapted = adapted.replaceAll(`'${rewrite.from}'`, `'${rewrite.to}'`);
		adapted = adapted.replaceAll(`"${rewrite.from}"`, `"${rewrite.to}"`);
	}
	for (const [module, names] of Object.entries(TYPE_ONLY_IMPORTS)) {
		adapted = splitTypeOnlyImports(adapted, module, names);
	}
	return adapted;
}

/**
 * Move `names` out of the value import of `module` into a type-only import.
 *
 * The value import is left in place when other names remain on it, and dropped
 * entirely when it becomes empty, so a generator that stops emitting the value
 * names does not leave an empty import behind.
 */
function splitTypeOnlyImports(source: string, module: string, names: readonly string[]): string {
	const importRe = new RegExp(`import \\{([^}]*)\\} from ['"]${escapeRegExp(module)}['"];?`, "g");
	return source.replace(importRe, (statement, body: string) => {
		const imported = body
			.split(",")
			.map(part => part.trim())
			.filter(part => part.length > 0);
		if (imported.some(name => name.startsWith("type "))) return statement;
		const typeNames = imported.filter(name => names.includes(name));
		if (typeNames.length === 0) return statement;
		const valueNames = imported.filter(name => !names.includes(name));
		const typeImport = `import type { ${typeNames.join(", ")} } from '${module}'`;
		if (valueNames.length === 0) return typeImport;
		return `${typeImport}\nimport { ${valueNames.join(", ")} } from '${module}'`;
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Checkouts {
	glados: string;
	spacewave: string;
}

interface Options {
	check: boolean;
	checkouts: Partial<Checkouts>;
}

function parseArgs(argv: string[]): Options {
	const options: Options = { check: false, checkouts: {} };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--check") {
			options.check = true;
			continue;
		}
		if (arg === "--glados" || arg === "--spacewave") {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a checkout path`);
			options.checkouts[arg.slice(2) as CheckoutId] = path.resolve(value);
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		}
		throw new Error(`unknown argument: ${arg}`);
	}
	return options;
}

function printUsage(): void {
	console.log(
		[
			"Sync the generated GLaDOS and Spacewave bindings vendored by OMP.",
			"",
			"  bun scripts/sync-glados-world-bindings.ts --glados <path> --spacewave <path>",
			"  bun scripts/sync-glados-world-bindings.ts --check --glados <path> --spacewave <path>",
			"",
			"--check reads the upstream checkouts and the checked-in copies and writes nothing.",
		].join("\n"),
	);
}

function requireCheckout(checkouts: Partial<Checkouts>, checkout: CheckoutId): string {
	const value = checkouts[checkout];
	if (!value) {
		throw new Error(`--${checkout} <path> is required to reach the ${checkout} source of truth`);
	}
	return value;
}

async function readProtocManifest(checkoutPath: string): Promise<ProtocManifest> {
	const manifestPath = path.join(checkoutPath, ".protoc-manifest.json");
	const raw = await fs.readFile(manifestPath, "utf-8").catch(() => {
		throw new Error(`missing generation manifest: ${manifestPath}`);
	});
	return JSON.parse(raw) as ProtocManifest;
}

/** Build the record for one source from its checkout and the copies on disk. */
async function describeSource(
	source: BindingSource,
	checkoutPath: string,
	manifest: ProtocManifest,
	readCopy: (copy: { from: string; to: string }) => Promise<string>,
): Promise<SourceRecord> {
	const entry = manifest.packages?.[source.protoPackage];
	if (!entry?.hash) {
		throw new Error(`${source.id}: ${source.protoPackage} is not in the checkout's .protoc-manifest.json`);
	}
	const toolVersions = manifest.toolVersions;
	if (!toolVersions) throw new Error(`${source.id}: the checkout's .protoc-manifest.json declares no toolVersions`);

	const protoFiles: SourceRecord["protoFiles"] = [];
	for (const protoFile of source.protoFiles) {
		const absolute = path.join(checkoutPath, protoFile);
		const bytes = await fs.readFile(absolute).catch(() => {
			throw new Error(`${source.id}: missing proto source ${absolute}`);
		});
		protoFiles.push({ path: protoFile, sha256: sha256(bytes) });
	}

	const copiedFiles: CopyRecord[] = [];
	for (const copy of source.copies) {
		const text = await readCopy(copy);
		copiedFiles.push({
			from: copy.from,
			to: copy.to,
			generatedBy: generatedByLine(text),
			apiShapeSha256: sha256(extractApiShape(text).join("\n")),
		});
	}

	return {
		id: source.id,
		checkout: source.checkout,
		protoPackage: source.protoPackage,
		toolVersions,
		protoPackageHash: entry.hash,
		protoFiles,
		copiedFiles,
	};
}

async function readUpstream(checkoutPath: string, from: string): Promise<string> {
	const absolute = path.join(checkoutPath, from);
	return await fs.readFile(absolute, "utf-8").catch(() => {
		throw new Error(`missing generated source ${absolute}; run the owning repository's generator first`);
	});
}

async function readVendored(to: string): Promise<string> {
	const absolute = path.join(repoRoot, GENERATED_DIR, to);
	return await fs.readFile(absolute, "utf-8").catch(() => {
		throw new Error(`missing vendored binding ${absolute}`);
	});
}

async function sync(options: Options): Promise<void> {
	const sources: SourceRecord[] = [];
	for (const source of SOURCES) {
		const checkoutPath = requireCheckout(options.checkouts, source.checkout);
		const manifest = await readProtocManifest(checkoutPath);
		for (const copy of source.copies) {
			const upstream = await readUpstream(checkoutPath, copy.from);
			const adapted = adaptGeneratedSource(upstream);
			await fs.writeFile(path.join(repoRoot, GENERATED_DIR, copy.to), adapted, "utf-8");
			console.log(`copied ${source.checkout}:${copy.from} -> ${GENERATED_DIR}/${copy.to}`);
		}
		// Formatting runs before the shape is recorded so the recorded hash comes
		// from the bytes that are actually checked in.
		await formatCopies(source.copies.map(copy => copy.to));
		sources.push(await describeSource(source, checkoutPath, manifest, copy => readVendored(copy.to)));
	}
	const bindings: BindingsManifest = { version: BINDINGS_VERSION, generatedDirectory: GENERATED_DIR, sources };
	const bindingsPath = path.join(repoRoot, GENERATED_DIR, BINDINGS_FILE);
	await fs.writeFile(bindingsPath, `${JSON.stringify(bindings, null, "\t")}\n`, "utf-8");
	console.log(`wrote ${GENERATED_DIR}/${BINDINGS_FILE}`);
}

/**
 * Format the copies the way the rest of the repository is formatted.
 *
 * Only the named files are touched. A missing formatter is reported rather than
 * skipped: an unformatted copy would land in the tree and fail `biome check`
 * later, which is a worse failure than this one.
 */
async function formatCopies(names: string[]): Promise<void> {
	const targets = names.map(name => path.join(repoRoot, GENERATED_DIR, name));
	const proc = Bun.spawn([...biomeCommand(), "check", "--write", "--unsafe", ...targets], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	if (code !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`biome could not format the copied bindings (exit ${code}):\n${stderr}`);
	}
}

/**
 * Resolve the repository formatter.
 *
 * The installed binary is preferred so the copies are formatted by the exact
 * version this repository pins. `OMP_BIOME_BIN` is the escape hatch for a
 * worktree that has not been installed into: syncing bindings is otherwise
 * blocked behind a full dependency install it does not need.
 */
function biomeCommand(): string[] {
	const override = process.env.OMP_BIOME_BIN?.trim();
	if (override) return [override];
	const local = path.join(repoRoot, "node_modules/.bin/biome");
	if (existsSync(local)) return [local];
	return ["bunx", "biome"];
}

async function check(options: Options): Promise<void> {
	const bindingsPath = path.join(repoRoot, GENERATED_DIR, BINDINGS_FILE);
	const recorded = JSON.parse(await fs.readFile(bindingsPath, "utf-8")) as BindingsManifest;
	const failures: string[] = [];

	if (recorded.version !== BINDINGS_VERSION) {
		failures.push(`${BINDINGS_FILE} records version ${recorded.version}; this command writes ${BINDINGS_VERSION}`);
	}

	for (const source of SOURCES) {
		const record = recorded.sources.find(entry => entry.id === source.id);
		if (!record) {
			failures.push(`${source.id}: absent from ${BINDINGS_FILE}`);
			continue;
		}
		const checkoutPath = requireCheckout(options.checkouts, source.checkout);
		const manifest = await readProtocManifest(checkoutPath);

		// Recomputed from the proto bytes, so an upstream edit is caught even when
		// that repository never re-ran its own generator.
		const upstreamRecord = await describeSource(source, checkoutPath, manifest, copy =>
			readUpstream(checkoutPath, copy.from),
		);

		if (upstreamRecord.toolVersions !== record.toolVersions) {
			failures.push(
				`${source.id}: generator tool versions differ\n  recorded: ${record.toolVersions}\n  upstream: ${upstreamRecord.toolVersions}`,
			);
		}
		if (upstreamRecord.protoPackageHash !== record.protoPackageHash) {
			failures.push(
				`${source.id}: .protoc-manifest package hash differs\n  recorded: ${record.protoPackageHash}\n  upstream: ${upstreamRecord.protoPackageHash}`,
			);
		}
		for (const proto of upstreamRecord.protoFiles) {
			const previous = record.protoFiles.find(entry => entry.path === proto.path);
			if (!previous) {
				failures.push(`${source.id}: ${proto.path} is not recorded in ${BINDINGS_FILE}`);
			} else if (previous.sha256 !== proto.sha256) {
				failures.push(
					`${source.id}: ${proto.path} changed upstream\n  recorded: ${previous.sha256}\n  upstream: ${proto.sha256}`,
				);
			}
		}

		for (const copy of source.copies) {
			const upstreamShape = extractApiShape(await readUpstream(checkoutPath, copy.from));
			const vendoredShape = extractApiShape(await readVendored(copy.to));
			const recordedCopy = record.copiedFiles.find(entry => entry.to === copy.to);
			if (!recordedCopy) {
				failures.push(`${source.id}: ${copy.to} is not recorded in ${BINDINGS_FILE}`);
				continue;
			}
			const vendoredHash = sha256(vendoredShape.join("\n"));
			if (vendoredHash !== recordedCopy.apiShapeSha256) {
				failures.push(`${source.id}: ${copy.to} was hand edited; its API shape no longer matches ${BINDINGS_FILE}`);
			}
			const drift = firstDifference(upstreamShape, vendoredShape);
			if (drift) {
				failures.push(`${source.id}: ${copy.to} is out of sync with ${copy.from}\n  ${drift}`);
			}
		}
	}

	if (failures.length > 0) {
		console.error(`sync-glados-world-bindings --check failed:\n\n${failures.join("\n\n")}\n`);
		console.error("Re-run without --check to copy the current generator output.");
		process.exit(1);
	}
	console.log(`sync-glados-world-bindings --check: ${SOURCES.length} sources match`);
}

/** The first descriptor that differs, named so the failure is actionable. */
function firstDifference(upstream: string[], vendored: string[]): string | null {
	const length = Math.max(upstream.length, vendored.length);
	for (let i = 0; i < length; i++) {
		if (upstream[i] === vendored[i]) continue;
		return `upstream: ${upstream[i] ?? "(absent)"}\n  vendored: ${vendored[i] ?? "(absent)"}`;
	}
	return null;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.check) await check(options);
	else await sync(options);
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}

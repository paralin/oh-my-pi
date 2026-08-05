import { createHash } from "node:crypto";
import * as path from "node:path";

/**
 * The canonical semantic dispatch identity tuple.
 *
 * This mirrors `glados.sdk.llmsession.IntentKeySource` field for field. The
 * daemon re-derives the key from this tuple and rejects a submission whose key
 * does not match, so every field here participates in the digest. PeerId and
 * workerProfileDigest are an all-or-neither trailing identity pair.
 */
export interface IntentKeySource {
	ownerArtifact: string;
	objective: string;
	repository: string;
	checkoutIdentity: string;
	worktreeIdentity: string;
	workingDirectory: string;
	deliverablePaths: string[];
	writeSurfaces: string[];
	resumeSessionObjectKey?: string;
	peerId?: string;
	workerProfileDigest?: string;
}

/** Key prefix minted by the GLaDOS dispatch owner (`glados_dispatch.IntentKeyPrefix`). */
export const INTENT_KEY_PREFIX = "di:";

/** Repository the daemon assumes when a submission names none. */
export const DEFAULT_DISPATCH_REPOSITORY = "github.com/aperturerobotics/glados";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Exactly the characters Go's `unicode.IsSpace` accepts: the Latin-1 cases it
 * lists plus the Unicode White_Space table.
 *
 * JavaScript's `\s` is a different set in both directions, and both directions
 * bite. `\s` omits U+0085, so an objective separated by NEL collapses in Go and
 * not here. `\s` includes U+FEFF, so a prompt read from a BOM-prefixed UTF-8
 * file — which `cli/omp-dispatch.go` turns into the objective verbatim — has
 * the mark stripped here and kept in Go. Either way the two sides derive
 * different keys and the lookup reports work that exists as absent, which is a
 * silent false negative in the exact predicate this client exists to answer.
 */
const GO_SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;
const GO_SPACE_RUN = new RegExp(`${GO_SPACE.source}+`, "g");
const GO_SPACE_EDGES = new RegExp(`^${GO_SPACE.source}+|${GO_SPACE.source}+$`, "g");

/** `strings.TrimSpace`. */
export function goTrimSpace(value: string): string {
	return value.replace(GO_SPACE_EDGES, "");
}

/** `strings.Fields` joined by one space, which is how Go normalizes objectives. */
function goCollapseSpace(value: string): string {
	return goTrimSpace(value).replace(GO_SPACE_RUN, " ");
}

/**
 * Derive the deterministic dispatch intent key for one identity tuple.
 *
 * The derivation is a wire contract with GLaDOS `core/dispatch.IntentKey`, not
 * an implementation detail: the client computes this key *before* submitting so
 * a lost submit response is recoverable by looking the key up. Both sides
 * therefore have to agree byte for byte, which the shared golden vectors pin.
 *
 * Returns the key and the normalized source. Submit the normalized source, not
 * the raw one — the daemon derives from what it receives.
 */
export function intentKey(source: IntentKeySource): { intentKey: string; source: IntentKeySource } {
	const normalized = normalizeIntentKeySource(source);
	const workspace = [
		normalized.repository,
		normalized.checkoutIdentity,
		normalized.worktreeIdentity,
		normalized.workingDirectory,
	].join("\0");
	const workspaceDigest = `sha256:${createHash("sha256").update(workspace, "utf8").digest("hex")}`;
	const parts = [
		normalized.ownerArtifact,
		normalized.objective,
		workspaceDigest,
		normalized.deliverablePaths.join("\n"),
		normalized.writeSurfaces.join("\n"),
	];
	if (normalized.resumeSessionObjectKey) parts.push(normalized.resumeSessionObjectKey);
	if (normalized.peerId && normalized.workerProfileDigest) {
		parts.push(normalized.peerId, normalized.workerProfileDigest);
	}
	const digest = createHash("sha256").update(parts.join("\0"), "utf8").digest();
	return { intentKey: INTENT_KEY_PREFIX + base32NoPadding(digest).toLowerCase(), source: normalized };
}

/**
 * Return the canonical form of one identity tuple, or throw when it is not a
 * complete portable identity.
 *
 * Validation mirrors the World model's own: every path stays workspace-relative,
 * the objective collapses to single spaces, and path lists are sorted and
 * deduplicated so two callers that listed the same surfaces in different orders
 * claim the same work.
 */
export function normalizeIntentKeySource(source: IntentKeySource): IntentKeySource {
	const ownerArtifact = canonicalPath(source.ownerArtifact, "owner artifact", true);
	const objective = collapseObjective(source.objective);
	if (!objective) throw new Error("objective is required");

	const normalized: IntentKeySource = {
		ownerArtifact,
		objective,
		repository: requireField(source.repository, "repository"),
		checkoutIdentity: requireField(source.checkoutIdentity, "checkout identity"),
		worktreeIdentity: requireField(source.worktreeIdentity, "worktree identity"),
		workingDirectory: canonicalWorkspaceDirectory(source.workingDirectory),
		deliverablePaths: canonicalPathList(source.deliverablePaths, "deliverable path"),
		writeSurfaces: canonicalPathList(source.writeSurfaces, "write surface"),
		resumeSessionObjectKey: goTrimSpace(source.resumeSessionObjectKey ?? ""),
		peerId: goTrimSpace(source.peerId ?? ""),
		workerProfileDigest: goTrimSpace(source.workerProfileDigest ?? "").toLowerCase(),
	};
	if (normalized.deliverablePaths.length === 0) throw new Error("at least one deliverable path is required");
	if (normalized.writeSurfaces.length === 0) throw new Error("at least one write surface is required");
	if (/[\r\n\0]/.test(normalized.resumeSessionObjectKey ?? "")) {
		throw new Error("resume session object key must not contain newline or NUL");
	}
	if (Boolean(normalized.peerId) !== Boolean(normalized.workerProfileDigest)) {
		throw new Error("peer id and worker profile digest must be provided together");
	}
	if (normalized.peerId && /[\r\n\0\t ]/.test(normalized.peerId)) {
		throw new Error("peer id must not contain whitespace or NUL");
	}
	if (normalized.workerProfileDigest && !/^[0-9a-f]{64}$/.test(normalized.workerProfileDigest)) {
		throw new Error("worker profile digest must be 64 lowercase hex characters");
	}
	return normalized;
}

/**
 * The checkout identity the daemon defaults to for one repository.
 *
 * Exported because a caller that omits a field does not get the daemon's
 * default silently applied: the daemon derives the key from exactly the tuple
 * it receives, so a caller must supply the same value the daemon would have
 * chosen or the keys diverge.
 */
export function defaultCheckoutIdentity(repository: string): string {
	const trimmed = goTrimSpace(repository) || DEFAULT_DISPATCH_REPOSITORY;
	return path.posix.basename(trimmed.replace(/\/+$/, "")).replace(/\.git$/, "");
}

/** The owning artifact path the daemon defaults to for one repository. */
export function defaultIntentOwnerArtifact(repository: string): string {
	const name = defaultCheckoutIdentity(repository);
	return path.posix.join("repos", name || "glados");
}

/**
 * Project one working directory into its checkout, the way the daemon does.
 *
 * The daemon recomputes this from the paths it resolved and rejects a
 * submission whose tuple disagrees, so a caller derives it here rather than
 * guessing. Worktree identity has no client-side equivalent on purpose: the
 * daemon derives that one from the checkout it actually resolved, which is what
 * stops a client naming a checkout it is not running in.
 */
export function semanticWorkingDirectory(worktreePath: string, workingDirectory: string): string {
	const working = goTrimSpace(workingDirectory);
	if (!working) throw new Error("working directory is required");
	if (!path.isAbsolute(working)) return canonicalWorkspaceDirectory(working);
	const worktree = goTrimSpace(worktreePath);
	if (!worktree || !path.isAbsolute(worktree)) {
		throw new Error(`absolute working directory requires an absolute worktree path: ${worktreePath}`);
	}
	const relative = cleanSlashPath(path.posix.relative(path.resolve(worktree), path.resolve(working)));
	if (relative === ".." || relative.startsWith("../")) {
		throw new Error(`working directory ${workingDirectory} is outside worktree ${worktreePath}`);
	}
	return relative;
}

function requireField(value: string, field: string): string {
	if (value.includes("\0")) throw new Error(`${field} must not contain NUL`);
	const trimmed = goTrimSpace(value);
	if (!trimmed) throw new Error(`${field} is required`);
	return trimmed;
}

function collapseObjective(value: string): string {
	if (value.includes("\0")) throw new Error("objective must not contain NUL");
	return goCollapseSpace(value);
}

/**
 * Clean one workspace-relative path, preserving an `::*Heading` anchor when the
 * field allows one. The anchor is identity, not a path segment, so it is split
 * off before cleaning and reattached after.
 */
function canonicalPath(value: string, field: string, allowAnchor: boolean): string {
	if (value.includes("\0")) throw new Error(`${field} must not contain NUL`);
	let rest = goTrimSpace(value);
	if (/[\r\n\\]/.test(rest)) throw new Error(`${field} must be a workspace-relative slash path: ${value}`);
	let anchor = "";
	if (allowAnchor) {
		const index = rest.indexOf("::*");
		if (index >= 0) {
			anchor = rest.slice(index);
			rest = rest.slice(0, index);
		}
	}
	if (!rest || rest.startsWith("/") || rest.startsWith("~")) {
		throw new Error(`${field} must be a workspace-relative slash path: ${value}`);
	}
	const clean = cleanSlashPath(rest);
	if (clean === "." || clean === ".." || clean.startsWith("../")) {
		throw new Error(`${field} must be a workspace-relative slash path: ${value}`);
	}
	return clean + anchor;
}

/**
 * Clean one slash path the way Go's `path.Clean` does.
 *
 * `path.posix.normalize` keeps a trailing separator where `path.Clean` drops
 * it. That single character would change the digest, so it is dropped here.
 */
function cleanSlashPath(value: string): string {
	const normalized = path.posix.normalize(value);
	if (normalized.length > 1 && normalized.endsWith("/")) return normalized.slice(0, -1);
	return normalized;
}

function canonicalPathList(values: string[], field: string): string[] {
	const cleaned = values.map(value => canonicalPath(value, field, false)).sort();
	// Matches Go's sort-then-compact: only runs of equal neighbours collapse.
	return cleaned.filter((value, index) => index === 0 || value !== cleaned[index - 1]);
}

function canonicalWorkspaceDirectory(value: string): string {
	if (value.includes("\0")) throw new Error("working directory must not contain NUL");
	const trimmed = goTrimSpace(value);
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("~") || /[\r\n\\]/.test(trimmed)) {
		throw new Error(`working directory must be relative to its checkout: ${value}`);
	}
	const clean = cleanSlashPath(trimmed);
	if (clean === ".." || clean.startsWith("../")) {
		throw new Error(`working directory must be relative to its checkout: ${value}`);
	}
	return clean;
}

/** RFC 4648 base32 without padding, matching Go's `base32.StdEncoding`. */
function base32NoPadding(data: Uint8Array): string {
	let out = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of data) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
		}
	}
	if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
	return out;
}

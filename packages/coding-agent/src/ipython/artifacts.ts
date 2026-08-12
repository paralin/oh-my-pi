import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IpythonArtifactReference, IpythonCellResult } from "./cell";
import type { IpythonHostArtifact, IpythonHostArtifactRequest } from "./controller";

export const IPYTHON_FULL_RESULT_ARTIFACT_LABEL = "Full IPython result";

function cellDirectoryName(cellId: string): string {
	const safe = cellId.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
	return safe || "cell";
}

function mimeExtension(mimeType: string): string {
	switch (mimeType) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/gif":
			return "gif";
		case "image/webp":
			return "webp";
		case "image/svg+xml":
			return "svg";
		case "text/html":
			return "html";
		case "application/json":
			return "json";
		case "application/pdf":
			return "pdf";
		default:
			return "json";
	}
}

function mimeBytes(mimeType: string, value: unknown): Uint8Array {
	if (
		typeof value === "string" &&
		(mimeType.startsWith("image/") || mimeType === "application/pdf") &&
		mimeType !== "image/svg+xml"
	) {
		return Uint8Array.from(Buffer.from(value, "base64"));
	}
	if (typeof value === "string") return new TextEncoder().encode(value);
	return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function writeAtomic(filePath: string, bytes: Uint8Array): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, bytes, { flag: "wx" });
		await fs.rename(temporary, filePath);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

function fullResultBytes(result: IpythonCellResult): Uint8Array {
	const { artifacts: _artifacts, ...serializable } = result;
	return new TextEncoder().encode(`${JSON.stringify(serializable, null, 2)}\n`);
}

/** Refreshes allocated artifact sizes while keeping every path inside the session sidecar. */
export async function finalizeIpythonHostArtifacts(
	artifacts: readonly IpythonArtifactReference[],
	sidecarDir: string,
): Promise<readonly IpythonArtifactReference[]> {
	const root = path.resolve(sidecarDir);
	return await Promise.all(
		artifacts.map(async artifact => {
			const artifactPath = path.resolve(artifact.path);
			const relative = path.relative(root, artifactPath);
			if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
				throw new Error("IPython host artifact escaped the session sidecar");
			}
			const stats = await fs.lstat(artifactPath);
			if (!stats.isFile() || stats.isSymbolicLink()) {
				throw new Error("IPython host artifact must be a regular file");
			}
			return { ...artifact, bytes: stats.size };
		}),
	);
}

/** Spills truncated output and rich MIME payloads into the session sidecar. */
export async function spillIpythonCellArtifacts(
	result: IpythonCellResult,
	sidecarDir: string,
): Promise<readonly IpythonArtifactReference[]> {
	const cellDir = path.join(sidecarDir, "ipython", "artifacts", cellDirectoryName(result.cellId));
	const artifacts: IpythonArtifactReference[] = [];
	if (result.modelText.truncated) {
		const bytes = fullResultBytes(result);
		const artifactPath = path.join(cellDir, "full-result.json");
		await writeAtomic(artifactPath, bytes);
		artifacts.push({
			path: artifactPath,
			mimeType: "application/json",
			bytes: bytes.byteLength,
			label: IPYTHON_FULL_RESULT_ARTIFACT_LABEL,
		});
	}
	let displayIndex = 0;
	for (const event of result.events) {
		if (event.kind !== "display" && event.kind !== "result") continue;
		for (const [mimeType, value] of Object.entries(event.data)) {
			if (mimeType === "text/plain") continue;
			displayIndex += 1;
			const bytes = mimeBytes(mimeType, value);
			const artifactPath = path.join(
				cellDir,
				`${String(displayIndex).padStart(3, "0")}-${event.kind}.${mimeExtension(mimeType)}`,
			);
			await writeAtomic(artifactPath, bytes);
			artifacts.push({
				path: artifactPath,
				mimeType,
				bytes: bytes.byteLength,
				label: `IPython ${event.kind} ${displayIndex}`,
			});
		}
	}
	return artifacts;
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}

/** Atomically reserves a writable artifact path scoped to one session cell. */
export async function allocateIpythonHostArtifact(
	sidecarDir: string,
	cellId: string,
	request: IpythonHostArtifactRequest,
	signal: AbortSignal,
): Promise<IpythonHostArtifact> {
	throwIfAborted(signal);
	const label = request.label.trim();
	const mimeType = request.mimeType.trim();
	if (!label || label.length > 200) throw new RangeError("artifact label must contain 1 to 200 characters");
	if (!mimeType || mimeType.length > 200) throw new RangeError("artifact MIME type must contain 1 to 200 characters");
	if (request.suffix && !/^\.[a-zA-Z0-9]{1,16}$/.test(request.suffix)) {
		throw new Error("artifact suffix must be empty or a dot followed by 1 to 16 alphanumeric characters");
	}
	const id = crypto.randomUUID();
	const artifactDir = path.join(sidecarDir, "ipython", "artifacts", cellDirectoryName(cellId), "allocated");
	const artifactPath = path.join(artifactDir, `${id}${request.suffix}`);
	await fs.mkdir(artifactDir, { recursive: true });
	const handle = await fs.open(artifactPath, "wx");
	await handle.close();
	try {
		throwIfAborted(signal);
	} catch (error) {
		await fs.rm(artifactPath, { force: true });
		throw error;
	}
	return { id, path: artifactPath, mimeType, bytes: 0, label };
}

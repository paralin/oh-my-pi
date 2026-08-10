export type ActCancellationCapability = "cooperative-only" | "posix-managed";

/** Cancellation guarantee implemented by the current host platform. */
export function actCancellationCapability(platform: NodeJS.Platform = process.platform): ActCancellationCapability {
	return platform === "win32" ? "cooperative-only" : "posix-managed";
}

import { ToolAbortError, ToolError } from "../tools/tool-errors";
import type {
	ClientBridge,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "./client-bridge";

/** Decision-cache key for the synthetic ipython execute permission request. */
export const IPYTHON_PERMISSION_CACHE_KEY = "ipython";

export interface ClientBridgePermissionRequest {
	readonly bridge: ClientBridge;
	readonly toolCall: ClientBridgePermissionToolCall;
	readonly rawInput: unknown;
	readonly content?: unknown[];
	readonly locations: { path: string; line?: number }[];
	readonly signal?: AbortSignal;
	readonly toolName: string;
}

/**
 * Run one ACP `requestPermission` decision, racing the user's answer against
 * `signal` cancellation. Applies the persisted allow-always / reject-always
 * preference for `cacheKey` and records a renewed always-decision. Resolves
 * when the call may proceed; throws `ToolAbortError` on cancellation and
 * `ToolError` on a reject or an unknown option ID. A call may reject before
 * the client is consulted only through the persisted always decision.
 */
export async function requestClientBridgePermission(
	request: ClientBridgePermissionRequest,
	decisions: Map<string, "allow_always" | "reject_always">,
	cacheKey: string,
): Promise<void> {
	const { bridge, signal, toolName } = request;
	const persisted = decisions.get(cacheKey);
	if (persisted === "allow_always") return;
	if (persisted === "reject_always") {
		throw new ToolError(`Tool call rejected by user (preference)`);
	}
	if (signal?.aborted) {
		throw new ToolAbortError("Permission request cancelled");
	}
	type PermissionRaceResult = { kind: "permission"; outcome: ClientBridgePermissionOutcome } | { kind: "aborted" };
	const { promise: abortPromise, resolve: resolveAbort } = Promise.withResolvers<PermissionRaceResult>();
	const onAbort = () => resolveAbort({ kind: "aborted" });
	signal?.addEventListener("abort", onAbort, { once: true });
	let raced: PermissionRaceResult;
	try {
		const permissionPromise = bridge.requestPermission!(
			{
				...request.toolCall,
				status: "pending",
				rawInput: request.rawInput,
				...(request.content ? { content: request.content } : {}),
				locations: request.locations,
			},
			PERMISSION_OPTIONS,
			signal,
		).then(outcome => ({ kind: "permission" as const, outcome }));
		raced = await Promise.race([permissionPromise, abortPromise]);
	} catch (error) {
		// A client may reject its pending request when the signal aborts; the
		// signal being aborted is the decisive fact, and it must surface as a
		// cancellation rather than the client's own rejection.
		if (signal?.aborted) throw new ToolAbortError("Permission request cancelled");
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
	if (raced.kind === "aborted" || signal?.aborted) {
		throw new ToolAbortError("Permission request cancelled");
	}
	const outcome = raced.outcome;
	if (outcome.outcome === "cancelled") {
		throw new ToolAbortError("Permission request cancelled");
	}
	const selectedOption = PERMISSION_OPTIONS_BY_ID.get(outcome.optionId);
	if (!selectedOption) {
		throw new ToolError(`Tool permission response used unknown option ID: ${outcome.optionId}`);
	}
	if (selectedOption.kind === "allow_always") {
		decisions.set(cacheKey, "allow_always");
	} else if (selectedOption.kind === "reject_always") {
		decisions.set(cacheKey, "reject_always");
	}
	if (selectedOption.kind === "reject_once" || selectedOption.kind === "reject_always") {
		throw new ToolError(`Tool call rejected by user (${toolName})`);
	}
}

/** Permission options presented to the client on each gated tool call. */
export const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/** Permission options indexed by their wire identifiers; unknown IDs miss and fail closed. */
export const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

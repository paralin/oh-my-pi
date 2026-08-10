import type { Model } from "@oh-my-pi/pi-ai";
import { isClaudeModelId } from "@oh-my-pi/pi-catalog/identity/family";
import type { ToolSession } from "../../session/tool-session";
import type { ComputerSessionSnapshot } from "./protocol";

// Image transports that cannot preserve native screenshot detail resize frames
// without returning transformed dimensions. Keep their native coordinate frames
// below the empirically verified threshold so pointer actions match what the
// model sees. Claude paths predate the resolved transport capability and retain
// their established model-family fallback.
const COORDINATE_SAFE_MAX_CAPTURE_WIDTH = 1280;
const COORDINATE_SAFE_MAX_CAPTURE_HEIGHT = 896;

function usesCoordinateSafeImageSizing(model: Model | undefined): boolean {
	if (!model) return false;
	const compat = model.compat;
	return (
		(!!compat && "supportsImageDetailOriginal" in compat && compat.supportsImageDetailOriginal === false) ||
		isClaudeModelId(model.id) ||
		(model.requestModelId !== undefined && isClaudeModelId(model.requestModelId)) ||
		(typeof model.name === "string" && /^claude(?:\s|$)/i.test(model.name))
	);
}

/** Identity used by a host request to build a desktop session snapshot. */
export interface ComputerSessionIdentity {
	cwd: string;
	sessionId: string;
}

/** Builds the model-aware desktop capture and permission snapshot for one run. */
export function createComputerSessionSnapshot(
	session: ToolSession,
	readOnly: boolean,
	identity?: ComputerSessionIdentity,
): ComputerSessionSnapshot {
	const coordinateSafe = usesCoordinateSafeImageSizing(session.getActiveModel?.());
	const configuredMaxWidth = session.settings.get("computer.maxWidth");
	const configuredMaxHeight = session.settings.get("computer.maxHeight");
	return {
		cwd: identity?.cwd ?? session.cwd,
		sessionId: identity?.sessionId ?? session.getSessionId?.() ?? "computer",
		captureMaxWidth: coordinateSafe
			? Math.min(configuredMaxWidth, COORDINATE_SAFE_MAX_CAPTURE_WIDTH)
			: configuredMaxWidth,
		captureMaxHeight: coordinateSafe
			? Math.min(configuredMaxHeight, COORDINATE_SAFE_MAX_CAPTURE_HEIGHT)
			: configuredMaxHeight,
		display: session.settings.get("computer.display") ?? "all",
		readOnly,
	};
}

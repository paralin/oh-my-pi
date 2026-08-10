/**
 * ACP-side `ClientBridge` implementation. Wraps `AgentSideConnection` so the
 * read service and the permission gate in `AgentSession` can use the
 * capabilities that remain relevant to current ACP sessions.
 */
import type {
	PermissionOption as AcpPermissionOption,
	AgentSideConnection,
	ClientCapabilities,
	RequestPermissionRequest,
	ToolCallUpdate,
} from "@oh-my-pi/pi-utils/acp";
import type {
	ClientBridge,
	ClientBridgeCapabilities,
	ClientBridgePermissionOption,
	ClientBridgePermissionOutcome,
	ClientBridgePermissionToolCall,
} from "../../session/client-bridge";

export function createAcpClientBridge(
	connection: AgentSideConnection,
	sessionId: string,
	clientCapabilities: ClientCapabilities | undefined,
): ClientBridge {
	const capabilities: ClientBridgeCapabilities = {
		readTextFile: clientCapabilities?.fs?.readTextFile === true,
		// Permission requests are always usable on the connection; gating is
		// the agent's policy choice rather than a client capability.
		requestPermission: true,
	};

	const bridge: ClientBridge = { capabilities, deferAgentInitiatedTurns: true };

	if (capabilities.readTextFile) {
		bridge.readTextFile = async params => {
			const response = await connection.readTextFile({
				sessionId,
				path: params.path,
				...(typeof params.line === "number" ? { line: params.line } : {}),
				...(typeof params.limit === "number" ? { limit: params.limit } : {}),
			});
			return response.content;
		};
	}

	bridge.requestPermission = (toolCall, options, signal) =>
		requestPermission(connection, sessionId, toolCall, options, signal);

	return bridge;
}

async function requestPermission(
	connection: AgentSideConnection,
	sessionId: string,
	toolCall: ClientBridgePermissionToolCall,
	options: ClientBridgePermissionOption[],
	signal: AbortSignal | undefined,
): Promise<ClientBridgePermissionOutcome> {
	const update: ToolCallUpdate = {
		toolCallId: toolCall.toolCallId,
		title: toolCall.title,
		...(toolCall.kind ? { kind: toolCall.kind as ToolCallUpdate["kind"] } : {}),
		...(toolCall.status ? { status: toolCall.status as ToolCallUpdate["status"] } : {}),
		...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
		...(toolCall.content ? { content: toolCall.content as ToolCallUpdate["content"] } : {}),
		...(toolCall.locations ? { locations: toolCall.locations } : {}),
	};
	const acpOptions: AcpPermissionOption[] = options.map(option => ({
		optionId: option.optionId,
		name: option.name,
		kind: option.kind,
	}));
	const request: RequestPermissionRequest = {
		sessionId,
		toolCall: update,
		options: acpOptions,
	};
	if (signal?.aborted) {
		return { outcome: "cancelled" };
	}
	const response = await connection.requestPermission(request);
	const outcome = response.outcome;
	if (outcome.outcome === "cancelled") {
		return { outcome: "cancelled" };
	}
	const matched = options.find(option => option.optionId === outcome.optionId);
	return {
		outcome: "selected",
		optionId: outcome.optionId,
		...(matched ? { kind: matched.kind } : {}),
	};
}

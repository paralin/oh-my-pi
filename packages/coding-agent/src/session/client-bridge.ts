/**
 * ClientBridge — abstraction over capabilities provided by an external client
 * (e.g. an ACP editor host).
 *
 * When populated by `AcpAgent`, the read service can surface unsaved buffer
 * state and the IPython cell owner can request user permission.
 */

export interface ClientBridgeCapabilities {
	/** Client implements `fs/read_text_file`. */
	readTextFile?: boolean;
	/** Client implements `session/request_permission`. */
	requestPermission?: boolean;
}

export interface ClientBridgePermissionToolCall {
	toolCallId: string;
	toolName: string;
	title: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	rawInput?: unknown;
	content?: unknown[];
	locations?: { path: string; line?: number }[];
}

export type ClientBridgePermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface ClientBridgePermissionOption {
	optionId: string;
	name: string;
	kind: ClientBridgePermissionOptionKind;
}

export type ClientBridgePermissionOutcome =
	| { outcome: "cancelled" }
	| { outcome: "selected"; optionId: string; kind?: ClientBridgePermissionOptionKind };

export interface ClientBridge {
	readonly capabilities: ClientBridgeCapabilities;
	/** ACP v1 clients cannot show server-initiated turns as busy after prompt response. */
	readonly deferAgentInitiatedTurns?: boolean;
	readTextFile?(params: { path: string; line?: number; limit?: number }): Promise<string>;
	requestPermission?(
		toolCall: ClientBridgePermissionToolCall,
		options: ClientBridgePermissionOption[],
		signal?: AbortSignal,
	): Promise<ClientBridgePermissionOutcome>;
}

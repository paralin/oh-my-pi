import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import type { ReadonlySessionManager } from "../session/session-manager";

/** Session-owned services available to a host operation. */
export interface HostExecutionContext {
	/** Session manager (read-only). */
	sessionManager: ReadonlySessionManager;
	/** Model registry for credential resolution and model lookup. */
	modelRegistry: ModelRegistry;
	/** Current model, if the session has selected one. */
	model: Model | undefined;
	/** Whether the agent is idle. */
	isIdle(): boolean;
	/** Whether queued messages await processing. */
	hasQueuedMessages(): boolean;
	/** Abort the current agent operation. */
	abort(): void;
	/** Session settings. */
	settings?: Settings;
	/** Outbound HTTP implementation. */
	fetch?: FetchImpl;
	/** Calling session's local URL root mapping. */
	localProtocolOptions?: LocalProtocolOptions;
	/** Whether destructive host operations are auto-approved. */
	autoApprove?: boolean;
}

/** Rendering state shared by retained Task/Hub and CLI renderers. */
export interface ToolRenderOptions {
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether this is a partial or streaming result. */
	isPartial: boolean;
	/** Current spinner frame during partial rendering. */
	spinnerFrame?: number;
}

export type HostResult<TDetails = unknown> = AgentToolResult<TDetails>;

import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type { HostExecutionContext } from "./tool-types";

declare module "@oh-my-pi/pi-agent-core" {
	interface AgentToolContext extends HostExecutionContext {
		ui?: ExtensionUIContext;
		hasUI?: boolean;
	}
}

export class ToolContextStore {
	#uiContext: ExtensionUIContext | undefined;
	#hasUI = false;

	constructor(private readonly getBaseContext: () => HostExecutionContext) {}

	getContext(): AgentToolContext {
		return {
			...this.getBaseContext(),
			ui: this.#uiContext,
			hasUI: this.#hasUI,
		};
	}

	setUIContext(uiContext: ExtensionUIContext, hasUI: boolean): void {
		this.#uiContext = uiContext;
		this.#hasUI = hasUI;
	}
}

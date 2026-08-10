/**
 * Builds transcript components from persisted session message entries — the
 * file/remote-backed counterpart to {@link UiHelpers.addMessageToChat} (which is
 * bound to the live InteractiveModeContext). Used by the fullscreen transcript
 * viewer ({@link AgentTranscriptViewer}) to render a parked subagent / advisor /
 * collab-guest transcript that has no live session.
 *
 * Unlike the old incremental hub sync, {@link ChatTranscriptBuilder.rebuild}
 * always discards prior components and rebuilds the whole transcript from the
 * supplied entries. Re-rendering a growing transcript is therefore O(n) in the
 * entry count, but it cannot duplicate or misorder rows the way incremental
 * component reuse could.
 */
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Usage } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { settings } from "../../config/settings";
import type { IpythonMimeRenderer, MessageRenderer } from "../../extensibility/extensions/types";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, isIpythonJournalDetail } from "../../ipython/journal";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionMessageEntry } from "../../session/session-entries";
import { theme } from "../theme/theme";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "../utils/transcript-render-helpers";
import { createAdvisorMessageCard } from "./advisor-message";
import { AssistantMessageComponent } from "./assistant-message";
import { createBackgroundTanDispatchBlock } from "./background-tan-message";
import { BashExecutionComponent } from "./bash-execution";
import { detectCacheInvalidation } from "./cache-invalidation-marker";
import { CollabPromptMessageComponent } from "./collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "./compaction-summary-message";
import { CustomMessageComponent } from "./custom-message";
import { HistoricalPythonExecutionComponent } from "./historical-python-execution";
import { HistoricalToolExecutionComponent } from "./historical-tool-execution";
import { IpythonCellMessageComponent } from "./ipython-cell-message";
import { SkillMessageComponent } from "./skill-message";
import { TranscriptContainer } from "./transcript-container";
import { createUsageRowBlock } from "./usage-row";
import { CollapsedSyntheticMessageComponent, UserMessageComponent } from "./user-message";

export interface ChatTranscriptBuilderDeps {
	ui: TUI;
	getTool?: (name: string) => AgentTool | undefined;
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	getIpythonMimeRenderer?: (mimeType: string) => IpythonMimeRenderer | undefined;
	cwd: string;
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	requestRender: () => void;
}

/** Extracts the plain-text content of a user message (string or text blocks). */
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map(block => block.text)
		.join("");
}

export class ChatTranscriptBuilder {
	readonly container = new TranscriptContainer();
	#historicalCalls = new Map<string, HistoricalToolExecutionComponent>();
	#settledHistoricalToolCalls = new Set<string>();
	#pendingUsage: Usage | undefined;
	#pendingUsageDuration: number | undefined;
	#pendingUsageTtft: number | undefined;
	#pendingUsageTimestamp: number | undefined;
	#lastAssistantUsage: Usage | undefined;
	#expandables: Array<{ setExpanded(expanded: boolean): void }> = [];
	#expanded = false;

	constructor(private readonly deps: ChatTranscriptBuilderDeps) {}

	/** Whether the transcript currently holds any rendered rows. */
	get isEmpty(): boolean {
		return this.container.children.length === 0;
	}

	/** Discard all components and rebuild the whole transcript from `entries`. */
	rebuild(entries: SessionMessageEntry[]): void {
		this.reset();
		for (const entry of entries) this.#appendChatMessage(entry.message);
		if (this.#historicalCalls.size === 0) this.#flushPendingUsage();
	}

	/** Append newly persisted entries without rebuilding already rendered rows. */
	append(entries: SessionMessageEntry[]): void {
		for (const entry of entries) this.#appendChatMessage(entry.message);
		if (this.#historicalCalls.size === 0) this.#flushPendingUsage();
	}

	/** Toggle tool-output expansion across every expandable component. */
	setExpanded(expanded: boolean): void {
		this.#expanded = expanded;
		for (const component of this.#expandables) component.setExpanded(expanded);
	}

	get expanded(): boolean {
		return this.#expanded;
	}

	/** Discard rendered rows and clear transient build state. */
	reset(): void {
		this.#historicalCalls.clear();
		this.#settledHistoricalToolCalls.clear();
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
		this.#lastAssistantUsage = undefined;
		this.#expandables = [];
		this.container.dispose();
		this.container.clear();
	}

	dispose(): void {
		this.reset();
	}

	#trackExpandable(component: { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.#expanded);
		this.#expandables.push(component);
	}

	#flushPendingUsage(): void {
		if (!this.#pendingUsage) return;
		this.container.addChild(
			createUsageRowBlock(
				this.#pendingUsage,
				this.#pendingUsageDuration,
				this.#pendingUsageTtft,
				this.#pendingUsageTimestamp,
			),
		);
		this.#pendingUsage = undefined;
		this.#pendingUsageDuration = undefined;
		this.#pendingUsageTtft = undefined;
		this.#pendingUsageTimestamp = undefined;
	}

	#appendChatMessage(message: AgentMessage): void {
		if (message.role !== "toolResult") this.#flushPendingUsage();
		switch (message.role) {
			case "assistant":
				this.#appendAssistantMessage(message);
				break;
			case "toolResult":
				this.#appendToolResult(message);
				break;
			case "user":
			case "developer": {
				// A user prompt closes the poll-displacement window, same as the live path.
				const textContent = message.role === "user" ? userMessageText(message) : "";
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					// Synthetic (agent-attributed) inputs — chiefly the advisor's `Session
					// update` replay dumps — can be hundreds of KiB of Markdown each.
					// Rendering their full body on cold open blocked the TUI (issue #6308);
					// collapse them behind a compact summary that builds Markdown only on
					// ctrl+o expand. Real user prompts stay fully rendered.
					if (isSynthetic) {
						const collapsed = new CollapsedSyntheticMessageComponent(textContent);
						this.#trackExpandable(collapsed);
						this.container.addChild(collapsed);
					} else {
						this.container.addChild(new UserMessageComponent(textContent, false));
					}
				}
				break;
			}
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.deps.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(message.exitCode, message.cancelled, { truncation: message.meta?.truncation });
				this.container.addChild(component);
				break;
			}
			case "pythonExecution": {
				this.container.addChild(new HistoricalPythonExecutionComponent(message));
				break;
			}
			case "hookMessage":
			case "custom":
				this.#appendCustomMessage(message);
				break;
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				this.#trackExpandable(component);
				this.container.addChild(component);
				break;
			}
			case "fileMention": {
				// Indent one column to match the transcript's other rows (the viewer renders
				// body rows without an outer gutter; rows own their left pad).
				const block = buildFileMentionBlock(message.files, 1);
				if (block.children.length > 0) this.container.addChild(block);
				break;
			}
			default:
				message satisfies never;
		}
	}

	#appendAssistantMessage(message: Extract<AgentMessage, { role: "assistant" }>): void {
		const hideThinkingBlock = this.deps.hideThinkingBlock?.() ?? false;
		const proseOnlyThinking = this.deps.proseOnlyThinking ? this.deps.proseOnlyThinking() : true;
		const timeline = splitAssistantMessageToolTimeline(message);
		const assistantComponent = new AssistantMessageComponent(
			timeline.beforeTools,
			hideThinkingBlock,
			() => this.deps.requestRender(),
			this.deps.getMessageRenderer ? undefined : [], // placeholder for thinkingRenderers
			this.deps.ui.imageBudget,
			proseOnlyThinking,
		);
		assistantComponent.setImagesVisible(settings.get("terminal.showImages"));
		assistantComponent.setToolResultImagesVisible(!settings.get("display.hideToolActivity"));
		this.#trackExpandable(assistantComponent);
		this.container.addChild(assistantComponent);

		if (settings.get("display.cacheMissMarker")) {
			const invalidation = detectCacheInvalidation(this.#lastAssistantUsage, message.usage);
			if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
		}
		if (message.usage.cacheRead + message.usage.cacheWrite + message.usage.input > 0) {
			this.#lastAssistantUsage = message.usage;
		}

		const errorPresentation = resolveAssistantErrorPresentation(message);
		const hasErrorStop = errorPresentation.kind === "full";
		const errorMessage = hasErrorStop ? errorPresentation.text : null;
		const appendAssistantSegment = (segment: Extract<AgentMessage, { role: "assistant" }> | undefined) => {
			if (!segment || !assistantHasVisibleContent(segment)) return;
			const component = new AssistantMessageComponent(
				segment,
				hideThinkingBlock,
				() => this.deps.requestRender(),
				this.deps.getMessageRenderer ? undefined : [],
				undefined,
				proseOnlyThinking,
			);
			component.setImagesVisible(settings.get("terminal.showImages"));
			component.setToolResultImagesVisible(!settings.get("display.hideToolActivity"));
			this.#trackExpandable(component);
			this.container.addChild(component);
		};

		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			const afterToolSegment = timeline.afterToolCalls.get(content.id);
			if (content.name === "ipython") {
				// The journal projection is authoritative; do not duplicate it as a tool card.
				appendAssistantSegment(afterToolSegment);
				continue;
			}
			const historical = new HistoricalToolExecutionComponent(content.name, content.arguments);
			historical.setToolActivityVisible(!settings.get("display.hideToolActivity"));
			this.container.addChild(historical);
			if (hasErrorStop && errorMessage) {
				historical.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
				this.#settledHistoricalToolCalls.add(content.id);
			} else {
				this.#historicalCalls.set(content.id, historical);
			}
			appendAssistantSegment(afterToolSegment);
		}

		this.#pendingUsage =
			settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage) ? message.usage : undefined;
		this.#pendingUsageDuration = message.duration;
		this.#pendingUsageTtft = message.ttft;
		this.#pendingUsageTimestamp = message.timestamp;
	}

	#appendToolResult(message: Extract<AgentMessage, { role: "toolResult" }>): void {
		if (message.toolName === "ipython" || this.#settledHistoricalToolCalls.delete(message.toolCallId)) return;
		const pending = this.#historicalCalls.get(message.toolCallId);
		if (pending) {
			pending.updateResult(message);
			this.#historicalCalls.delete(message.toolCallId);
			return;
		}
		const historical = new HistoricalToolExecutionComponent(message.toolName, {});
		historical.setToolActivityVisible(!settings.get("display.hideToolActivity"));
		historical.updateResult(message);
		this.container.addChild(historical);
	}

	#appendCustomMessage(message: Extract<AgentMessage, { role: "custom" | "hookMessage" }>): void {
		if (!message.display) return;
		if (message.customType === IPYTHON_JOURNAL_MESSAGE_TYPE && isIpythonJournalDetail(message.details)) {
			const component = new IpythonCellMessageComponent(message.details, this.deps.getIpythonMimeRenderer);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (message.customType === "async-result") {
			this.container.addChild(buildAsyncResultBlock(message));
			return;
		}
		if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
			this.container.addChild(new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>));
			return;
		}
		if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
			this.#trackExpandable(component);
			this.container.addChild(component);
			return;
		}
		if (
			message.customType === "irc:incoming" ||
			message.customType === "irc:autoreply" ||
			message.customType === "irc:relay"
		) {
			this.container.addChild(buildIrcMessageCard(message, () => this.#expanded));
			return;
		}
		if (message.customType === "advisor") {
			const details = (message as CustomMessage<AdvisorMessageDetails>).details;
			this.container.addChild(createAdvisorMessageCard(details, () => this.#expanded, theme));
			return;
		}
		if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
			this.container.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
			return;
		}
		const handoffComponent = createHandoffSummaryMessageComponent(message as CustomMessage<unknown>, this.#expanded);
		if (handoffComponent) {
			this.#trackExpandable(handoffComponent);
			this.container.addChild(handoffComponent);
			return;
		}
		const component = new CustomMessageComponent(
			message as CustomMessage<unknown>,
			this.deps.getMessageRenderer?.(message.customType),
		);
		this.#trackExpandable(component);
		this.container.addChild(component);
	}
}

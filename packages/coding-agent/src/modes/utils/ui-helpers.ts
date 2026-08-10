import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Usage } from "@oh-my-pi/pi-ai";
import { type Component, Spacer, Text, TruncatedText } from "@oh-my-pi/pi-tui";
import type { AdvisorMessageDetails } from "../../advisor";
import { COLLAB_PROMPT_MESSAGE_TYPE, type CollabPromptDetails } from "../../collab/protocol";
import { settings } from "../../config/settings";
import { IPYTHON_JOURNAL_MESSAGE_TYPE, isIpythonJournalDetail } from "../../ipython/journal";
import { createAdvisorMessageCard } from "../../modes/components/advisor-message";
import { AssistantMessageComponent } from "../../modes/components/assistant-message";
import { createBackgroundTanDispatchBlock } from "../../modes/components/background-tan-message";
import { BashExecutionComponent } from "../../modes/components/bash-execution";
import { detectCacheInvalidation } from "../../modes/components/cache-invalidation-marker";
import { CollabPromptMessageComponent } from "../../modes/components/collab-prompt-message";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createHandoffSummaryMessageComponent,
} from "../../modes/components/compaction-summary-message";
import { CustomMessageComponent } from "../../modes/components/custom-message";
import { DynamicBorder } from "../../modes/components/dynamic-border";
import { HistoricalPythonExecutionComponent } from "../../modes/components/historical-python-execution";
import { HistoricalToolExecutionComponent } from "../../modes/components/historical-tool-execution";
import { IpythonCellMessageComponent } from "../../modes/components/ipython-cell-message";
import { SkillMessageComponent } from "../../modes/components/skill-message";
import { StrippedToolCallsPlaceholder } from "../../modes/components/stripped-tool-calls-placeholder";
import { TranscriptBlock } from "../../modes/components/transcript-container";
import { createUsageRowBlock } from "../../modes/components/usage-row";
import { UserMessageComponent } from "../../modes/components/user-message";
import { materializeImageReferenceLinksSync } from "../../modes/image-references";
import { theme } from "../../modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext, RenderSessionContextOptions } from "../../modes/types";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	SKILL_PROMPT_MESSAGE_TYPE,
	type SkillPromptDetails,
} from "../../session/messages";
import type { SessionContext, StrippedToolCallsMarker } from "../../session/session-context";
import { replaceTabs } from "../../tools/render-utils";
import { buildSkillCommandPrompt, invokeSkillCommandFromText, isKnownSkillCommand } from "../skill-command";
import { createAssistantMessageComponent } from "./interactive-context-helpers";
import {
	assistantHasVisibleContent,
	assistantUsageIsBilled,
	buildAsyncResultBlock,
	buildFileMentionBlock,
	buildIrcMessageCard,
	resolveAssistantErrorPresentation,
	splitAssistantMessageToolTimeline,
} from "./transcript-render-helpers";

type TextBlock = { type: "text"; text: string };
interface RenderInitialMessagesOptions {
	preserveExistingChat?: boolean;
	clearTerminalHistory?: boolean;
}

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};
type AddMessageOptions = {
	populateHistory?: boolean;
	imageLinks?: readonly (string | undefined)[];
	reuseSettledComponent?: boolean;
};

function imageLinksForMessage(
	message: Extract<AgentMessage, { role: "developer" | "user" }>,
	putBlobSync: InteractiveModeContext["sessionManager"]["putBlobSync"],
): (string | undefined)[] | undefined {
	if (typeof message.content === "string") return undefined;
	const images = message.content.filter(
		(content): content is ImageContent =>
			content.type === "image" && typeof content.data === "string" && typeof content.mimeType === "string",
	);
	return materializeImageReferenceLinksSync(images, putBlobSync);
}

export class UiHelpers {
	constructor(private ctx: InteractiveModeContext) {}

	/** Extract text content from a user message */
	getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((content): content is TextBlock => content.type === "text");
		return textBlocks.map(block => block.text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	showStatus(message: string, options?: { dim?: boolean }): void {
		const children = this.ctx.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;
		const useDim = options?.dim ?? true;
		// Resolve the dim color lazily so a later theme change re-shapes the line
		// instead of leaving the palette that was active when it was presented.
		const styleFn = useDim ? (t: string) => theme.fg("dim", t) : undefined;

		if (last && secondLast && last === this.ctx.lastStatusText && secondLast === this.ctx.lastStatusSpacer) {
			this.ctx.lastStatusText.setStyleFn(styleFn);
			this.ctx.lastStatusText.setText(message);
			this.ctx.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(message, 1, 0).setStyleFn(styleFn);
		this.ctx.present([spacer, text]);
		this.ctx.lastStatusSpacer = spacer;
		this.ctx.lastStatusText = text;
	}

	addMessageToChat(message: AgentMessage, options?: AddMessageOptions): Component[] {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ctx.ui, message.excludeFromContext);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(message.exitCode, message.cancelled, {
					truncation: message.meta?.truncation,
				});
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "pythonExecution": {
				this.ctx.chatContainer.addChild(new HistoricalPythonExecutionComponent(message));
				break;
			}
			case "hookMessage":
			case "custom": {
				if (message.display) {
					if (message.customType === IPYTHON_JOURNAL_MESSAGE_TYPE && isIpythonJournalDetail(message.details)) {
						const component = new IpythonCellMessageComponent(message.details, mimeType =>
							this.ctx.viewSession.getIpythonMimeRenderer(mimeType),
						);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === "async-result") {
						this.ctx.chatContainer.addChild(buildAsyncResultBlock(message));
						break;
					}
					if (message.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
						const component = new CollabPromptMessageComponent(message as CustomMessage<CollabPromptDetails>);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
						const component = new SkillMessageComponent(message as CustomMessage<SkillPromptDetails>);
						component.setExpanded(this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(component);
						break;
					}
					if (
						message.customType === "irc:incoming" ||
						message.customType === "irc:autoreply" ||
						message.customType === "irc:relay"
					) {
						const card = buildIrcMessageCard(message, () => this.ctx.toolOutputExpanded);
						this.ctx.chatContainer.addChild(card);
						return [card];
					}
					if (message.customType === "advisor") {
						const details = (message as CustomMessage<AdvisorMessageDetails>).details;
						this.ctx.chatContainer.addChild(
							createAdvisorMessageCard(details, () => this.ctx.toolOutputExpanded, theme),
						);
						break;
					}
					if (message.customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
						this.ctx.chatContainer.addChild(createBackgroundTanDispatchBlock(message as CustomMessage<unknown>));
						break;
					}
					const handoffComponent = createHandoffSummaryMessageComponent(
						message as CustomMessage<unknown>,
						this.ctx.toolOutputExpanded,
					);
					if (handoffComponent) {
						this.ctx.chatContainer.addChild(handoffComponent);
						break;
					}
					const renderer = this.ctx.viewSession.extensionRunner?.getMessageRenderer(message.customType);
					// Both HookMessage and CustomMessage have the same structure, cast for compatibility
					const component = new CustomMessageComponent(message as CustomMessage<unknown>, renderer);
					component.setExpanded(this.ctx.toolOutputExpanded);
					this.ctx.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				const component = new CompactionSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				const component = new BranchSummaryMessageComponent(message);
				component.setExpanded(this.ctx.toolOutputExpanded);
				this.ctx.chatContainer.addChild(component);
				break;
			}
			case "fileMention": {
				// Render compact file mention display
				const block = buildFileMentionBlock(message.files, 0);
				if (block.children.length > 0) this.ctx.chatContainer.addChild(block);
				break;
			}
			case "user":
			case "developer": {
				const textContent = this.ctx.getUserMessageText(message);
				if (textContent) {
					const isSynthetic = message.role === "developer" ? true : (message.synthetic ?? false);
					const cached = options?.reuseSettledComponent
						? this.ctx.transcriptMessageComponents.get(message)
						: undefined;
					let userComponent: UserMessageComponent;
					if (cached instanceof UserMessageComponent) {
						userComponent = cached;
					} else {
						const imageLinks =
							options?.imageLinks ??
							imageLinksForMessage(
								message,
								this.ctx.viewSession.sessionManager.putBlobSync.bind(this.ctx.viewSession.sessionManager),
							);
						userComponent = new UserMessageComponent(textContent, isSynthetic, imageLinks);
						this.ctx.transcriptMessageComponents.set(message, userComponent);
					}
					this.ctx.chatContainer.addChild(userComponent);
					if (options?.populateHistory && message.role === "user" && !isSynthetic) {
						this.ctx.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const cached = options?.reuseSettledComponent
					? this.ctx.transcriptMessageComponents.get(message)
					: undefined;
				const assistantComponent =
					cached instanceof AssistantMessageComponent
						? cached
						: createAssistantMessageComponent(this.ctx, splitAssistantMessageToolTimeline(message).beforeTools);
				if (cached !== assistantComponent) {
					this.ctx.transcriptMessageComponents.set(message, assistantComponent);
				}
				this.ctx.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				message satisfies never;
			}
		}
		return [];
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 */
	renderSessionContext(sessionContext: SessionContext, options: RenderSessionContextOptions = {}): void {
		// Reseed the cache-invalidation baseline: this rebuild re-derives every
		// turn's marker from usage, and the last turn becomes the live baseline.
		this.ctx.lastAssistantUsage = undefined;

		if (options.updateFooter) {
			this.ctx.statusLine.invalidate();
			this.ctx.updateEditorBorderColor();
		}

		// Defer per-turn metrics until any historical call/result pair has rendered.
		let pendingUsage: Usage | undefined;
		let pendingUsageDuration: number | undefined;
		let pendingUsageTtft: number | undefined;
		let pendingUsageTimestamp: number | undefined;
		const historicalCalls = new Map<string, HistoricalToolExecutionComponent>();
		const settledHistoricalToolCalls = new Set<string>();
		const flushPendingUsage = () => {
			if (!pendingUsage) return;
			this.ctx.chatContainer.addChild(
				createUsageRowBlock(pendingUsage, pendingUsageDuration, pendingUsageTtft, pendingUsageTimestamp),
			);
			pendingUsage = undefined;
			pendingUsageDuration = undefined;
			pendingUsageTtft = undefined;
			pendingUsageTimestamp = undefined;
		};
		const messages = sessionContext.messages;
		const count = messages.length;
		for (let i = 0; i < count; i++) {
			const message = messages[i]!;
			if (message.role !== "toolResult") flushPendingUsage();
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				const timeline = splitAssistantMessageToolTimeline(message);
				this.ctx.addMessageToChat(message, { reuseSettledComponent: options.reuseSettledComponents });
				const lastChild = this.ctx.chatContainer.children[this.ctx.chatContainer.children.length - 1];
				const assistantComponent = lastChild instanceof AssistantMessageComponent ? lastChild : undefined;
				if (assistantComponent) {
					const usage = message.usage;
					const explained = sessionContext.cacheMissExplainedAt?.[i] ?? false;
					if (this.ctx.settings.get("display.cacheMissMarker") && !explained) {
						const invalidation = detectCacheInvalidation(this.ctx.lastAssistantUsage, usage);
						if (invalidation) assistantComponent.setCacheInvalidation(invalidation);
					}
					if (usage.cacheRead + usage.cacheWrite + usage.input > 0) {
						this.ctx.lastAssistantUsage = usage;
					}
				}
				const errorPresentation = resolveAssistantErrorPresentation(message, this.ctx.viewSession.retryAttempt);
				const hasErrorStop = errorPresentation.kind === "full";
				const errorMessage = hasErrorStop ? errorPresentation.text : null;
				const appendAssistantSegment = (segment: AssistantMessage | undefined) => {
					if (!segment || !assistantHasVisibleContent(segment)) return;
					const component = createAssistantMessageComponent(this.ctx, segment);
					this.ctx.chatContainer.addChild(component);
				};

				// Removed calls render as inert history. The IPython journal owns current cell presentation.
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const afterToolSegment = timeline.afterToolCalls.get(content.id);
					if (content.name !== "ipython") {
						const historical = new HistoricalToolExecutionComponent(content.name, content.arguments);
						historical.setToolActivityVisible(!this.ctx.hideToolActivity);
						this.ctx.chatContainer.addChild(historical);
						if (hasErrorStop && errorMessage) {
							historical.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
							settledHistoricalToolCalls.add(content.id);
						} else {
							historicalCalls.set(content.id, historical);
						}
					}
					appendAssistantSegment(afterToolSegment);
				}
				// Dangling toolCalls (no result on the resolved path — failed or
				// retried turns, results on sibling branches) were stripped by the
				// context build; surface a placeholder so the turn's activity is
				// visibly elided instead of silently vanishing (the "bare thinking
				// lines" transcript trap).
				const strippedToolCalls = (message as AgentMessage & StrippedToolCallsMarker).strippedToolCalls ?? 0;
				if (strippedToolCalls > 0) {
					this.ctx.chatContainer.addChild(
						new StrippedToolCallsPlaceholder(strippedToolCalls, !this.ctx.hideToolActivity),
					);
				}
				pendingUsage =
					this.ctx.settings.get("display.showTokenUsage") && assistantUsageIsBilled(message.usage)
						? message.usage
						: undefined;
				pendingUsageDuration = message.duration;
				pendingUsageTtft = message.ttft;
				pendingUsageTimestamp = message.timestamp;
			} else if (message.role === "toolResult") {
				if (message.toolName === "ipython" || settledHistoricalToolCalls.delete(message.toolCallId)) continue;
				const historical = historicalCalls.get(message.toolCallId);
				if (historical) {
					historical.updateResult(message);
					historicalCalls.delete(message.toolCallId);
				} else {
					const orphan = new HistoricalToolExecutionComponent(message.toolName, {});
					orphan.setToolActivityVisible(!this.ctx.hideToolActivity);
					orphan.updateResult(message);
					this.ctx.chatContainer.addChild(orphan);
				}
			} else {
				this.ctx.addMessageToChat(message, options);
			}
		}
		flushPendingUsage();
		this.ctx.ui.requestRender();
	}

	renderInitialMessages(options: RenderInitialMessagesOptions = {}): void {
		// This path is used to rebuild the visible chat transcript (e.g. after custom/debug UI).
		// Clear existing rendered chat first to avoid duplicating the full session in the container.
		// On a non-preserving rebuild the existing blocks are discarded for good, so
		// dispose them (stopping any live timers/subscriptions) before clearing. When
		// preserving, the same instances are re-added below, so detach without dispose.
		const preservedChatChildren = options.preserveExistingChat ? this.ctx.chatContainer.children : undefined;
		this.ctx.initialChatRendered = true;
		if (preservedChatChildren) {
			this.ctx.chatContainer.clear();
		} else {
			this.ctx.resetTranscript();
		}
		this.ctx.pendingMessagesContainer.disposeChildren();
		this.ctx.pendingBashComponents = [];

		// Live display collapses to the compacted transcript tail unless the
		// user opted into the full inline history; export/resume callers can
		// still request either mode.
		const context = this.ctx.viewSession.buildTranscriptSessionContext({
			collapseCompactedHistory: settings.get("display.collapseCompacted"),
			keepDanglingToolCalls: this.ctx.viewSession.isStreaming,
		});
		this.ctx.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: !this.ctx.focusedAgentId,
		});

		// Show compaction info if session was compacted
		const allEntries = this.ctx.viewSession.sessionManager.getEntries();
		let compactionCount = 0;
		for (const entry of allEntries) {
			if (entry.type === "compaction") {
				compactionCount++;
			}
		}
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.ctx.showStatus(`Session compacted ${times}`);
		}
		if (options.clearTerminalHistory) {
			this.ctx.ui.requestRender(true, { clearScrollback: true });
		}
		if (preservedChatChildren && preservedChatChildren.length > 0) {
			for (const child of preservedChatChildren) {
				this.ctx.chatContainer.addChild(child);
			}
			this.ctx.ui.requestRender();
		}
	}

	clearEditor(): void {
		this.ctx.editor.clearDraft();
		this.ctx.ui.requestRender();
	}

	showError(errorMessage: string): void {
		const text = new Text(`Error: ${errorMessage}`, 1, 0).setStyleFn(t => theme.fg("error", t));
		this.ctx.present([new Spacer(1), text]);
	}

	showWarning(warningMessage: string): void {
		const text = new Text(`Warning: ${warningMessage}`, 1, 0).setStyleFn(t => theme.fg("warning", t));
		this.ctx.present([new Spacer(1), text]);
	}

	showNewVersionNotification(newVersion: string): void {
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		const title = "Update Available";
		const prefix = `New version ${newVersion} is available. Run: `;
		const command = "omp update";
		block.addChild(
			new Text(`${title}\n${prefix}${command}`, 1, 0).setStyleFn(
				() =>
					`${theme.bold(theme.fg("warning", title))}\n${theme.fg("muted", prefix)}${theme.fg("accent", command)}`,
			),
		);
		block.addChild(new DynamicBorder(text => theme.fg("warning", text)));
		this.ctx.present(block);
	}

	updatePendingMessagesDisplay(): void {
		this.ctx.pendingMessagesContainer.disposeChildren();
		const queuedMessages = this.ctx.viewSession.getQueuedMessages() as QueuedMessages;

		const steeringMessages = [...queuedMessages.steering];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "steer") steeringMessages.push(entry.text);
		}

		const followUpMessages = [...queuedMessages.followUp];
		for (const entry of this.ctx.compactionQueuedMessages as CompactionQueuedMessage[]) {
			if (entry.mode === "followUp") followUpMessages.push(entry.text);
		}

		const groups = [
			{ label: "Steering", messages: steeringMessages },
			{ label: "After yield", messages: followUpMessages },
		].filter(group => group.messages.length > 0);
		if (groups.length > 0) {
			this.ctx.pendingMessagesContainer.addChild(new Spacer(1));
			for (const group of groups) {
				const heading = theme.fg("muted", `${group.label}${theme.sep.dot}${group.messages.length}`);
				this.ctx.pendingMessagesContainer.addChild(new TruncatedText(heading, 1, 0));
				for (let index = 0; index < group.messages.length; index++) {
					const message = replaceTabs(group.messages[index] ?? "").replace(/\r?\n/g, " ↵ ");
					const queuedText = theme.fg("dim", `  ${index + 1}. ${message}`);
					this.ctx.pendingMessagesContainer.addChild(new TruncatedText(queuedText, 1, 0));
				}
			}
			const dequeueKey = this.ctx.keybindings.getDisplayString("app.message.dequeue") || "Alt+Up";
			const hintText = theme.fg("dim", `  ${theme.tree.hook} ${dequeueKey} to edit`);
			this.ctx.pendingMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		this.ctx.ui.requestComponentRender(this.ctx.pendingMessagesContainer);
	}

	queueCompactionMessage(text: string, mode: "steer" | "followUp", images?: ImageContent[]): void {
		const queuedImages = images && images.length > 0 ? images : undefined;
		this.ctx.compactionQueuedMessages.push({ text, mode, images: queuedImages } as CompactionQueuedMessage);
		this.ctx.editor.clearDraft(text);
		this.ctx.updatePendingMessagesDisplay();
		this.ctx.showStatus(
			queuedImages ? "Queued message with image for after compaction" : "Queued message for after compaction",
		);
	}

	async #deliverQueuedMessage(message: CompactionQueuedMessage): Promise<void> {
		if (
			await invokeSkillCommandFromText(this.ctx, message.text, message.mode, {
				propagateErrors: true,
				queueOnly: true,
				images: message.images,
			})
		) {
			return;
		}
		if (this.ctx.isKnownSlashCommand(message.text)) {
			await this.ctx.session.prompt(message.text);
			return;
		}
		await this.ctx.withLocalSubmission(
			message.text,
			() =>
				message.mode === "followUp"
					? this.ctx.session.followUp(message.text, message.images)
					: this.ctx.session.steer(message.text, message.images),
			{ imageCount: message.images?.length ?? 0 },
		);
	}

	isKnownSlashCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!commandName) return false;

		if (this.ctx.session.extensionRunner?.getCommand(commandName)) {
			return true;
		}

		for (const command of this.ctx.session.customCommands) {
			if (command.command.name === commandName) {
				return true;
			}
		}

		return this.ctx.fileSlashCommands.has(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.ctx.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...(this.ctx.compactionQueuedMessages as CompactionQueuedMessage[])];
		this.ctx.compactionQueuedMessages = [] as CompactionQueuedMessage[];
		this.ctx.updatePendingMessagesDisplay();

		const restoreQueue = (error: unknown) => {
			this.ctx.session.clearQueue();
			this.ctx.compactionQueuedMessages = queuedMessages;
			this.ctx.updatePendingMessagesDisplay();
			this.ctx.showError(
				`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		};

		try {
			if (options?.willRetry) {
				for (const message of queuedMessages) {
					await this.#deliverQueuedMessage(message);
				}
				this.ctx.updatePendingMessagesDisplay();
				return;
			}

			let firstPromptIndex = -1;
			for (let i = 0; i < queuedMessages.length; i++) {
				if (!this.ctx.isKnownSlashCommand(queuedMessages[i].text)) {
					firstPromptIndex = i;
					break;
				}
			}
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) {
					await this.ctx.session.prompt(message.text);
				}
				return;
			}

			const preCommands = queuedMessages.slice(0, firstPromptIndex);
			const firstPrompt = queuedMessages[firstPromptIndex];
			const rest = queuedMessages.slice(firstPromptIndex + 1);

			for (const message of preCommands) {
				// preCommands are all slash commands; #deliverQueuedMessage handles
				// that branch (no local-submission marking needed since slash
				// commands don't generate a matching user message_start).
				await this.#deliverQueuedMessage(message);
			}

			// First prompt is fire-and-forget — its rejection is funneled through
			// `restoreQueue` rather than rethrown. Plain prompts use primitive
			// recordLocalSubmission and dispose manually in the catch. Skill prompts
			// are rebuilt as user-attributed custom messages so queued `/skill:` text
			// is not sent as a literal prompt after compaction.
			let promptPromise: Promise<unknown>;
			if (isKnownSkillCommand(this.ctx, firstPrompt.text)) {
				const built = await buildSkillCommandPrompt(
					this.ctx,
					firstPrompt.text,
					firstPrompt.mode,
					firstPrompt.images,
				);
				promptPromise = built
					? this.ctx.session.promptCustomMessage(built.message, built.options).catch(restoreQueue)
					: Promise.resolve();
			} else {
				const disposeFirstPrompt = this.ctx.recordLocalSubmission(
					firstPrompt.text,
					firstPrompt.images?.length ?? 0,
				);
				promptPromise = this.ctx.session
					.prompt(firstPrompt.text, {
						streamingBehavior: firstPrompt.mode === "followUp" ? "followUp" : "steer",
						images: firstPrompt.images,
					})
					.catch((error: unknown) => {
						disposeFirstPrompt();
						restoreQueue(error);
					});
			}

			for (const message of rest) {
				await this.#deliverQueuedMessage(message);
			}
			this.ctx.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	/** Move pending bash components from pending area to chat */
	flushPendingBashComponents(): void {
		for (const component of this.ctx.pendingBashComponents) {
			this.ctx.pendingMessagesContainer.removeChild(component);
			this.ctx.chatContainer.addChild(component);
		}
		this.ctx.pendingBashComponents = [];
	}

	findLastAssistantMessage(): AssistantMessage | undefined {
		for (let i = this.ctx.viewSession.messages.length - 1; i >= 0; i--) {
			const message = this.ctx.viewSession.messages[i];
			if (message?.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	extractAssistantText(message: AssistantMessage): string {
		let text = "";
		for (const content of message.content) {
			if (content.type === "text") {
				text += content.text;
			}
		}
		return text.trim();
	}
}

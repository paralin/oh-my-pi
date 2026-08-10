/**
 * Hub messaging half — agent-to-agent messaging over the process-global IrcBus.
 *
 * `send` is fire-and-forget: the bus routes the message to the recipient
 * (waking idle agents with a real turn, reviving parked ones via the
 * lifecycle manager, injecting a non-interrupting aside into busy ones) and
 * returns delivery receipts immediately. Replies are real turns by the
 * recipient, observed with `wait` (or the `await: true` send sugar). `inbox`
 * drains pending messages; `list` shows every addressable peer.
 */

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, Snowflake } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { CoordinationBackend, CoordinationPeerRoster } from "../../coordination/backend";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../../irc/bus";
import type { Theme } from "../../modes/theme/theme";
import { ParentOperationError } from "../../parent/client";
import { type AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { isAgentSession } from "../../session/agent-session";
import { canSpawnAtDepth } from "../../task/types";
import { Ellipsis, renderStatusLine, truncateToWidth } from "../../tui";
import { createCachedComponent, getPreviewLines, replaceTabs } from "../render-utils";
import { type CoordinationDetails, type HubPeerInfo, hubErrorResult } from "./types";

export const DEFAULT_IRC_TIMEOUT_MS = 120_000;

/**
 * Messaging availability: there must be someone to chat with. True for every
 * subagent (it always has a parent, and possibly siblings) and for any
 * session that can still spawn subagents through the task tool. Only a
 * top-level session with task spawning unavailable has no peers.
 */
export function isIrcEnabled(settings: Settings, taskDepth: number): boolean {
	if (taskDepth > 0) return true;
	// Top-level session: peers exist only if it can still spawn subagents — the
	// same capacity gate the task tool uses, reused here to avoid drift.
	const maxDepth = settings.get("task.maxRecursionDepth") ?? 2;
	return canSpawnAtDepth(maxDepth, taskDepth);
}

export function formatIncoming(msg: IrcMessage): string {
	const replyTag = msg.replyTo ? ` (reply to ${msg.replyTo})` : "";
	return `[${msg.id}] ${msg.from}${replyTag}: ${msg.body}`;
}

export function normalizeIrcTimeoutMs(value: number): number {
	if (value === 0) return 0; // 0 = timeout disabled
	// Negative or non-finite settings are misconfigurations — fall back to the
	// default instead of producing an instant 1 ms timeout.
	if (!Number.isFinite(value) || value < 0) return DEFAULT_IRC_TIMEOUT_MS;
	return Math.max(1, Math.trunc(value));
}

/** Effective message-wait timeout: explicit param wins, then `irc.timeoutMs`. */
export function resolveMessageTimeoutMs(settings: Settings, explicit?: number): number {
	if (explicit !== undefined) return normalizeIrcTimeoutMs(explicit);
	return normalizeIrcTimeoutMs(settings.get("irc.timeoutMs"));
}

/** Session-buffered inbox drain used before parking a bus waiter. */
export function drainPendingInbox(
	registry: AgentRegistry,
	senderId: string,
	from?: string,
	coordinationBackend?: CoordinationBackend,
): IrcMessage | undefined {
	const parent = coordinationBackend?.inbox({ from, limit: 1 })[0];
	if (parent) return parent;
	const session = registry.get(senderId)?.session;
	return isAgentSession(session) ? session.drainPendingIrcInboxMessages(senderId, { from, limit: 1 })[0] : undefined;
}

/** `wait` result carrying a consumed message. */
export function messageResult(senderId: string, waited: IrcMessage): AgentToolResult<CoordinationDetails> {
	return {
		content: [{ type: "text", text: formatIncoming(waited) }],
		details: { op: "wait", from: senderId, waited },
	};
}

/**
 * List every addressable peer, restoring parked refs from disk when a resumed
 * session has no in-memory roster.
 */
export async function executeList(
	registry: AgentRegistry,
	senderId: string,
	parentRoster?: CoordinationPeerRoster,
): Promise<AgentToolResult<CoordinationDetails>> {
	let localRefs = registry.list();
	if (!localRefs.some(ref => ref.id !== senderId && ref.status !== "aborted" && ref.kind !== "advisor")) {
		await registerPersistedSubagents(registry, registry.get(senderId)?.sessionFile);
		localRefs = registry.list();
	}
	const rosterErrors = [...(parentRoster?.errors ?? [])];
	const localIds = new Set(localRefs.filter(ref => ref.kind !== "advisor").map(ref => ref.id));
	for (const ref of parentRoster?.peers ?? []) {
		if (!localIds.has(ref.id)) continue;
		if (rosterErrors.some(error => error.code === "identity_conflict" && error.peerId === ref.id)) continue;
		rosterErrors.push({
			code: "identity_conflict",
			peerId: ref.id,
			detail: `Peer ID ${ref.id} is present in both the local registry and the parent Agent tree`,
		});
	}

	const bus = IrcBus.global();
	const localPeers: HubPeerInfo[] = localRefs
		.filter(ref => ref.id !== senderId && ref.status !== "aborted" && ref.kind !== "advisor")
		.map(ref => ({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			unread: bus.unreadCount(ref.id),
			lastActivity: ref.lastActivity,
			activity: ref.activity,
		}));
	const parentPeers: HubPeerInfo[] = (parentRoster?.peers ?? [])
		.filter(ref => ref.id !== senderId && ref.kind !== "advisor")
		.map(ref => ({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			status: ref.status,
			parentId: ref.parentId,
			unread: 0,
			lastActivity: ref.lastActivity,
			activity: ref.activity,
			source: "parent" as const,
		}));
	const peers = [...localPeers, ...parentPeers];
	const lines: string[] = [];
	if (peers.length === 0) {
		lines.push("No other agents.");
	} else {
		lines.push(`${peers.length} peer(s):`);
		for (const peer of peers) {
			const extras = [
				peer.activity || undefined,
				peer.unread > 0 ? `unread ${peer.unread}` : undefined,
				peer.parentId ? `parent ${peer.parentId}` : undefined,
				`active ${formatDuration(Math.max(0, Date.now() - peer.lastActivity))} ago`,
			].filter(Boolean);
			const source = peer.source === "parent" ? " · parent" : "";
			lines.push(
				`- ${peer.id} [${peer.displayName} · ${peer.kind} · ${peer.status}${source}] — ${extras.join(", ")}`,
			);
		}
		if (localPeers.some(peer => peer.status === "parked")) {
			lines.push("");
			lines.push("Parked agents are revived automatically when you message them.");
		}
	}
	if (rosterErrors.length) {
		lines.push("", `${rosterErrors.length} Parent roster error(s):`);
		for (const error of rosterErrors) lines.push(`- ${error.peerId}: ${error.code} — ${error.detail}`);
	}
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			op: "list",
			from: senderId,
			peers,
			...(rosterErrors.length > 0 ? { rosterErrors } : {}),
		},
	};
}

export interface HubSendParams {
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	timeoutMs?: number;
}

function parentErrorDetails(error: unknown): Pick<CoordinationDetails, "parentError"> {
	if (!(error instanceof ParentOperationError)) return {};
	return {
		parentError: {
			kind: "operation",
			operation: "coordination",
			code: error.code,
			codeName: error.codeName,
			detail: error.detail,
			requiredCapability: error.requiredCapability,
		},
	};
}

async function executeParentSend(
	deps: {
		senderId: string;
		settings: Settings;
		coordinationBackend: CoordinationBackend;
	},
	to: string,
	message: string,
	params: HubSendParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const outbound: IrcMessage = {
		id: Snowflake.next(),
		from: deps.senderId,
		to,
		body: message,
		ts: Date.now(),
		...(params.replyTo ? { replyTo: params.replyTo } : {}),
		expectsReply: params.await || undefined,
		source: "parent",
	};
	const timeoutMs = params.await ? resolveMessageTimeoutMs(deps.settings, params.timeoutMs) : undefined;
	const waitAbort = params.await ? new AbortController() : undefined;
	const waitCancelled = new Error("Parent IRC await cancelled");
	let removeAbortListener: (() => void) | undefined;
	const waiting =
		params.await && waitAbort
			? deps.coordinationBackend
					.waitMessage({ from: to, replyTo: outbound.id }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, waitAbort.signal)
					.then(
						value => ({ message: value, error: null as Error | null }),
						error => ({
							message: null,
							error: error === waitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
						}),
					)
			: undefined;
	if (waitAbort && signal) {
		if (signal.aborted) {
			waitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
		} else {
			const onAbort = (): void => {
				waitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	try {
		let receipt: IrcDeliveryReceipt;
		try {
			receipt = await deps.coordinationBackend.send(
				{ targetPeerId: to, message: outbound, expectsReply: params.await || undefined },
				signal,
			);
		} catch (error) {
			waitAbort?.abort(waitCancelled);
			await waiting;
			const detail = error instanceof Error ? error.message : String(error);
			return hubErrorResult(detail, {
				op: "send",
				from: deps.senderId,
				to,
				receipts: [{ to, outcome: "failed", error: detail }],
				...parentErrorDetails(error),
			});
		}
		const lines = [
			"Delivered to 1 peer(s):",
			`- ${receipt.to}: ${receipt.outcome}${receipt.queueOutcome ? ` (${receipt.queueOutcome})` : ""}`,
		];
		let waited: IrcMessage | null | undefined;
		if (waiting && timeoutMs !== undefined) {
			lines.push("");
			const reply = await waiting;
			if (reply.error) {
				if (signal?.aborted) {
					lines.push(
						`Send delivered but the reply wait was interrupted before ${to} answered. ` +
							"Check `inbox` or `wait` again after handling the interrupt.",
					);
				} else {
					return hubErrorResult(reply.error.message, {
						op: "send",
						from: deps.senderId,
						to,
						receipts: [receipt],
					});
				}
			} else {
				waited = reply.message;
				if (waited) {
					lines.push(`Reply from ${waited.from}:`, waited.body);
				} else {
					lines.push(
						`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
							"They may answer later — check `inbox` or `wait` again.",
					);
				}
			}
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: deps.senderId,
				to,
				receipts: [receipt],
				...(waited !== undefined ? { waited } : {}),
			},
		};
	} finally {
		waitAbort?.abort(waitCancelled);
		removeAbortListener?.();
	}
}

export async function executeSend(
	deps: {
		registry: AgentRegistry;
		senderId: string;
		settings: Settings;
		coordinationBackend?: CoordinationBackend;
	},
	params: HubSendParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings } = deps;
	const to = params.to?.trim();
	const message = params.message?.trim();
	if (!to) {
		return hubErrorResult('`to` is required for op="send".', { op: "send", from: senderId });
	}
	if (!message) {
		return hubErrorResult('`message` is required for op="send".', { op: "send", from: senderId });
	}
	if (to === senderId) {
		return hubErrorResult("Cannot send a message to yourself.", { op: "send", from: senderId, to });
	}
	const isBroadcast = to === "all";
	if (isBroadcast && params.await) {
		return hubErrorResult('`await` is invalid with to:"all" — broadcasts have no single replier.', {
			op: "send",
			from: senderId,
			to,
		});
	}
	const backend = deps.coordinationBackend;
	if (backend && !isBroadcast) {
		let roster: CoordinationPeerRoster;
		try {
			roster = await backend.listPeers(signal);
		} catch (error) {
			return hubErrorResult(error instanceof Error ? error.message : String(error), {
				op: "send",
				from: senderId,
				to,
				...parentErrorDetails(error),
			});
		}
		const rosterError = roster.errors.find(error => error.peerId === to);
		if (rosterError?.code === "identity_conflict") {
			return hubErrorResult(rosterError.detail, {
				op: "send",
				from: senderId,
				to,
				rosterErrors: [rosterError],
			});
		}
		const parentTarget = roster.peers.some(ref => ref.id === to);
		const localTarget = registry.get(to);
		if (parentTarget && localTarget) {
			const conflict = {
				code: "identity_conflict" as const,
				peerId: to,
				detail: `Peer ID ${to} is present in both the local registry and the parent Agent tree`,
			};
			return hubErrorResult(conflict.detail, {
				op: "send",
				from: senderId,
				to,
				rosterErrors: [conflict],
			});
		}
		if (parentTarget || rosterError !== undefined || !localTarget) {
			return await executeParentSend(
				{ senderId, settings, coordinationBackend: backend },
				to,
				message,
				params,
				signal,
			);
		}
	}

	const bus = IrcBus.global();
	let waited: IrcMessage | null | undefined;
	const timeoutMs = params.await ? resolveMessageTimeoutMs(settings, params.timeoutMs) : undefined;
	const awaitAbort = params.await ? new AbortController() : undefined;
	const awaitCancelled = new Error("IRC await cancelled");
	let removeAwaitAbortListener: (() => void) | undefined;
	const waiting = params.await
		? bus
				.wait(senderId, { from: to }, timeoutMs ?? DEFAULT_IRC_TIMEOUT_MS, awaitAbort?.signal, {
					drainPending: false,
				})
				.then(
					message => ({ message, error: null as Error | null }),
					error => ({
						message: null,
						error: error === awaitCancelled ? null : error instanceof Error ? error : new Error(String(error)),
					}),
				)
		: undefined;
	if (params.await && signal && awaitAbort) {
		if (signal.aborted) {
			awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
		} else {
			const onAbort = (): void => {
				awaitAbort.abort(signal.reason instanceof Error ? signal.reason : new Error("IRC wait aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			removeAwaitAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	try {
		// Broadcasts fan out to live peers only (running | idle); reviving every
		// parked agent on a broadcast would be a stampede. Direct sends go
		// through the bus unfiltered so parked recipients are revived.
		const targets = isBroadcast ? registry.listVisibleTo(senderId).map(ref => ref.id) : [to];
		// A broadcast that also reaches the main agent delivers the body to it
		// directly (its own incoming card); relaying the sibling legs to the
		// main UI would then show the same body once per other recipient.
		const suppressRelay = isBroadcast && targets.includes(MAIN_AGENT_ID);
		const receipts = await Promise.all(
			targets.map(target =>
				bus.send(
					{ from: senderId, to: target, body: message, replyTo: params.replyTo },
					// Awaited sends mark the sender as blocked on an answer so a
					// busy recipient that cannot reach a step boundary (async
					// disabled) auto-replies instead of stranding the sender.
					{ expectsReply: params.await || undefined, suppressRelay: suppressRelay || undefined },
				),
			),
		);

		const lines: string[] = [];
		const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
		if (targets.length === 0) {
			lines.push("No live peers to broadcast to.");
		} else if (delivered.length === 0) {
			lines.push("No recipients received the message.");
		} else {
			lines.push(`Delivered to ${delivered.length} peer(s):`);
		}
		for (const receipt of receipts) {
			lines.push(
				receipt.outcome === "failed"
					? `- ${receipt.to}: failed — ${receipt.error ?? "unknown error"}`
					: `- ${receipt.to}: ${receipt.outcome}`,
			);
		}

		if (params.await && waiting && timeoutMs !== undefined) {
			lines.push("");
			if (delivered.length > 0) {
				const reply = await waiting;
				if (reply.error) {
					// The send already succeeded; if the wait was interrupted by our
					// caller signal (steering / messaging), preserve the delivery receipt
					// so the agent loop keeps this tool as "sent" instead of marking it
					// skipped, which would prompt a duplicate resend on the next turn.
					if (signal?.aborted) {
						lines.push(
							`Send delivered but the reply wait was interrupted before ${to} answered. ` +
								"Check `inbox` or `wait` again after handling the interrupt.",
						);
					} else {
						throw reply.error;
					}
				} else {
					waited = reply.message;
					if (waited) {
						lines.push(`Reply from ${waited.from}:`);
						lines.push(waited.body);
					} else {
						lines.push(
							`No reply from ${to} within ${formatDuration(timeoutMs)}. ` +
								"They may answer later — check `inbox` or `wait` again.",
						);
					}
				}
			} else {
				awaitAbort?.abort(awaitCancelled);
				const reply = await waiting;
				if (reply.error) throw reply.error;
			}
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				op: "send",
				from: senderId,
				to,
				receipts,
				...(waited !== undefined ? { waited } : {}),
			},
			isError: delivered.length === 0 && targets.length > 0,
		};
	} finally {
		awaitAbort?.abort(awaitCancelled);
		removeAwaitAbortListener?.();
	}
}

/** Pure message wait with the selected coordination backend and current liveness rules. */
export async function executeMessageWait(
	deps: {
		registry: AgentRegistry;
		senderId: string;
		settings: Settings;
		coordinationBackend?: CoordinationBackend;
	},
	params: { from?: string; timeoutMs?: number },
	signal?: AbortSignal,
): Promise<AgentToolResult<CoordinationDetails>> {
	const { registry, senderId, settings, coordinationBackend } = deps;
	const from = params.from?.trim() || undefined;
	const timeoutMs = resolveMessageTimeoutMs(settings, params.timeoutMs);
	try {
		let useParent = coordinationBackend !== undefined;
		if (coordinationBackend && from) {
			const roster = await coordinationBackend.listPeers(signal);
			const rosterError = roster.errors.find(error => error.peerId === from);
			if (rosterError?.code === "identity_conflict") throw new Error(rosterError.detail);
			const parentTarget = roster.peers.some(ref => ref.id === from);
			const localTarget = registry.get(from);
			if (parentTarget && localTarget) {
				throw new Error(`Peer ID ${from} is present in both the local registry and the parent Agent tree`);
			}
			useParent = parentTarget || rosterError !== undefined || !localTarget;
		}
		const waited =
			useParent && coordinationBackend
				? await coordinationBackend.waitMessage({ from }, timeoutMs, signal)
				: await IrcBus.global().wait(senderId, { from }, timeoutMs, signal, {
						liveness: { registry, senderId },
					});
		if (!waited) {
			const filterNote = from ? ` from ${from}` : "";
			return {
				content: [{ type: "text", text: `No message${filterNote} within ${formatDuration(timeoutMs)}.` }],
				details: { op: "wait", from: senderId, waited: null },
				useless: true,
			};
		}
		return messageResult(senderId, waited);
	} catch (error) {
		if (signal?.aborted) throw error;
		return hubErrorResult(error instanceof Error ? error.message : String(error), {
			op: "wait",
			from: senderId,
			...parentErrorDetails(error),
		});
	}
}

export function executeInbox(
	registry: AgentRegistry,
	senderId: string,
	peek?: boolean,
	coordinationBackend?: CoordinationBackend,
): AgentToolResult<CoordinationDetails> {
	const busMessages = IrcBus.global().inbox(senderId, { peek });
	const session = registry.get(senderId)?.session;
	const pendingMessages = isAgentSession(session) ? session.drainPendingIrcInboxMessages(senderId) : [];
	const parentMessages = coordinationBackend?.inbox({ peek }) ?? [];
	const unique = new Map<string, IrcMessage>();
	for (const message of [...busMessages, ...pendingMessages, ...parentMessages]) unique.set(message.id, message);
	const messages = [...unique.values()].sort((a, b) => {
		const timeOrder = a.ts - b.ts;
		if (timeOrder !== 0) return timeOrder;
		const aSequence = a.inboxSequence ?? 0n;
		const bSequence = b.inboxSequence ?? 0n;
		return aSequence < bSequence ? -1 : aSequence > bSequence ? 1 : 0;
	});
	if (messages.length === 0) {
		return {
			content: [{ type: "text", text: "Inbox empty." }],
			details: { op: "inbox", from: senderId, inbox: [] },
			// An empty inbox drain carries no information once consumed.
			useless: true,
		};
	}
	const header = peek ? `${messages.length} unread message(s):` : `${messages.length} message(s):`;
	const lines = [header, ...messages.map(msg => `- ${formatIncoming(msg)}`)];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { op: "inbox", from: senderId, inbox: messages },
	};
}

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}
function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const total = body.split("\n").filter(line => line.trim()).length;
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = getPreviewLines(body, max, BODY_LINE_WIDTH, Ellipsis.Unicode).map(
		line => `${indent}${quote} ${theme.fg(tone, replaceTabs(line))}`,
	);
	const hidden = total - Math.min(total, max);
	if (hidden > 0) {
		lines.push(`${indent}${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
	}
	return lines;
}
/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Uses the same IRC glyph and quote-border conventions as the transcript.
 */
export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				lines.push(...bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 }));
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

import { randomUUID } from "node:crypto";
import path from "node:path";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { CoordinationBackend, CoordinationPeerError } from "../coordination/backend";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage } from "../irc/bus";
import { type AgentRef, type AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import { isAgentSession } from "../session/agent-session";
import { loadSessionMessagesReadOnly } from "../session/session-loader";
import type { IpythonHostHandler, IpythonHostHandlers } from "./controller";

export type AgentFamilyRelationship = "parent" | "sibling" | "child";
export type AgentFamilyStatus = "running" | "idle" | "inactive";

export interface AgentFamilyRosterEntry {
	relationship: AgentFamilyRelationship;
	name: string;
	id: string;
	depth: number;
	status: AgentFamilyStatus;
	source?: "parent";
}

export interface AgentFamilyRoster {
	current: { name: string; id: string; depth: number };
	entries: AgentFamilyRosterEntry[];
	errors?: CoordinationPeerError[];
}

export interface AgentMessageSendRequest {
	message: string;
	id: string;
	replyTo?: string;
	target?: "all";
	receiverRole?: AgentFamilyRelationship;
	receiverName?: string;
}

export interface AgentMessageInboxRequest {
	limit: number;
	consume: boolean;
	sender?: string;
	replyTo?: string;
}

export interface AgentMessageWaitRequest {
	timeoutMs: number;
	sender?: string;
	replyTo?: string;
}

export interface AgentObserveRecentRequest {
	target: string;
	limit: number;
	maxChars: number;
}

export interface AgentFamilyService {
	roster(signal?: AbortSignal): Promise<AgentFamilyRoster>;
	send(request: AgentMessageSendRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
	inbox(request: AgentMessageInboxRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
	wait(request: AgentMessageWaitRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
	observeList(signal?: AbortSignal): Promise<Record<string, unknown>>;
	observeGet(target: string, signal?: AbortSignal): Promise<Record<string, unknown>>;
	observeRecent(request: AgentObserveRecentRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

interface AgentFamilyNode {
	id: string;
	name: string;
	parentId?: string;
	status: AgentFamilyStatus;
	source: "local" | "parent";
	ref?: AgentRef;
}

interface AgentFamilySnapshot {
	current: AgentFamilyNode;
	currentDepth: number;
	nodes: Map<string, AgentFamilyNode>;
	entries: AgentFamilyRosterEntry[];
	errors: CoordinationPeerError[];
}

export interface AgentFamilyServiceOptions {
	registry: AgentRegistry;
	currentAgentId: () => string;
	currentSessionId: () => string;
	currentCwd: () => string;
	currentSessionFile: () => string | null;
	coordinationBackend?: CoordinationBackend;
	bus?: IrcBus;
}

const MAX_MESSAGE_CHARS = 16_384;
const MAX_MESSAGE_ID_CHARS = 256;
const DEFAULT_INBOX_LIMIT = 20;
const MAX_INBOX_LIMIT = 100;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_OBSERVE_LIMIT = 8;
const MAX_OBSERVE_LIMIT = 50;
const DEFAULT_OBSERVE_MAX_CHARS = 800;
const MIN_OBSERVE_MAX_CHARS = 80;
const MAX_OBSERVE_MAX_CHARS = 2_000;

function statusOf(ref: AgentRef): AgentFamilyStatus {
	if (ref.status === "running") return "running";
	if (ref.status === "idle") return "idle";
	return "inactive";
}

function relationshipOrder(value: AgentFamilyRelationship): number {
	if (value === "parent") return 0;
	if (value === "sibling") return 1;
	return 2;
}

function depthOf(id: string, nodes: ReadonlyMap<string, AgentFamilyNode>): number {
	let depth = 0;
	let current = nodes.get(id);
	const seen = new Set<string>();
	while (current?.parentId && !seen.has(current.parentId)) {
		seen.add(current.parentId);
		depth++;
		current = nodes.get(current.parentId);
	}
	return depth;
}

function relationship(current: AgentFamilyNode, target: AgentFamilyNode): AgentFamilyRelationship | undefined {
	if (target.id === current.parentId) return "parent";
	if (target.parentId === current.id) return "child";
	if (current.parentId !== undefined && target.parentId === current.parentId) return "sibling";
	return undefined;
}

function endpoint(node: AgentFamilyNode, fallbackSessionId?: string): Record<string, unknown> {
	const live = node.ref?.session;
	const sessionId = isAgentSession(live) ? live.sessionId : (fallbackSessionId ?? node.id);
	return {
		activeSessionId: node.id,
		sessionId,
		sessionName: node.name,
		runtimeKind: node.ref?.kind === "main" || node.id === MAIN_AGENT_ID ? "top-level" : "subagent",
	};
}

function projectMessage(message: IrcMessage, nodes: ReadonlyMap<string, AgentFamilyNode>): Record<string, unknown> {
	const from = nodes.get(message.from) ?? {
		id: message.from,
		name: message.from,
		status: "inactive" as const,
		source: "local" as const,
	};
	const target = nodes.get(message.to) ?? {
		id: message.to,
		name: message.to,
		status: "inactive" as const,
		source: "local" as const,
	};
	return {
		id: message.id,
		source: "agent_message",
		message: message.body,
		...(message.replyTo ? { replyTo: message.replyTo } : {}),
		from: endpoint(from),
		target: endpoint(target),
		acceptedAt: new Date(message.ts).toISOString(),
	};
}

function receiptFor(
	message: IrcMessage,
	target: AgentFamilyNode,
	current: AgentFamilyNode,
	receipt: IrcDeliveryReceipt,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const queued = receipt.outcome === "queued";
	const at = new Date().toISOString();
	return {
		id: message.id,
		source: "agent_message",
		target: endpoint(target),
		from: endpoint(current),
		message: message.body,
		deliveryStatus: queued ? "queued" : "delivered",
		...(queued ? { queuedAt: at } : { deliveredAt: at }),
		...(message.replyTo ? { replyTo: message.replyTo } : {}),
		outcome: receipt.outcome,
		...(receipt.queueOutcome ? { queueOutcome: receipt.queueOutcome } : {}),
		...extra,
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => {
			if (!block || typeof block !== "object") return "";
			const item = block as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") return item.text;
			if (item.type === "thinking" && typeof item.thinking === "string") return item.thinking;
			if (item.type === "image") return "[image]";
			if (item.type === "toolCall" && typeof item.name === "string") return `[tool_call:${item.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const value = message as Record<string, unknown>;
	if (value.role === "bashExecution") {
		return [value.command, value.output].filter(item => typeof item === "string").join("\n");
	}
	if (value.role === "branchSummary" || value.role === "compactionSummary") {
		return typeof value.summary === "string" ? value.summary : "";
	}
	return contentText(value.content);
}

function messagePreview(message: unknown, index: number, maxChars: number): Record<string, unknown> {
	const value = message && typeof message === "object" ? (message as Record<string, unknown>) : {};
	const raw = sanitizeText(messageText(message));
	const truncated = raw.length > maxChars;
	const text = truncated ? raw.slice(0, maxChars) : raw;
	const toolCalls = Array.isArray(value.content)
		? value.content.flatMap(block => {
				if (!block || typeof block !== "object") return [];
				const item = block as Record<string, unknown>;
				return item.type === "toolCall" && typeof item.name === "string" ? [item.name] : [];
			})
		: [];
	return {
		index,
		role: typeof value.role === "string" ? value.role : "unknown",
		...(typeof value.timestamp === "number" ? { timestamp: value.timestamp } : {}),
		text,
		truncated,
		...(toolCalls.length > 0 ? { toolCalls } : {}),
		...(value.role === "custom" && typeof value.customType === "string" ? { customType: value.customType } : {}),
	};
}

class NoMessageError extends Error {}

export class OmpAgentFamilyService implements AgentFamilyService {
	readonly #registry: AgentRegistry;
	readonly #currentAgentId: () => string;
	readonly #currentSessionId: () => string;
	readonly #currentCwd: () => string;
	readonly #currentSessionFile: () => string | null;
	readonly #coordinationBackend: CoordinationBackend | undefined;
	readonly #bus: IrcBus;

	constructor(options: AgentFamilyServiceOptions) {
		this.#registry = options.registry;
		this.#currentAgentId = options.currentAgentId;
		this.#currentSessionId = options.currentSessionId;
		this.#currentCwd = options.currentCwd;
		this.#currentSessionFile = options.currentSessionFile;
		this.#coordinationBackend = options.coordinationBackend;
		this.#bus = options.bus ?? IrcBus.global();
	}

	async #snapshot(signal?: AbortSignal): Promise<AgentFamilySnapshot> {
		await registerPersistedSubagents(this.#registry, this.#currentSessionFile());
		const currentId = this.#currentAgentId();
		const nodes = new Map<string, AgentFamilyNode>();
		for (const ref of this.#registry.list()) {
			if (ref.kind === "advisor") continue;
			nodes.set(ref.id, {
				id: ref.id,
				name: ref.displayName || ref.id,
				parentId: ref.parentId,
				status: statusOf(ref),
				source: "local",
				ref,
			});
		}
		const parentRoster = this.#coordinationBackend ? await this.#coordinationBackend.listPeers(signal) : undefined;
		const errors = [...(parentRoster?.errors ?? [])];
		for (const ref of parentRoster?.peers ?? []) {
			if (ref.kind === "advisor") continue;
			const existing = nodes.get(ref.id);
			if (existing) {
				if (!errors.some(error => error.code === "identity_conflict" && error.peerId === ref.id)) {
					errors.push({
						code: "identity_conflict",
						peerId: ref.id,
						detail: `Peer ID ${ref.id} is present in both the local registry and the parent Agent tree`,
					});
				}
				continue;
			}
			nodes.set(ref.id, {
				id: ref.id,
				name: ref.displayName || ref.id,
				parentId: ref.parentId,
				status: statusOf(ref),
				source: "parent",
				ref,
			});
		}
		const current =
			nodes.get(currentId) ??
			({ id: currentId, name: currentId, status: "running", source: "local" } satisfies AgentFamilyNode);
		nodes.set(current.id, current);
		const currentDepth = depthOf(current.id, nodes);
		const entries: AgentFamilyRosterEntry[] = [];
		for (const node of nodes.values()) {
			if (node.id === current.id) continue;
			const relation = relationship(current, node);
			if (!relation) continue;
			entries.push({
				relationship: relation,
				name: node.name,
				id: node.id,
				depth: depthOf(node.id, nodes),
				status: node.status,
				...(node.source === "parent" ? { source: "parent" as const } : {}),
			});
		}
		entries.sort(
			(left, right) =>
				relationshipOrder(left.relationship) - relationshipOrder(right.relationship) ||
				left.name.localeCompare(right.name) ||
				left.id.localeCompare(right.id),
		);
		return { current, currentDepth, nodes, entries, errors };
	}

	async roster(signal?: AbortSignal): Promise<AgentFamilyRoster> {
		const snapshot = await this.#snapshot(signal);
		return {
			current: { name: snapshot.current.name, id: snapshot.current.id, depth: snapshot.currentDepth },
			entries: snapshot.entries,
			...(snapshot.errors.length > 0 ? { errors: snapshot.errors } : {}),
		};
	}

	#assertUnambiguous(snapshot: AgentFamilySnapshot, node: AgentFamilyNode): void {
		const conflict = snapshot.errors.find(error => error.peerId === node.id);
		if (conflict) throw new Error(conflict.detail);
	}

	#resolveEntry(snapshot: AgentFamilySnapshot, relation: AgentFamilyRelationship, selector?: string): AgentFamilyNode {
		const matches = snapshot.entries.filter(
			entry =>
				entry.relationship === relation &&
				(relation === "parent" || entry.id === selector || entry.name === selector),
		);
		if (matches.length !== 1) {
			throw new Error(
				matches.length === 0
					? `No ${relation} matches ${relation === "parent" ? "the current agent" : JSON.stringify(selector)}`
					: `${relation} selector ${JSON.stringify(selector)} is ambiguous`,
			);
		}
		const node = snapshot.nodes.get(matches[0]!.id);
		if (!node) throw new Error(`Agent ${matches[0]!.id} disappeared from the family roster`);
		this.#assertUnambiguous(snapshot, node);
		return node;
	}

	async #sendOne(
		snapshot: AgentFamilySnapshot,
		target: AgentFamilyNode,
		message: string,
		id: string,
		replyTo: string | undefined,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const outbound: IrcMessage = {
			id,
			from: snapshot.current.id,
			to: target.id,
			body: message,
			ts: Date.now(),
			...(replyTo ? { replyTo } : {}),
			...(target.source === "parent" ? { source: "parent" as const } : {}),
		};
		if (target.source === "parent") {
			if (!this.#coordinationBackend) throw new Error("parent coordination backend is unavailable");
			const receipt = await this.#coordinationBackend.send({ targetPeerId: target.id, message: outbound }, signal);
			return receiptFor(
				outbound,
				target,
				snapshot.current,
				{ to: receipt.to, outcome: receipt.outcome, queueOutcome: receipt.queueOutcome },
				{ messageId: receipt.messageId, inboxSequence: receipt.inboxSequence.toString() },
			);
		}
		const receipt = await this.#bus.send(outbound);
		if (receipt.outcome === "failed") throw new Error(receipt.error ?? `Message delivery to ${target.id} failed`);
		return receiptFor(outbound, target, snapshot.current, receipt);
	}

	async send(request: AgentMessageSendRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		if (request.target === "all") {
			const receipts = await Promise.all(
				snapshot.entries.map(async entry => {
					const target = snapshot.nodes.get(entry.id)!;
					try {
						this.#assertUnambiguous(snapshot, target);
						return await this.#sendOne(
							snapshot,
							target,
							request.message,
							`${request.id}:${target.id}`,
							request.replyTo,
							signal,
						);
					} catch (error) {
						return { target: endpoint(target), error: error instanceof Error ? error.message : String(error) };
					}
				}),
			);
			return { receipts };
		}
		if (!request.receiverRole) throw new Error("Agent message receiver role is required");
		const target = this.#resolveEntry(snapshot, request.receiverRole, request.receiverName);
		return await this.#sendOne(snapshot, target, request.message, request.id, request.replyTo, signal);
	}

	#resolveSender(snapshot: AgentFamilySnapshot, selector?: string): string | undefined {
		if (!selector) return undefined;
		const matches = snapshot.entries.filter(entry => entry.id === selector || entry.name === selector);
		if (matches.length > 1) throw new Error(`Agent sender selector ${JSON.stringify(selector)} is ambiguous`);
		if (matches.length === 0) throw new Error(`No family agent matches sender ${JSON.stringify(selector)}`);
		return matches[0]!.id;
	}

	#peekLocal(
		currentId: string,
		from: string | undefined,
		fromAny: ReadonlySet<string> | undefined,
		replyTo: string | undefined,
	): Array<{ message: IrcMessage; source: string }> {
		const messages: Array<{ message: IrcMessage; source: string }> = this.#bus
			.inbox(currentId, { peek: true, from, fromAny, replyTo })
			.map(message => ({ message, source: "bus" }));
		const session = this.#registry.get(currentId)?.session;
		if (isAgentSession(session)) {
			for (const message of session.drainPendingIrcInboxMessages(currentId, {
				peek: true,
				from,
				fromAny,
				replyTo,
			})) {
				messages.push({ message, source: "session" });
			}
		}
		return messages;
	}

	async #takeInbox(
		snapshot: AgentFamilySnapshot,
		request: AgentMessageInboxRequest,
	): Promise<Record<string, unknown>[]> {
		const from = this.#resolveSender(snapshot, request.sender);
		const fromAny = from ? undefined : new Set(snapshot.entries.map(entry => entry.id));
		const tagged = this.#peekLocal(snapshot.current.id, from, fromAny, request.replyTo);
		for (const message of this.#coordinationBackend?.inbox({
			peek: true,
			from,
			fromAny,
			replyTo: request.replyTo,
		}) ?? []) {
			tagged.push({ message, source: "parent" });
		}
		const unique = new Map<string, { message: IrcMessage; sources: Set<string> }>();
		for (const item of tagged) {
			const existing = unique.get(item.message.id);
			if (existing) existing.sources.add(item.source);
			else unique.set(item.message.id, { message: item.message, sources: new Set([item.source]) });
		}
		const selected = [...unique.values()]
			.sort((left, right) => left.message.ts - right.message.ts)
			.slice(0, request.limit);
		if (request.consume && selected.length > 0) {
			const selectedIds = new Set(selected.map(item => item.message.id));
			this.#bus.inbox(snapshot.current.id, { ids: selectedIds });
			const session = this.#registry.get(snapshot.current.id)?.session;
			if (isAgentSession(session)) session.drainPendingIrcInboxMessages(snapshot.current.id, { ids: selectedIds });
			const worldCount = selected.filter(item => item.sources.has("parent")).length;
			if (worldCount > 0) {
				this.#coordinationBackend?.inbox({ from, fromAny, replyTo: request.replyTo, limit: worldCount });
			}
		}
		return selected.map(item => projectMessage(item.message, snapshot.nodes));
	}

	async inbox(request: AgentMessageInboxRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		return { messages: await this.#takeInbox(snapshot, request) };
	}

	async wait(request: AgentMessageWaitRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		const pending = await this.#takeInbox(snapshot, {
			limit: 1,
			consume: true,
			sender: request.sender,
			replyTo: request.replyTo,
		});
		if (pending[0]) return { message: pending[0] };
		const from = this.#resolveSender(snapshot, request.sender);
		const fromAny = from ? undefined : new Set(snapshot.entries.map(entry => entry.id));
		const waitAbort = new AbortController();
		const onAbort = () => waitAbort.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const waits: Array<Promise<IrcMessage>> = [
			this.#bus
				.wait(snapshot.current.id, { from, fromAny, replyTo: request.replyTo }, request.timeoutMs, waitAbort.signal)
				.then(message => {
					if (!message) throw new NoMessageError();
					return message;
				}),
		];
		if (this.#coordinationBackend) {
			waits.push(
				this.#coordinationBackend
					.waitMessage({ from, fromAny, replyTo: request.replyTo }, request.timeoutMs, waitAbort.signal)
					.then(message => {
						if (!message) throw new NoMessageError();
						return message;
					}),
			);
		}
		try {
			const message = await Promise.any(waits);
			return { message: projectMessage(message, snapshot.nodes) };
		} catch (error) {
			if (signal?.aborted)
				throw signal.reason instanceof Error ? signal.reason : new Error("Agent message wait aborted");
			if (error instanceof AggregateError) {
				const failure = error.errors.find(item => !(item instanceof NoMessageError));
				if (failure) throw failure;
			}
			return {};
		} finally {
			waitAbort.abort(new NoMessageError());
			signal?.removeEventListener("abort", onAbort);
			await Promise.allSettled(waits);
		}
	}

	#resolveObserved(snapshot: AgentFamilySnapshot, selector: string): AgentFamilyNode {
		const candidates = [snapshot.current, ...snapshot.entries.map(entry => snapshot.nodes.get(entry.id)!)];
		const exact = candidates.filter(node => node.id === selector || node.name === selector);
		if (exact.length === 1) return exact[0]!;
		if (exact.length > 1) throw new Error(`Agent selector ${JSON.stringify(selector)} is ambiguous`);
		const suffix = candidates.filter(node => node.id.endsWith(selector));
		if (suffix.length === 1) return suffix[0]!;
		throw new Error(
			suffix.length === 0
				? `No observable family agent matches ${JSON.stringify(selector)}`
				: `Agent selector ${JSON.stringify(selector)} is ambiguous`,
		);
	}

	async #messages(node: AgentFamilyNode): Promise<unknown[]> {
		const live = node.ref?.session;
		if (live?.readHistorySnapshot) {
			try {
				return (await live.readHistorySnapshot()).messages;
			} catch {}
		}
		if (live?.messages) return [...live.messages];
		if (node.ref?.sessionFile) {
			try {
				return await loadSessionMessagesReadOnly(node.ref.sessionFile);
			} catch {}
		}
		return [];
	}

	async #summary(node: AgentFamilyNode, isCurrent: boolean): Promise<Record<string, unknown>> {
		const live = node.ref?.session;
		const messages = live?.messages ?? [];
		const cwd = isAgentSession(live)
			? live.sessionManager.getCwd()
			: isCurrent
				? this.#currentCwd()
				: node.ref?.sessionFile
					? path.dirname(node.ref.sessionFile)
					: this.#currentCwd();
		return {
			activeSessionId: node.id,
			sessionId: isAgentSession(live) ? live.sessionId : isCurrent ? this.#currentSessionId() : node.id,
			sessionName: node.name,
			runtimeKind: isCurrent && node.id === MAIN_AGENT_ID ? "top-level" : "subagent",
			cwd,
			status: node.status,
			isCurrent,
			isStreaming: isAgentSession(live) ? live.isStreaming : node.status === "running",
			isCompacting: false,
			attachedClients: 0,
			messageCount: messages.length,
			queuedCount: this.#bus.unreadCount(node.id),
			isSessionActive: node.status !== "inactive",
			...(node.parentId ? { parentActiveSessionId: node.parentId } : {}),
			...(node.ref?.sessionFile ? { sessionPath: node.ref.sessionFile } : {}),
			...(node.ref?.activity ? { activity: node.ref.activity } : {}),
			lastActivity: node.ref?.lastActivity ?? 0,
		};
	}

	async observeList(signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		return {
			current: await this.#summary(snapshot.current, true),
			agents: await Promise.all(snapshot.entries.map(entry => this.#summary(snapshot.nodes.get(entry.id)!, false))),
			...(snapshot.errors.length > 0 ? { errors: snapshot.errors } : {}),
		};
	}

	async observeGet(target: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		const node = this.#resolveObserved(snapshot, target);
		this.#assertUnambiguous(snapshot, node);
		return { agent: await this.#summary(node, node.id === snapshot.current.id) };
	}

	async observeRecent(request: AgentObserveRecentRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
		const snapshot = await this.#snapshot(signal);
		const node = this.#resolveObserved(snapshot, request.target);
		this.#assertUnambiguous(snapshot, node);
		const messages = await this.#messages(node);
		const start = Math.max(0, messages.length - request.limit);
		return {
			agent: await this.#summary(node, node.id === snapshot.current.id),
			messages: messages
				.slice(start)
				.map((message, offset) => messagePreview(message, start + offset, request.maxChars)),
			limit: request.limit,
			maxChars: request.maxChars,
			truncated: start > 0,
		};
	}
}

function assertRecord(payload: Record<string, unknown>, allowed: ReadonlySet<string>, operation: string): void {
	const unknown = Object.keys(payload).filter(key => key !== "type" && !allowed.has(key));
	if (unknown.length > 0) throw new Error(`${operation} received unknown field(s): ${unknown.sort().join(", ")}`);
}

function optionalString(value: unknown, label: string, maxChars = MAX_MESSAGE_ID_CHARS): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a nonempty string`);
	const text = value.trim();
	if (text.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters`);
	return text;
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
	const resolved = value ?? fallback;
	if (typeof resolved !== "number" || !Number.isInteger(resolved) || resolved < min || resolved > max) {
		throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
	}
	return resolved;
}

function requireService(service: AgentFamilyService | undefined): AgentFamilyService {
	if (!service) throw new Error("Agent family services are unavailable in this session");
	return service;
}

export function createAgentFamilyIpythonHostHandlers(service?: AgentFamilyService): IpythonHostHandlers {
	const handlers: Record<string, IpythonHostHandler> = {};
	const add = (name: string, handler: IpythonHostHandler): void => {
		handlers[name] = handler;
	};
	add("agent_message.list_agents", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(), "agent_message.list_agents");
		return (await requireService(service).roster(request.signal)) as unknown as Record<string, unknown>;
	});
	add("agent_message.send", async request => {
		const payload = request.data;
		assertRecord(
			payload,
			new Set(["target", "message", "receiver_role", "receiver_name", "id", "reply_to"]),
			"agent_message.send",
		);
		if (typeof payload.message !== "string") throw new TypeError("agent_message.send message must be a string");
		const message = payload.message;
		if (!message.trim()) throw new Error("agent_message.send message must not be empty");
		if (message.length > MAX_MESSAGE_CHARS) {
			throw new Error(`agent_message.send message exceeds ${MAX_MESSAGE_CHARS} characters`);
		}
		const id = optionalString(payload.id, "agent_message.send id") ?? `agentmsg_${randomUUID()}`;
		const replyTo = optionalString(payload.reply_to, "agent_message.send reply_to");
		if (payload.target === "all") {
			if (payload.receiver_role !== undefined || payload.receiver_name !== undefined) {
				throw new Error("agent_message.send broadcast cannot include receiver_role or receiver_name");
			}
			return await requireService(service).send({ target: "all", message, id, replyTo }, request.signal);
		}
		if (payload.target !== undefined) {
			throw new Error("agent_message.send positional targets are unsupported; use receiver_role and receiver_name");
		}
		const role = payload.receiver_role;
		if (role !== "parent" && role !== "sibling" && role !== "child") {
			throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child"');
		}
		const receiverName = optionalString(payload.receiver_name, "agent_message.send receiver_name", 64);
		if (role === "parent" && receiverName !== undefined) {
			throw new Error("agent_message.send receiver_name must be omitted for parent messages");
		}
		if (role !== "parent" && receiverName === undefined) {
			throw new Error("agent_message.send receiver_name is required for sibling and child messages");
		}
		return await requireService(service).send(
			{ message, id, replyTo, receiverRole: role, receiverName },
			request.signal,
		);
	});
	add("agent_message.inbox", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(["limit", "consume", "sender", "reply_to"]), "agent_message.inbox");
		if (payload.consume !== undefined && typeof payload.consume !== "boolean") {
			throw new TypeError("agent_message.inbox consume must be boolean");
		}
		return await requireService(service).inbox(
			{
				limit: integer(payload.limit, DEFAULT_INBOX_LIMIT, 1, MAX_INBOX_LIMIT, "agent_message.inbox limit"),
				consume: payload.consume === true,
				sender: optionalString(payload.sender, "agent_message.inbox sender", 64),
				replyTo: optionalString(payload.reply_to, "agent_message.inbox reply_to"),
			},
			request.signal,
		);
	});
	add("agent_message.wait", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(["timeout_ms", "sender", "reply_to"]), "agent_message.wait");
		return await requireService(service).wait(
			{
				timeoutMs: integer(
					payload.timeout_ms,
					DEFAULT_WAIT_TIMEOUT_MS,
					1,
					MAX_WAIT_TIMEOUT_MS,
					"agent_message.wait timeout_ms",
				),
				sender: optionalString(payload.sender, "agent_message.wait sender", 64),
				replyTo: optionalString(payload.reply_to, "agent_message.wait reply_to"),
			},
			request.signal,
		);
	});
	add("agent_observe.list", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(), "agent_observe.list");
		return await requireService(service).observeList(request.signal);
	});
	add("agent_observe.get", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(["target"]), "agent_observe.get");
		const target = optionalString(payload.target, "agent_observe.get target", 128);
		if (!target) throw new Error("agent_observe.get target is required");
		return await requireService(service).observeGet(target, request.signal);
	});
	add("agent_observe.recent", async request => {
		const payload = request.data;
		assertRecord(payload, new Set(["target", "limit", "max_chars", "maxChars"]), "agent_observe.recent");
		const target = optionalString(payload.target, "agent_observe.recent target", 128);
		if (!target) throw new Error("agent_observe.recent target is required");
		return await requireService(service).observeRecent(
			{
				target,
				limit: integer(payload.limit, DEFAULT_OBSERVE_LIMIT, 1, MAX_OBSERVE_LIMIT, "agent_observe.recent limit"),
				maxChars: integer(
					payload.max_chars ?? payload.maxChars,
					DEFAULT_OBSERVE_MAX_CHARS,
					MIN_OBSERVE_MAX_CHARS,
					MAX_OBSERVE_MAX_CHARS,
					"agent_observe.recent max_chars",
				),
			},
			request.signal,
		);
	});
	return handlers;
}

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import http2 from "node:http2";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { ConversationStep, McpToolDefinition } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import {
	AgentClientMessageSchema,
	AgentConversationTurnStructureSchema,
	AgentRunRequestSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	AssistantMessageSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	type ConversationStateStructure,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	ConversationTurnStructureSchema,
	GetBlobResultSchema,
	KvClientMessageSchema,
	type KvServerMessage,
	McpArgsSchema,
	McpImageContentSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolCallSchema,
	McpToolDefinitionSchema,
	McpToolErrorSchema,
	McpToolResultContentItemSchema,
	McpToolResultSchema,
	ModelDetailsSchema,
	RequestedModelSchema,
	ResumeActionSchema,
	SelectedContextSchema,
	SelectedImageSchema,
	SetBlobResultSchema,
	ThinkingMessageSchema,
	ToolCallSchema,
	UserMessageActionSchema,
	UserMessageSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";
import { isKimiK3ModelId } from "@oh-my-pi/pi-catalog/identity";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { $env, logger, parseJsonWithRepair, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingBlockKind,
	kStreamingEnvelopeId,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { connectProxiedSocket, getProxyForProvider, shouldBypassProxy } from "../utils/proxy";
import { createRequestDebugSession, isRequestDebugEnabled, type RequestDebugResponseLog } from "../utils/request-debug";
import { toolWireSchema } from "../utils/schema/wire";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";

const CURSOR_PROXY_TUNNEL_TIMEOUT_MS = 30_000;

/**
 * Text for a recognised frame this client answers with its own typed error
 * variant. Phrased as a client capability statement, not a tool failure: the
 * model reads it and should route around the capability, not retry the call.
 */
const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();
const warnedCursorKimiK3ReplayMessages = new Set<string>();

export interface CursorOptions extends StreamOptions {
	customSystemPrompt?: string;
	conversationId?: string;
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

interface CursorLogEntry {
	ts: number;
	type: string;
	subtype?: string;
	data?: unknown;
}

async function appendCursorDebugLog(entry: CursorLogEntry): Promise<void> {
	const logPath = $env.DEBUG_CURSOR_LOG;
	if (!logPath) return;
	try {
		await fs.appendFile(logPath, `${JSON.stringify(entry, debugReplacer)}\n`);
	} catch {
		// Ignore debug log failures
	}
}

function log(type: string, subtype?: string, data?: unknown): void {
	if (!$env.DEBUG_CURSOR) return;
	const normalizedData = data ? decodeLogData(data) : data;
	const entry: CursorLogEntry = { ts: Date.now(), type, subtype, data: normalizedData };
	const verbose = $env.DEBUG_CURSOR === "2" || $env.DEBUG_CURSOR === "verbose";
	const dataStr = verbose && normalizedData ? ` ${JSON.stringify(normalizedData, debugReplacer)?.slice(0, 500)}` : "";
	console.error(`[CURSOR] ${type}${subtype ? `: ${subtype}` : ""}${dataStr}`);
	void appendCursorDebugLog(entry);
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		const error = payload?.error;
		if (error) {
			const code = typeof error.code === "string" ? error.code : "unknown";
			const message = typeof error.message === "string" ? error.message : "Unknown error";
			return new AIError.ProviderResponseError(`Connect error ${code}: ${message}`, { kind: "envelope" });
		}
		return null;
	} catch {
		return new AIError.ProviderResponseError("Failed to parse Connect end stream", { kind: "envelope" });
	}
}

/**
 * Maps an opaque HTTP/2 negotiation failure into an actionable error.
 *
 * bun only opens an HTTP/2 session when TLS-ALPN negotiates `h2`. Behind a
 * TLS-intercepting proxy that strips ALPN (e.g. Zscaler), the handshake yields
 * no `h2` protocol and bun throws `ERR_HTTP2_ERROR: h2 is not supported`. The
 * Cursor run RPC is HTTP/2-only (the ALB rejects HTTP/1.1 with 464), so there
 * is no h1 fallback the way model discovery has one — the run simply cannot
 * proceed. Replace the opaque message with one that names the cause and points
 * at the `providers.cursor.baseUrl` workaround.
 *
 * Non-ALPN errors pass through untouched.
 */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
	const code = (error as { code?: unknown } | null)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
		return new AIError.ProviderResponseError(
			`Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
				"This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
				"h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy (e.g. Zscaler). " +
				"Front the provider with a local HTTP/2 bridge and set providers.cursor.baseUrl to it.",
			{ provider: "cursor", kind: "runtime", cause: error },
		);
	}
	return error;
}

function debugBytes(bytes: Uint8Array, asHex: boolean): string {
	if (asHex) {
		return Buffer.from(bytes).toString("hex");
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/^[\x20-\x7E\s]*$/.test(text)) return text;
	} catch {}
	return Buffer.from(bytes).toString("hex");
}

function debugReplacer(key: string, value: unknown): unknown {
	if (
		value instanceof Uint8Array ||
		(value && typeof value === "object" && "type" in value && value.type === "Buffer")
	) {
		const bytes = value instanceof Uint8Array ? value : new Uint8Array((value as any).data);
		const asHex = key === "blobId" || key === "blob_id" || key.endsWith("Id") || key.endsWith("_id");
		return debugBytes(bytes, asHex);
	}
	if (typeof value === "bigint") return value.toString();
	return value;
}

function extractLogBytes(value: unknown): Uint8Array | null {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (value && typeof value === "object" && "type" in value && value.type === "Buffer") {
		const data = (value as { data?: number[] }).data;
		if (Array.isArray(data)) {
			return new Uint8Array(data);
		}
	}
	return null;
}

function decodeMcpArgsForLog(args?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	let mutated = false;
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		const bytes = extractLogBytes(value);
		if (bytes) {
			decoded[key] = decodeMcpArgValue(bytes);
			mutated = true;
			continue;
		}
		const normalizedValue = decodeLogData(value);
		decoded[key] = normalizedValue;
		if (normalizedValue !== value) {
			mutated = true;
		}
	}
	return mutated ? decoded : args;
}

function decodeLogData(value: unknown): unknown {
	if (!value || typeof value !== "object") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(entry => decodeLogData(entry));
	}
	const record = value as Record<string, unknown>;
	const typeName = record.$typeName;
	const stripTypeName = typeof typeName === "string" && typeName.startsWith("agent.v1.");

	if (typeName === "agent.v1.McpArgs") {
		const decodedArgs = decodeMcpArgsForLog(record.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		return decodedArgs ? { ...base, args: decodedArgs } : base;
	}
	if (typeName === "agent.v1.McpToolCall") {
		const argsRecord = record.args as Record<string, unknown> | undefined;
		const decodedArgs = decodeMcpArgsForLog(argsRecord?.args as Record<string, unknown> | undefined);
		const base = stripTypeName ? omitTypeName(record) : record;
		if (decodedArgs && argsRecord) {
			return { ...base, args: { ...argsRecord, args: decodedArgs } };
		}
		return base;
	}

	let mutated = stripTypeName;
	const decoded: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(record)) {
		if (stripTypeName && key === "$typeName") {
			continue;
		}
		const normalizedEntry = decodeLogData(entry);
		decoded[key] = normalizedEntry;
		if (normalizedEntry !== entry) {
			mutated = true;
		}
	}
	return mutated ? decoded : record;
}

function omitTypeName(record: Record<string, unknown>): Record<string, unknown> {
	const { $typeName: _, ...rest } = record;
	return rest;
}

export const streamCursor: StreamFunction<"cursor-agent"> = (
	model: Model<"cursor-agent">,
	context: Context,
	options?: CursorOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "cursor-agent" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		// Declared outside the `try` because BOTH exits must drain it: an exec
		// handler decoded from the last chunk can still be running when the
		// transport fails, and the error path finalizes the synthesized call just
		// like the success path does.
		const inFlightDispatches = new Set<Promise<void>>();
		// A dispatch can spawn another (a handler that decodes a nested frame), so
		// re-check rather than awaiting one snapshot. Each dispatch already
		// swallows its own rejection, so this only waits.
		//
		// The wait is bounded by the abort signal: exec handlers have no
		// cancellation contract (the coding-agent bridge invokes `tool.execute`
		// with no signal), so a hung or long-running tool would otherwise hold
		// the terminal event hostage after the user already gave up on the turn.
		// Once aborted, the Agent finalizes from the abort error and discards
		// late results regardless, so skipping the rest of the drain loses
		// nothing that could still be delivered.
		let abortSettled: Promise<void> | undefined;
		const drainInFlightDispatches = async (): Promise<void> => {
			const signal = options?.signal;
			while (inFlightDispatches.size > 0) {
				if (signal?.aborted) return;
				const settled = Promise.all([...inFlightDispatches]);
				if (!signal) {
					await settled;
					continue;
				}
				abortSettled ??= new Promise<void>(resolve =>
					signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				await Promise.race([settled, abortSettled]);
			}
		};

		let h2Client: http2.ClientHttp2Session | null = null;
		let h2Request: http2.ClientHttp2Stream | null = null;
		let heartbeatTimer: NodeJS.Timeout | null = null;
		let debugResponseLogPromise: Promise<RequestDebugResponseLog | undefined> | undefined;
		const h2Completion = Promise.withResolvers<void>();
		let h2Settled = false;
		let sawTurnEnded = false;
		let endStreamError: Error | null = null;
		// Reachable from the catch: a stream that dies mid-turn must still close
		// and pair the blocks it left open, and `state` itself is scoped to the
		// try below.
		let openBlockState: BlockState | undefined;
		const settleH2 = (error?: unknown): void => {
			if (h2Settled) return;
			h2Settled = true;
			if (error !== undefined) {
				h2Completion.reject(error);
				return;
			}
			if (endStreamError) {
				h2Completion.reject(endStreamError);
				return;
			}
			if (!sawTurnEnded) {
				h2Completion.reject(
					new AIError.ProviderResponseError("Cursor stream ended before turnEnded", {
						kind: "incomplete-stream",
					}),
				);
				return;
			}
			h2Completion.resolve();
		};

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(undefined, "Cursor API key (access token) is required");
			}

			const conversationId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
			const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
			conversationBlobStores.set(conversationId, blobStore);
			const cachedState = conversationStateCache.get(conversationId);
			const { requestBytes, conversationState } = await buildGrpcRequest(model, context, options, {
				conversationId,
				blobStore,
				conversationState: cachedState,
			});
			conversationStateCache.set(conversationId, conversationState);
			const requestContextTools = buildMcpToolDefinitions(context.tools);

			const baseUrl = model.baseUrl || CURSOR_API_URL;
			const requestPath = "/agent.v1.AgentService/Run";
			const requestHeaders = {
				":method": "POST",
				":path": requestPath,
				"content-type": "application/connect+proto",
				"connect-protocol-version": "1",
				te: "trailers",
				authorization: `Bearer ${apiKey}`,
				"x-ghost-mode": "true",
				"x-cursor-client-version": CURSOR_CLIENT_VERSION,
				"x-cursor-client-type": "cli",
				"x-request-id": crypto.randomUUID(),
			};
			const debugSession = isRequestDebugEnabled()
				? await createRequestDebugSession({
						protocol: "http2",
						method: "POST",
						url: new URL(requestPath, baseUrl).toString(),
						headers: requestHeaders,
						bodyBase64: Buffer.from(requestBytes).toString("base64"),
					})
				: undefined;

			const proxyUrl = shouldBypassProxy(new URL(baseUrl)) ? undefined : getProxyForProvider(model.provider);
			if (proxyUrl) {
				const tlsSocket = await connectProxiedSocket(proxyUrl, baseUrl, {
					signal: options?.signal,
					timeoutMs: CURSOR_PROXY_TUNNEL_TIMEOUT_MS,
				});
				h2Client = http2.connect(baseUrl, {
					createConnection: () => tlsSocket,
				});
			} else {
				h2Client = http2.connect(baseUrl);
			}
			h2Client.on("error", error => settleH2(mapH2TransportError(error, baseUrl)));

			h2Request = h2Client.request(requestHeaders);

			stream.push({ type: "start", partial: output });

			let pendingBuffer: Buffer = Buffer.alloc(0);
			let currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null = null;
			let currentToolCall: ToolCallState | null = null;
			const usageState: UsageState = { sawTokenDelta: false };

			const state: BlockState = {
				get currentTextBlock() {
					return currentTextBlock;
				},
				get currentThinkingBlock() {
					return currentThinkingBlock;
				},
				get currentToolCall() {
					return currentToolCall;
				},
				openToolCalls: new Map<string, ToolCallState>(),
				get firstTokenTime() {
					return firstTokenTime;
				},
				setTextBlock: b => {
					currentTextBlock = b;
				},
				setThinkingBlock: b => {
					currentThinkingBlock = b;
				},
				setToolCall: t => {
					currentToolCall = t;
				},
				setFirstTokenTime: () => {
					if (!firstTokenTime) firstTokenTime = performance.now();
				},
			};
			openBlockState = state;

			const onConversationCheckpoint = (checkpoint: ConversationStateStructure) => {
				conversationStateCache.set(conversationId, checkpoint);
			};

			h2Request.on("response", headers => {
				debugResponseLogPromise = debugSession?.openResponseLog(
					`HTTP/2 ${headers[":status"] ?? ""}`.trim(),
					headers,
				);
			});

			h2Request.on("data", (chunk: Buffer) => {
				if (debugResponseLogPromise) {
					void debugResponseLogPromise.then(log => {
						log?.write(chunk);
					});
				}
				// Steady state drains fully per chunk; alias the fresh h2 chunk instead
				// of copying it through Buffer.concat (see aws-eventstream.ts).
				pendingBuffer = pendingBuffer.length === 0 ? chunk : Buffer.concat([pendingBuffer, chunk]);

				while (pendingBuffer.length >= 5) {
					const flags = pendingBuffer[0];
					const msgLen = pendingBuffer.readUInt32BE(1);
					if (pendingBuffer.length < 5 + msgLen) break;

					const messageBytes = pendingBuffer.subarray(5, 5 + msgLen);
					pendingBuffer = pendingBuffer.subarray(5 + msgLen);

					if (flags & CONNECT_END_STREAM_FLAG) {
						const endError = parseConnectEndStream(messageBytes);
						if (endError) {
							endStreamError = endError;
							h2Request?.close();
						}
						continue;
					}

					try {
						const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
						const isTurnEnded =
							serverMessage.message.case === "interactionUpdate" &&
							serverMessage.message.value.message?.case === "turnEnded";
						// Dispatch is fire-and-forget so the socket keeps draining while a
						// handler runs, but the promise is tracked: `done` must not be
						// pushed while an exec handler is still resolving, or the Agent
						// drains its Cursor result buffer before the handler reserved its
						// entry and the call is left unpaired. Awaited after
						// `h2Completion` below.
						const dispatch = handleServerMessage(
							serverMessage,
							output,
							stream,
							state,
							blobStore,
							h2Request!,
							usageState,
							requestContextTools,
							onConversationCheckpoint,
						).catch(error => {
							log("error", "handleServerMessage", { error: String(error) });
						});
						inFlightDispatches.add(dispatch);
						void dispatch.finally(() => inFlightDispatches.delete(dispatch));

						// Application completion is not protocol success; wait for a clean HTTP/2 end.
						if (isTurnEnded) {
							sawTurnEnded = true;
						}
					} catch (e) {
						log("error", "parseServerMessage", { error: String(e) });
					}
				}
			});

			const sendHeartbeat = () => {
				if (!h2Request || h2Request.closed) {
					return;
				}
				const heartbeatMessage = create(AgentClientMessageSchema, {
					message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
				});
				const heartbeatBytes = toBinary(AgentClientMessageSchema, heartbeatMessage);
				h2Request.write(frameConnectMessage(heartbeatBytes));
			};

			const closeDebugLog = async (): Promise<void> => {
				const log = await debugResponseLogPromise;
				await log?.close();
			};

			h2Request.on("trailers", trailers => {
				const status = trailers["grpc-status"];
				const msg = trailers["grpc-message"];
				if (status && status !== "0" && !endStreamError) {
					endStreamError = new AIError.ProviderResponseError(
						`gRPC error ${status}: ${decodeURIComponent(String(msg || ""))}`,
						{ kind: "envelope" },
					);
				}
			});

			h2Request.on("end", () => {
				void closeDebugLog()
					.then(() => settleH2())
					.catch(error => settleH2(error));
			});

			h2Request.on("error", error => {
				const mapped = mapH2TransportError(error, baseUrl);
				void closeDebugLog().finally(() => settleH2(mapped));
			});

			if (options?.signal) {
				options.signal.addEventListener("abort", () => {
					h2Request?.close();
					void closeDebugLog().finally(() => {
						settleH2(new AIError.AbortError());
					});
				});
			}

			h2Request.write(frameConnectMessage(requestBytes));
			heartbeatTimer = setInterval(sendHeartbeat, 5000);
			await h2Completion.promise;
			// The transport is done, but a handler decoded from the last chunk may
			// still be running: exec handlers and `onToolResult` transformers are
			// async. Pushing `done` now would let the Agent drain its Cursor result
			// buffer before such a handler reserves its entry, leaving the call
			// unpaired and stripped from every rebuilt transcript. Each dispatch
			// already swallows its own rejection, so this only waits.
			await drainInFlightDispatches();

			endCurrentTextBlock(output, stream, state);
			endCurrentThinkingBlock(output, stream, state);
			flushOpenToolCalls(output, stream, state);

			calculateCost(model, output.usage);

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({
				type: "done",
				reason: output.stopReason as "stop" | "length" | "toolUse",
				message: output,
			});
			stream.end();
		} catch (error) {
			// Same reason as the success path: the Agent finalizes the synthesized
			// call from this terminal error and clears its Cursor result buffer, so
			// a handler still running would land its real result after `agent_end`
			// and be discarded — even though the tool may already have run side
			// effects. Wait for it first; on abort the drain returns immediately
			// (handlers have no cancellation contract and must not delay the
			// terminal error the user asked for).
			await drainInFlightDispatches();
			// A stream that dies mid-turn leaves blocks open, and this is the path
			// it takes: `settleH2` rejects when the transport closes without
			// `turnEnded`, so the success-path flush above never runs. Closing
			// them here settles their live cards and pairs the server-owned calls
			// (`connect_scm`, native todo) that nothing else answers — an
			// unpaired call is stripped from every rebuilt transcript.
			// Undefined only when the failure predates the state's construction,
			// in which case no block was ever opened.
			if (openBlockState) {
				endCurrentTextBlock(output, stream, openBlockState);
				endCurrentThinkingBlock(output, stream, openBlockState);
				flushOpenToolCalls(output, stream, openBlockState);
			}
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			const log = await debugResponseLogPromise;
			await log?.close();
			if (heartbeatTimer) {
				clearInterval(heartbeatTimer);
				heartbeatTimer = null;
			}
			h2Request?.close();
			h2Client?.close();
		}
	})();

	return stream;
};

export type ToolCallState = ToolCall & {
	[kStreamingBlockIndex]: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
	[kStreamingBlockKind]: "mcp" | "connect-scm";
	[kStreamingEnvelopeId]?: string;
};

export interface BlockState {
	currentTextBlock: (TextContent & { [kStreamingBlockIndex]: number }) | null;
	currentThinkingBlock: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null;
	currentToolCall: ToolCallState | null;
	/**
	 * Open streamed tool-call blocks, keyed by the interaction envelope's
	 * `call_id`.
	 *
	 * Cursor interleaves calls: two `toolCallStarted` frames can arrive before
	 * either completes. A single "current" slot would let the second overwrite
	 * the first, orphaning a block that nothing then settles. Every keyed block
	 * stays reachable until its own completion, and `currentToolCall` remains
	 * only as the fallback for frames that carry no `call_id`.
	 */
	openToolCalls: Map<string, ToolCallState>;
	firstTokenTime: number | undefined;
	setTextBlock: (b: (TextContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setThinkingBlock: (b: (ThinkingContent & { [kStreamingBlockIndex]: number }) | null) => void;
	setToolCall: (t: ToolCallState | null) => void;
	setFirstTokenTime: () => void;
}

export interface UsageState {
	sawTokenDelta: boolean;
}

/** Exported for tests: drives one Cursor server message through the stream (exec waits mark the stream busy). */
export async function handleServerMessage(
	msg: AgentServerMessage,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
	usageState: UsageState,
	_requestContextTools: McpToolDefinition[],
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): Promise<void> {
	const msgCase = msg.message.case;

	log("serverMessage", msgCase, msg.message.value);

	if (msgCase === "interactionUpdate") {
		processInteractionUpdate(msg.message.value, output, stream, state, usageState);
	} else if (msgCase === "kvServerMessage") {
		handleKvServerMessage(msg.message.value as KvServerMessage, blobStore, h2Request);
	} else if (msgCase === "conversationCheckpointUpdate") {
		handleConversationCheckpointUpdate(msg.message.value, output, usageState, onConversationCheckpoint);
	}
}

function handleKvServerMessage(
	kvMsg: KvServerMessage,
	blobStore: Map<string, Uint8Array>,
	h2Request: http2.ClientHttp2Stream,
): void {
	const kvCase = kvMsg.message.case;

	if (kvCase === "getBlobArgs") {
		const blobId = kvMsg.message.value.blobId;
		const blobIdKey = Buffer.from(blobId).toString("hex");

		const blobData = blobStore.get(blobIdKey);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "getBlobResult",
				value: create(GetBlobResultSchema, blobData ? { blobData } : {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "getBlobResult", { blobId: blobIdKey.slice(0, 40) });
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		const blobIdKey = Buffer.from(blobId).toString("hex");
		blobStore.set(blobIdKey, blobData);

		const response = create(KvClientMessageSchema, {
			id: kvMsg.id,
			message: {
				case: "setBlobResult",
				value: create(SetBlobResultSchema, {}),
			},
		});

		const kvClientMessage = create(AgentClientMessageSchema, {
			message: { case: "kvClientMessage", value: response },
		});

		const responseBytes = toBinary(AgentClientMessageSchema, kvClientMessage);
		h2Request.write(frameConnectMessage(responseBytes));

		log("kvClient", "setBlobResult", { blobId: blobIdKey.slice(0, 40) });
	}
}

function retainStreamedCall(state: BlockState, block: ToolCallState, envelopeId: string | undefined): void {
	if (envelopeId) state.openToolCalls.set(envelopeId, block);
	state.setToolCall(block);
}

function endCurrentTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream, state: BlockState): void {
	const block = state.currentTextBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: block.text,
		partial: output,
	});
	state.setTextBlock(null);
}

function endCurrentThinkingBlock(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const block = state.currentThinkingBlock;
	if (!block) return;
	const idx = output.content.indexOf(block);
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: block.thinking,
		partial: output,
	});
	state.setThinkingBlock(null);
}

export function mergeCursorMcpToolCallArgs(
	streamed: Record<string, unknown> | undefined,
	completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...(streamed ?? {}) };
	if (!completion) return merged;
	for (const [key, completionValue] of Object.entries(completion)) {
		const streamedValue = merged[key];
		if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") {
			continue;
		}
		merged[key] = completionValue;
	}
	return merged;
}

function selectMcpCall(
	toolCall: { tool?: { case?: string; value?: unknown }; mcpToolCall?: unknown } | undefined,
): any {
	const oneof = toolCall?.tool;
	if (oneof?.case === "mcpToolCall") return oneof.value;
	return toolCall?.mcpToolCall;
}

export function flushOpenToolCalls(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
): void {
	const blocks = new Set<ToolCallState>(state.openToolCalls.values());
	if (state.currentToolCall) blocks.add(state.currentToolCall);
	for (const block of blocks) {
		const idx = output.content.indexOf(block);
		if (block[kStreamingPartialJson] !== undefined) {
			block.arguments = parseStreamingJson(block[kStreamingPartialJson]!);
			clearStreamingPartialJson(block);
		}
		stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
	}
	state.openToolCalls.clear();
	state.setToolCall(null);
}

function toolResultToText(result: ToolResultMessage): string {
	return result.content.map(item => (item.type === "text" ? item.text : "[image]")).join("\n");
}

function parseToolArgsJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) {
		return text;
	}
	try {
		return parseJsonWithRepair<unknown>(trimmed);
	} catch {
		return text;
	}
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try {
		const parsedValue = fromBinary(ValueSchema, value);
		const jsonValue = toJson(ValueSchema, parsedValue) as JsonValue;
		if (typeof jsonValue === "string") {
			return parseToolArgsJson(jsonValue);
		}
		return jsonValue;
	} catch {}
	const text = new TextDecoder().decode(value);
	return parseToolArgsJson(text);
}

function decodeMcpArgsMap(args?: Record<string, Uint8Array>): Record<string, unknown> | undefined {
	if (!args) {
		return undefined;
	}
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		decoded[key] = decodeMcpArgValue(value);
	}
	return decoded;
}

function resolveStreamedCall(state: BlockState, envelopeId: string | undefined): ToolCallState | null {
	if (!envelopeId) return state.currentToolCall;
	const keyed = state.openToolCalls.get(envelopeId);
	if (keyed) return keyed;
	// Blocks opened before this build tracked envelope ids, and blocks opened
	// from a frame that carried none, are only reachable as `currentToolCall`.
	const current = state.currentToolCall;
	return current && current[kStreamingEnvelopeId] === undefined ? current : null;
}

/** Release a settled block from both the keyed map and the current slot. */
function releaseStreamedCall(state: BlockState, block: ToolCallState): void {
	const envelopeId = block[kStreamingEnvelopeId];
	if (envelopeId) state.openToolCalls.delete(envelopeId);
	if (state.currentToolCall === block) state.setToolCall(null);
}

export function processInteractionUpdate(
	update: any,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	state: BlockState,
	usageState: UsageState,
): void {
	const updateCase = update.message?.case;

	log("interactionUpdate", updateCase, update.message?.value);

	if (updateCase === "textDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentTextBlock) {
			const block: TextContent & { [kStreamingBlockIndex]: number } = {
				type: "text",
				text: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setTextBlock(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentTextBlock!.text += delta;
		const idx = output.content.indexOf(state.currentTextBlock!);
		stream.push({ type: "text_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingDelta") {
		state.setFirstTokenTime();
		const delta = update.message.value.text || "";
		if (!state.currentThinkingBlock) {
			const block: ThinkingContent & { [kStreamingBlockIndex]: number } = {
				type: "thinking",
				thinking: "",
				[kStreamingBlockIndex]: output.content.length,
			};
			output.content.push(block);
			state.setThinkingBlock(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		}
		state.currentThinkingBlock!.thinking += delta;
		const idx = output.content.indexOf(state.currentThinkingBlock!);
		stream.push({ type: "thinking_delta", contentIndex: idx, delta, partial: output });
	} else if (updateCase === "thinkingCompleted") {
		endCurrentThinkingBlock(output, stream, state);
	} else if (updateCase === "toolCallStarted") {
		endCurrentTextBlock(output, stream, state);
		endCurrentThinkingBlock(output, stream, state);
		const toolCall = update.message.value.toolCall;
		if (toolCall) {
			const mcpCall = selectMcpCall(toolCall);
			if (mcpCall) {
				const args = mcpCall.args || {};
				const id = args.toolCallId || crypto.randomUUID();
				const block: ToolCallState = {
					type: "toolCall",
					id,
					// Same precedence as `decodeMcpCall` (`toolName || name`), which is
					// what the exec channel pairs its result under. Diverging here would
					// name the block one thing and its result another.
					name: args.toolName || args.name || "",
					arguments: {},
					[kStreamingBlockIndex]: output.content.length,
					[kStreamingPartialJson]: "",
					[kStreamingBlockKind]: "mcp",
					[kStreamingEnvelopeId]: update.message.value.callId || undefined,
				};
				output.content.push(block);
				retainStreamedCall(state, block, update.message.value.callId);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
				return;
			}
		}
	} else if (updateCase === "toolCallDelta" || updateCase === "partialToolCall") {
		// Same correlation rule as the completion path below: an argument delta
		// belonging to a different call must not be appended to this block's
		// buffer, which would corrupt the JSON both of them parse.
		const target = resolveStreamedCall(state, update.message.value.callId);
		if (target?.[kStreamingBlockKind] === "mcp") {
			// Cursor's `args_text_delta` is "aggregated args text so far" per agent.proto: each
			// delta is a cumulative snapshot of the JSON-text args. Strip the prefix we already
			// have to recover the new suffix; fall back to treating the value as an incremental
			// fragment when it doesn't extend the buffer.
			const snapshot: string = update.message.value.argsTextDelta || "";
			const current = target[kStreamingPartialJson] ?? "";
			const chunk = snapshot.startsWith(current) ? snapshot.slice(current.length) : snapshot;
			if (chunk.length === 0) {
				return;
			}
			const nextBuffer = current + chunk;
			target[kStreamingPartialJson] = nextBuffer;
			// Throttle mid-stream parses to keep total parse work O(N) instead of O(N²)
			// in the argument-buffer length; the authoritative full parse runs in
			// `toolCallCompleted` (mcp branch) and the fallback end-of-stream path.
			const throttled = parseStreamingJsonThrottled(nextBuffer, target[kStreamingLastParseLen] ?? 0);
			if (throttled) {
				target.arguments = throttled.value;
				target[kStreamingLastParseLen] = throttled.parsedLen;
			}
			const idx = output.content.indexOf(target);
			stream.push({ type: "toolcall_delta", contentIndex: idx, delta: chunk, partial: output });
		}
	} else if (updateCase === "toolCallCompleted") {
		// Correlate on the envelope's `call_id`, NOT the block id: MCP, Pi and SCM
		// blocks are filed under the id inside the call's `args` (which is what
		// the exec channel pairs its result under), and that need not equal the
		// envelope id. Cursor also interleaves calls, so the block this settles
		// is looked up by id rather than assumed to be the last one opened —
		// otherwise an unrelated completion closes whichever block is current and
		// pairs it with the wrong result.
		const settled = resolveStreamedCall(state, update.message.value.callId);
		if (settled) {
			const toolCall = update.message.value.toolCall;
			if (settled[kStreamingBlockKind] === "mcp") {
				// Authoritative full parse of the accumulated argument buffer; the delta
				// path throttles mid-stream parses, so `arguments` may lag the buffer.
				const partial = settled[kStreamingPartialJson];
				if (partial !== undefined) {
					settled.arguments = parseStreamingJson(partial);
				}
				const decodedArgs = decodeMcpArgsMap(selectMcpCall(toolCall)?.args?.args);
				settled.arguments = mergeCursorMcpToolCallArgs(
					settled.arguments as Record<string, unknown> | undefined,
					decodedArgs,
				);

				const idx = output.content.indexOf(settled);
				clearStreamingPartialJson(settled);
				stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: settled, partial: output });
				releaseStreamedCall(state, settled);
			}
		} else if (updateCase === "turnEnded") {
			output.stopReason = "stop";
			if (
				isKimiK3ModelId(output.model) &&
				!output.content.some(item => item.type === "thinking" && item.thinking.length > 0)
			) {
				logger.warn(
					"Cursor kimi-k3 turn completed without thinking blocks; persisted history will replay this turn without reasoning",
					{ model: output.model, messageTimestamp: output.timestamp },
				);
			}
		} else if (updateCase === "tokenDelta") {
			const tokenDelta = update.message.value;
			usageState.sawTokenDelta = true;
			output.usage.output += tokenDelta.tokens || 0;
			output.usage.totalTokens = output.usage.input + output.usage.output;
		}
	}
}

function handleConversationCheckpointUpdate(
	checkpoint: ConversationStateStructure,
	output: AssistantMessage,
	usageState: UsageState,
	onConversationCheckpoint?: (checkpoint: ConversationStateStructure) => void,
): void {
	onConversationCheckpoint?.(checkpoint);
	if (usageState.sawTokenDelta) {
		return;
	}
	const usedTokens = checkpoint.tokenDetails?.usedTokens ?? 0;
	if (usedTokens <= 0) {
		return;
	}
	if (output.usage.contextTokens !== usedTokens) {
		output.usage.contextTokens = usedTokens;
	}
}

function createBlobId(data: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
	const blobId = createBlobId(data);
	blobStore.set(Buffer.from(blobId).toString("hex"), data);
	return blobId;
}

function readCursorBlob(blobStore: Map<string, Uint8Array>, blobId: Uint8Array): Uint8Array {
	const data = blobStore.get(Buffer.from(blobId).toString("hex"));
	if (!data) {
		throw new AIError.ValidationError("Cursor blob not found");
	}
	return data;
}

export function buildMcpToolDefinitions(tools: Tool[] | undefined): McpToolDefinition[] {
	return (tools ?? []).map(tool => {
		const jsonSchema = toolWireSchema(tool);
		const schemaValue: JsonValue =
			jsonSchema && typeof jsonSchema === "object"
				? (jsonSchema as JsonValue)
				: { type: "object", properties: {}, required: [] };
		const inputSchema = toBinary(ValueSchema, fromJson(ValueSchema, schemaValue));
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi-agent",
			toolName: tool.name,
			inputSchema,
		});
	});
}

/**
 * Extract text content from a user or developer message.
 */
function extractUserMessageText(msg: Message): string {
	if (msg.role !== "user" && msg.role !== "developer") return "";
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
	return text.trim();
}

function hasUserMessageImages(msg: Message): boolean {
	return (
		(msg.role === "user" || msg.role === "developer") &&
		Array.isArray(msg.content) &&
		msg.content.some(item => item.type === "image")
	);
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(content: string | (TextContent | ImageContent)[]): CursorRootPromptContentPart[] {
	if (typeof content === "string") {
		const text = content.trim();
		return text ? [{ type: "text", text }] : [];
	}
	const parts: CursorRootPromptContentPart[] = [];
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else {
			parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
		}
	}
	return parts;
}

function cursorUserContentKey(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") {
		return content.trim();
	}
	const hash = createHash("sha256");
	for (const item of content) {
		hash.update(item.type);
		if (item.type === "text") {
			hash.update(item.text);
		} else {
			hash.update(item.mimeType);
			hash.update(item.data);
		}
	}
	return hash.digest("hex");
}

type CursorRootPromptAssistantContentPart =
	| { type: "text"; text: string }
	| {
			type: "reasoning";
			text: string;
			providerOptions: { cursor: { modelName: string } };
			signature?: string;
	  }
	| { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> };

function canReplayCursorThinking(msg: AssistantMessage, targetModelId: string | undefined): boolean {
	return (
		targetModelId !== undefined &&
		isKimiK3ModelId(targetModelId) &&
		msg.api === "cursor-agent" &&
		msg.provider === "cursor" &&
		msg.model === targetModelId
	);
}

function buildCursorAssistantContent(
	msg: AssistantMessage,
	targetModelId: string | undefined,
): CursorRootPromptAssistantContentPart[] {
	const content: CursorRootPromptAssistantContentPart[] = [];
	const replayThinking = canReplayCursorThinking(msg, targetModelId);
	for (const item of msg.content) {
		if (item.type === "text") {
			if (item.text) content.push({ type: "text", text: item.text });
		} else if (item.type === "thinking") {
			if (replayThinking && item.thinking) {
				content.push({
					type: "reasoning",
					text: item.thinking,
					providerOptions: { cursor: { modelName: msg.model } },
					...(item.thinkingSignature ? { signature: item.thinkingSignature } : {}),
				});
			}
		} else if (item.type === "toolCall") {
			content.push({
				type: "tool-call",
				toolCallId: item.id,
				toolName: item.name,
				args: item.arguments,
			});
		}
	}
	return content;
}

function assertCursorKimiK3HistoryReplayable(
	messages: Message[],
	activeUserMessageIndex: number,
	targetModelId: string | undefined,
): void {
	if (!targetModelId || !isKimiK3ModelId(targetModelId)) return;
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const missingThinkingTurns: number[] = [];
	const newlyWarnedKeys: string[] = [];
	let assistantTurn = 0;
	for (let i = 0; i < historyEnd; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		assistantTurn++;
		const isSameCursorModel = msg.api === "cursor-agent" && msg.provider === "cursor" && msg.model === targetModelId;
		if (!isSameCursorModel) {
			// Foreign history genuinely cannot replay K3 thinking: another model's
			// turns carry no K3-signed reasoning to reconstruct.
			throw new AIError.ValidationError(
				`Cursor ${targetModelId} cannot continue history from a different model (${msg.provider}/${msg.model}); start a new session.`,
			);
		}
		const hasThinking = msg.content.some(item => item.type === "thinking" && item.thinking.length > 0);
		if (hasThinking) continue;
		const warningKey = `${msg.api}\0${msg.provider}\0${msg.model}\0${msg.timestamp}`;
		if (warnedCursorKimiK3ReplayMessages.has(warningKey)) continue;
		missingThinkingTurns.push(assistantTurn);
		newlyWarnedKeys.push(warningKey);
	}
	if (missingThinkingTurns.length === 0) return;
	for (const key of newlyWarnedKeys) warnedCursorKimiK3ReplayMessages.add(key);
	logger.warn(
		`Cursor kimi-k3 history contains same-model assistant turn(s) ${missingThinkingTurns.join(", ")} without thinking blocks; replaying those spans without reasoning may make generation less stable`,
		{ model: targetModelId, assistantTurns: missingThinkingTurns },
	);
}

/**
 * Index of the last user/developer message in `messages`, or -1 if none.
 * Used to exclude the current user turn from history builders — it goes in
 * `ConversationActionSchema.userMessageAction`, not in history structures.
 */
function findLastUserMessageIndex(messages: Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i].role;
		if (role === "user" || role === "developer") {
			return i;
		}
	}
	return -1;
}

/**
 * Build `ConversationStateStructure.rootPromptMessagesJson` blob IDs for the
 * system prompt plus prior conversation history, as JSON blobs matching
 * Cursor's internal Vercel-AI-SDK-shaped message format.
 *
 * Cursor's server uses `rootPromptMessagesJson` (not `turns[]`) to build the
 * actual model prompt. `turns[]` is UI/display metadata. Without populating
 * this field, multi-turn conversations lose prior context — the model sees
 * only an empty placeholder where historical user turns should be.
 * The active user message is excluded because it is sent in the action.
 */
/**
 * Build one Cursor system-message JSON blob per ordered system prompt. Emitting separate blobs
 * (rather than a single `\n\n`-joined string) lets Cursor's blob cache hit independently per
 * entry: changing only the last prompt does not invalidate earlier blob ids, so the prefix
 * up to the changed prompt remains cached on the server side.
 *
 * When no system prompts are provided, returns a single default greeting so we never emit
 * an empty `rootPromptMessagesJson` head.
 */
export function buildCursorSystemPromptJsons(systemPrompt: readonly string[] | undefined): string[] {
	const systemPrompts = normalizeSystemPrompts(systemPrompt);
	if (systemPrompts.length === 0) {
		return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
	}
	return systemPrompts.map(content => JSON.stringify({ role: "system", content }));
}

function buildRootPromptMessagesJson(
	messages: Message[],
	systemPromptIds: Uint8Array[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	assertCursorKimiK3HistoryReplayable(messages, activeUserMessageIndex, targetModelId);
	const entries: Uint8Array[] = [...systemPromptIds];
	const pushJson = (obj: unknown) => {
		const bytes = new TextEncoder().encode(JSON.stringify(obj));
		entries.push(storeCursorBlob(blobStore, bytes));
	};

	for (let i = 0; i < messages.length; i++) {
		if (i === activeUserMessageIndex) break;
		const msg = messages[i];
		if (msg.role === "user" || msg.role === "developer") {
			const content = buildCursorRootPromptContent(msg.content);
			if (content.length === 0) continue;
			pushJson({ role: "user", content });
		} else if (msg.role === "assistant") {
			const content = buildCursorAssistantContent(msg, targetModelId);
			if (content.length === 0) continue;
			pushJson({ role: "assistant", content });
		} else if (msg.role === "toolResult") {
			// Emit even when the result text is empty: the assistant `tool-call` is
			// already in history, so dropping the pair would replay an orphaned call.
			pushJson({
				role: "tool",
				id: msg.toolCallId,
				content: [
					{
						type: "tool-result",
						toolName: msg.toolName,
						toolCallId: msg.toolCallId,
						result: toolResultToText(msg),
						...(msg.isError ? { isError: true } : {}),
					},
				],
			});
		}
	}

	return entries;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isPlainRecord(value)) return false;
	for (const key in value) {
		if (!isJsonValue(value[key])) return false;
	}
	return true;
}

function encodeCursorMcpArguments(toolCall: ToolCall): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	for (const name in toolCall.arguments) {
		const value = toolCall.arguments[name];
		if (value === undefined) continue;
		if (!isJsonValue(value)) {
			throw new AIError.ValidationError(`Cursor tool argument ${toolCall.name}.${name} is not JSON-serializable`);
		}
		encoded[name] = toBinary(ValueSchema, fromJson(ValueSchema, value));
	}
	return encoded;
}

function createCursorMcpResult(result: ToolResultMessage) {
	if (result.isError) {
		return create(McpToolResultSchema, {
			result: {
				case: "error",
				value: create(McpToolErrorSchema, { error: toolResultToText(result) }),
			},
		});
	}
	return create(McpToolResultSchema, {
		result: {
			case: "success",
			value: create(McpSuccessSchema, {
				content: result.content.map(item =>
					item.type === "text"
						? create(McpToolResultContentItemSchema, {
								content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
							})
						: create(McpToolResultContentItemSchema, {
								content: {
									case: "image",
									value: create(McpImageContentSchema, {
										data: Uint8Array.from(Buffer.from(item.data, "base64")),
										mimeType: item.mimeType,
									}),
								},
							}),
				),
			}),
		},
	});
}

function createCursorToolCallStep(toolCall: ToolCall, result: ToolResultMessage | undefined) {
	const mcpCall = create(McpToolCallSchema, {
		args: create(McpArgsSchema, {
			name: toolCall.name,
			args: encodeCursorMcpArguments(toolCall),
			toolCallId: toolCall.id,
			providerIdentifier: "pi-agent",
			toolName: toolCall.name,
		}),
		...(result ? { result: createCursorMcpResult(result) } : {}),
	});
	return create(ConversationStepSchema, {
		message: {
			case: "toolCall",
			value: create(ToolCallSchema, {
				tool: { case: "mcpToolCall", value: mcpCall },
				toolCallId: toolCall.id,
			}),
		},
	});
}

/**
 * Convert context.messages to Cursor's ConversationTurnStructure blob IDs.
 * Groups messages into turns: each turn is a user message followed by the assistant's response.
 * Excludes the active user message (which goes in the action).
 *
 * Each `AgentConversationTurnStructure.user_message`, `steps[]`, and the outer
 * `ConversationStateStructure.turns[]` entry is a blob ID into `blobStore`.
 */
function buildConversationTurns(
	messages: Message[],
	blobStore: Map<string, Uint8Array>,
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): Uint8Array[] {
	const turns: Uint8Array[] = [];
	const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
	const toolResults = new Map<string, ToolResultMessage>();
	const pairedToolCallIds = new Set<string>();
	for (let index = 0; index < historyEnd; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			toolResults.set(message.toolCallId, message);
		} else if (message.role === "assistant") {
			for (const item of message.content) {
				if (item.type === "toolCall") pairedToolCallIds.add(item.id);
			}
		}
	}

	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "developer") {
			i++;
			continue;
		}
		if (i === activeUserMessageIndex) break;

		const userText = extractUserMessageText(msg);
		if (userText.length === 0 && !hasUserMessageImages(msg)) {
			i++;
			continue;
		}

		const userMessage = createCursorUserMessage(
			msg.content,
			userText,
			deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
		);
		const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
		const stepBlobIds: Uint8Array[] = [];
		i++;

		while (i < messages.length && messages[i].role !== "user" && messages[i].role !== "developer") {
			const stepMsg = messages[i];
			if (stepMsg.role === "assistant") {
				for (const item of stepMsg.content) {
					let step: ConversationStep;
					if (item.type === "text") {
						if (!item.text) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "assistantMessage",
								value: create(AssistantMessageSchema, { text: item.text }),
							},
						});
					} else if (item.type === "thinking") {
						// Same guard as root-prompt replay: only same-model Cursor K3
						// thinking is replayed, so foreign/hidden reasoning never leaks
						// into Cursor's turn history as native thinking.
						if (!item.thinking || !canReplayCursorThinking(stepMsg, targetModelId)) continue;
						step = create(ConversationStepSchema, {
							message: {
								case: "thinkingMessage",
								value: create(ThinkingMessageSchema, { text: item.thinking }),
							},
						});
					} else if (item.type === "toolCall") {
						step = createCursorToolCallStep(item, toolResults.get(item.id));
					} else {
						continue;
					}
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			} else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
				const text = toolResultToText(stepMsg);
				if (text) {
					const prefix = stepMsg.isError ? "[Tool Error]" : "[Tool Result]";
					const step = create(ConversationStepSchema, {
						message: {
							case: "assistantMessage",
							value: create(AssistantMessageSchema, { text: `${prefix}\n${text}` }),
						},
					});
					stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
				}
			}
			i++;
		}

		const agentTurn = create(AgentConversationTurnStructureSchema, {
			userMessage: userMessageBlobId,
			steps: stepBlobIds,
		});
		const turn = create(ConversationTurnStructureSchema, {
			turn: {
				case: "agentConversationTurn",
				value: agentTurn,
			},
		});
		turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
	}

	return turns;
}

/** Exported for tests: decodes Cursor history blobs built from conversation messages. */
export function buildCursorHistoryForTest(
	messages: Message[],
	activeUserMessageIndex = findLastUserMessageIndex(messages),
	targetModelId?: string,
): {
	rootPromptMessagesJson: unknown[];
	turnUserMessagesJson: JsonValue[];
	turnStepMessagesJson: JsonValue[][];
} {
	const blobStore = new Map<string, Uint8Array>();
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		messages,
		[],
		blobStore,
		activeUserMessageIndex,
		targetModelId,
	).map(blobId => JSON.parse(new TextDecoder().decode(readCursorBlob(blobStore, blobId))));
	const turnUserMessagesJson: JsonValue[] = [];
	const turnStepMessagesJson: JsonValue[][] = [];
	for (const turnBlobId of buildConversationTurns(messages, blobStore, activeUserMessageIndex, targetModelId)) {
		const turn = fromBinary(ConversationTurnStructureSchema, readCursorBlob(blobStore, turnBlobId));
		if (turn.turn.case !== "agentConversationTurn") {
			continue;
		}
		const userMessage = fromBinary(UserMessageSchema, readCursorBlob(blobStore, turn.turn.value.userMessage));
		turnUserMessagesJson.push(toJson(UserMessageSchema, userMessage));
		turnStepMessagesJson.push(
			turn.turn.value.steps.map(stepBlobId => {
				const step = fromBinary(ConversationStepSchema, readCursorBlob(blobStore, stepBlobId));
				return toJson(ConversationStepSchema, step);
			}),
		);
	}
	return { rootPromptMessagesJson, turnUserMessagesJson, turnStepMessagesJson };
}
function createCursorUserMessage(
	content: string | (TextContent | ImageContent)[],
	text: string,
	messageId = crypto.randomUUID(),
) {
	const images = typeof content === "string" ? [] : extractImages(content);
	return create(UserMessageSchema, {
		text,
		messageId,
		...(images.length > 0
			? {
					selectedContext: create(SelectedContextSchema, {
						selectedImages: images,
					}),
				}
			: {}),
	});
}

function extractImages(content: (TextContent | ImageContent)[]) {
	return content
		.filter((item): item is ImageContent => item.type === "image")
		.map(image =>
			create(SelectedImageSchema, {
				uuid: crypto.randomUUID(),
				mimeType: image.mimeType,
				dataOrBlobId: {
					case: "data",
					value: Uint8Array.from(Buffer.from(image.data, "base64")),
				},
			}),
		);
}

async function buildGrpcRequest(
	model: Model<"cursor-agent">,
	context: Context,
	options: CursorOptions | undefined,
	state: {
		conversationId: string;
		blobStore: Map<string, Uint8Array>;
		conversationState?: ConversationStateStructure;
	},
): Promise<{
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	conversationState: ConversationStateStructure;
}> {
	const blobStore = state.blobStore;

	const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map(json =>
		storeCursorBlob(blobStore, new TextEncoder().encode(json)),
	);

	const activeUserMessageIndex = context.messages.length - 1;
	const activeMessage = context.messages[activeUserMessageIndex];
	const activeUserMessage =
		activeMessage?.role === "user" || activeMessage?.role === "developer" ? activeMessage : undefined;
	let userContent: string | (TextContent | ImageContent)[] | undefined;
	let userText = "";
	let hasUserImages = false;
	if (activeUserMessage?.role === "user" || activeUserMessage?.role === "developer") {
		userContent = activeUserMessage.content;
		if (typeof userContent === "string") {
			userText = userContent.trim();
		} else {
			userText = extractText(userContent);
			hasUserImages = hasImages(userContent);
		}
	}

	const action = create(ConversationActionSchema, {
		action:
			userContent && (userText.trim().length > 0 || hasUserImages)
				? {
						case: "userMessageAction",
						value: create(UserMessageActionSchema, {
							userMessage: createCursorUserMessage(userContent, userText),
						}),
					}
				: {
						case: "resumeAction",
						value: create(ResumeActionSchema, {}),
					},
	});

	// Build conversation turns from prior messages, excluding only the active user message
	// when the request is sending one. Resume actions must preserve trailing tool results.
	const turns = buildConversationTurns(
		context.messages,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	// Build `rootPromptMessagesJson` from prior messages. Cursor's server uses this
	// field (not `turns[]`) to construct the actual model prompt; if we only send the
	// system prompt here, multi-turn conversations lose prior context and the model
	// sees only the current user message.
	const rootPromptMessagesJson = buildRootPromptMessagesJson(
		context.messages,
		systemPromptIds,
		blobStore,
		activeUserMessage ? activeUserMessageIndex : -1,
		model.id,
	);

	// Preserve cached non-history state fields (todos, file states, summaries, etc.)
	// when the system prompt is unchanged; otherwise start fresh.
	const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
	const hasMatchingPrompt =
		cachedPromptHead.length === systemPromptIds.length &&
		systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]).equals(id));
	const baseState =
		state.conversationState && hasMatchingPrompt
			? state.conversationState
			: create(ConversationStateStructureSchema, {
					rootPromptMessagesJson: systemPromptIds,
					turns: [],
					todos: [],
					pendingToolCalls: [],
					previousWorkspaceUris: [],
					fileStates: {},
					fileStatesV2: {},
					summaryArchives: [],
					turnTimings: [],
					subagentStates: {},
					selfSummaryCount: 0,
					readPaths: [],
				});

	// Always override `rootPromptMessagesJson` and `turns` with content freshly built from
	// `context.messages`. The server-echoed checkpoint replaces historical user entries
	// with empty placeholders, so we cannot rely on the cached `rootPromptMessagesJson`.
	const conversationState = create(ConversationStateStructureSchema, {
		...baseState,
		rootPromptMessagesJson,
		turns,
	});

	const wireModelId = model.requestModelId ?? model.id;
	const cursorMaxMode = model.cursorMaxMode === true;
	const modelDetails = create(ModelDetailsSchema, {
		modelId: wireModelId,
		displayModelId: model.id,
		displayName: model.name,
		...(cursorMaxMode ? { maxMode: true } : undefined),
	});
	const requestedModel = create(RequestedModelSchema, {
		modelId: wireModelId,
		maxMode: cursorMaxMode,
	});

	const runRequest = create(AgentRunRequestSchema, {
		conversationState,
		action,
		modelDetails,
		requestedModel,
		conversationId: state.conversationId,
	});

	if (options?.customSystemPrompt) {
		runRequest.customSystemPrompt = options.customSystemPrompt;
	}

	const replacementPayload = await options?.onPayload?.(runRequest, model);
	const payload = replacementPayload !== undefined ? (replacementPayload as typeof runRequest) : runRequest;

	// Tools are sent later via requestContext (exec handshake)

	const clientMessage = create(AgentClientMessageSchema, {
		message: { case: "runRequest", value: payload },
	});

	const requestBytes = toBinary(AgentClientMessageSchema, clientMessage);

	const toolNames = context.tools?.map(tool => tool.name) ?? [];
	const detail =
		$env.DEBUG_CURSOR === "2"
			? ` ${JSON.stringify(clientMessage.message.value, debugReplacer, 2)?.slice(0, 2000)}`
			: "";
	log("info", "builtRunRequest", {
		bytes: requestBytes.length,
		tools: toolNames.length,
		toolNames: toolNames.slice(0, 20),
		detail: detail || undefined,
	});

	return { requestBytes, blobStore, conversationState };
}

function hasImages(content: (TextContent | ImageContent)[]): boolean {
	return content.some(item => item.type === "image");
}
function extractText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

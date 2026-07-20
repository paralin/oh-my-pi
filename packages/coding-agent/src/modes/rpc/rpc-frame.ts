import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;

interface ShrinkPass {
	stringCap: number;
	arrayLimit: number;
	objectLimit: number;
}

const SHRINK_PASSES: readonly ShrinkPass[] = [
	{ stringCap: 256 * 1024, arrayLimit: 512, objectLimit: 512 },
	{ stringCap: 64 * 1024, arrayLimit: 256, objectLimit: 256 },
	{ stringCap: 16 * 1024, arrayLimit: 128, objectLimit: 128 },
	{ stringCap: 4 * 1024, arrayLimit: 64, objectLimit: 64 },
	{ stringCap: 1024, arrayLimit: 32, objectLimit: 32 },
	{ stringCap: 256, arrayLimit: 8, objectLimit: 16 },
	{ stringCap: 64, arrayLimit: 1, objectLimit: 8 },
];

const STRING_ELISION_RESERVE = 80;
const METADATA_STRING_CAP = 1024;

function serializedFrameBytes(json: string): number {
	return Buffer.byteLength(json, "utf8") + 1;
}

function shrinkString(value: string, cap: number): string {
	if (value.length <= cap) return value;
	const headLength = Math.max(0, cap - STRING_ELISION_RESERVE);
	return `${value.slice(0, headLength)}\n…[${value.length - headLength} chars elided for RPC frame]`;
}

function shrinkValue(value: unknown, pass: ShrinkPass): unknown {
	if (typeof value === "string") return shrinkString(value, pass.stringCap);
	if (Array.isArray(value)) {
		const keep = Math.min(value.length, pass.arrayLimit);
		const output: unknown[] = new Array(keep + (keep < value.length ? 1 : 0));
		for (let index = 0; index < keep; index++) output[index] = shrinkValue(value[index], pass);
		if (keep < value.length) output[keep] = `…[${value.length - keep} items elided for RPC frame]`;
		return output;
	}
	if (isRecord(value)) {
		const entries = Object.entries(value);
		const keep = Math.min(entries.length, pass.objectLimit);
		const output: Record<string, unknown> = {};
		for (let index = 0; index < keep; index++) {
			const [key, item] = entries[index];
			output[key] = shrinkValue(item, pass);
		}
		if (keep < entries.length) output.rpcFrameElidedKeys = entries.length - keep;
		return output;
	}
	return value;
}

function jsonSnapshot(value: unknown): unknown {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : JSON.parse(json);
}

function encodedMessageSnapshot(encoded: string): { message: unknown } | undefined {
	const frame = JSON.parse(encoded);
	return isRecord(frame) && frame.type === "message_end" && Object.hasOwn(frame, "message")
		? { message: frame.message }
		: undefined;
}

function compactTerminalFrame(
	frame: object,
	streamedMessageCount: number,
	streamedMessages?: readonly unknown[],
): object {
	if (!isRecord(frame) || frame.type !== "agent_end" || !Array.isArray(frame.messages)) return frame;
	let streamed = Number.isSafeInteger(streamedMessageCount)
		? Math.min(Math.max(0, streamedMessageCount), frame.messages.length)
		: 0;
	if (streamedMessages) {
		streamed = 0;
		const limit = Math.min(streamedMessages.length, frame.messages.length);
		while (
			streamed < limit &&
			isDeepStrictEqual(streamedMessages[streamed], jsonSnapshot(frame.messages[streamed]))
		) {
			streamed++;
		}
	}
	return {
		...frame,
		messages: frame.messages.slice(streamed),
		messageCount: frame.messages.length,
	};
}

function overflowFrame(frame: object): object {
	if (!isRecord(frame)) return { type: "rpc_frame_error", error: "RPC frame exceeded the transport limit" };
	if (frame.type === "response") {
		return {
			id: typeof frame.id === "string" ? shrinkString(frame.id, METADATA_STRING_CAP) : undefined,
			type: "response",
			command: typeof frame.command === "string" ? shrinkString(frame.command, METADATA_STRING_CAP) : "unknown",
			success: false,
			error: "RPC response exceeded the transport limit",
		};
	}
	if (frame.type === "agent_end") {
		return {
			type: "agent_end",
			messages: [],
			messageCount: typeof frame.messageCount === "number" ? frame.messageCount : 0,
		};
	}
	return {
		type: "rpc_frame_error",
		originalType: typeof frame.type === "string" ? shrinkString(frame.type, METADATA_STRING_CAP) : undefined,
		error: "RPC frame exceeded the transport limit",
	};
}

/** Serialize a complete JSONL frame while enforcing the transport byte ceiling. */
export function encodeRpcFrame(frame: object, streamedMessageCount = 0, streamedMessages?: readonly unknown[]): string {
	let json = JSON.stringify(frame);
	if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;
	if (isRecord(frame) && frame.type === "response") {
		return `${JSON.stringify(overflowFrame(frame))}\n`;
	}

	const compacted = compactTerminalFrame(frame, streamedMessageCount, streamedMessages);
	json = JSON.stringify(compacted);
	if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;

	for (const pass of SHRINK_PASSES) {
		json = JSON.stringify(shrinkValue(compacted, pass));
		if (serializedFrameBytes(json) <= MAX_RPC_FRAME_BYTES) return `${json}\n`;
	}

	return `${JSON.stringify(overflowFrame(compacted))}\n`;
}

/** Stateful encoder that tracks which messages a client has already received. */
export class RpcFrameEncoder {
	#streamedMessages: unknown[] = [];

	encode(frame: object): string {
		if (isRecord(frame) && frame.type === "agent_start") this.#streamedMessages = [];
		const encoded = encodeRpcFrame(frame, this.#streamedMessages.length, this.#streamedMessages);
		if (!isRecord(frame)) return encoded;
		if (frame.type === "message_end") {
			const snapshot = encodedMessageSnapshot(encoded);
			if (snapshot) this.#streamedMessages.push(snapshot.message);
		} else if (frame.type === "agent_end" && frame.willContinue !== true) this.#streamedMessages = [];
		return encoded;
	}
}

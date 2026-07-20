import { describe, expect, it } from "bun:test";
import { encodeRpcFrame, MAX_RPC_FRAME_BYTES, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";

function decode(frame: string): Record<string, unknown> {
	return JSON.parse(frame) as Record<string, unknown>;
}

function oversizedMessageHistory(prefix: string) {
	const payload = "x".repeat(1024);
	return Array.from({ length: 1024 }, (_, index) => ({
		role: "assistant",
		content: [{ type: "text", text: `${prefix}-${index}-${payload}` }],
	}));
}

describe("RPC frame encoding", () => {
	it("preserves frames that already fit", () => {
		const frame = { id: "request-1", type: "response", command: "get_state", success: true, data: { ok: true } };
		expect(encodeRpcFrame(frame)).toBe(`${JSON.stringify(frame)}\n`);
	});

	it("compacts agent_end after message events have streamed", () => {
		const messages = Array.from({ length: 10_000 }, (_, index) => ({
			role: "assistant",
			content: [{ type: "text", text: `message-${index}-${"x".repeat(128)}` }],
		}));
		const encoded = encodeRpcFrame({ type: "agent_end", messages, telemetry: { stepCount: 42 } }, messages.length);
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded).toEqual({ type: "agent_end", messages: [], messageCount: 10_000, telemetry: { stepCount: 42 } });
	});

	it("retains a terminal error emitted only by agent_end after earlier message events", () => {
		const streamed = { role: "assistant", content: [{ type: "text", text: "done" }] };
		const aborted = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		};
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		encoder.encode({ type: "message_end", message: streamed });
		const decoded = decode(encoder.encode({ type: "agent_end", messages: [aborted] }));

		expect(decoded).toEqual({
			type: "agent_end",
			messages: [aborted],
		});
	});

	it("preserves terminal histories that fit for clients reading agent_end messages", () => {
		const streamed = { role: "assistant", content: [{ type: "text", text: "done" }] };
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		encoder.encode({ type: "message_end", message: streamed });
		const frame = { type: "agent_end", messages: [streamed] };

		expect(encoder.encode(frame)).toBe(`${JSON.stringify(frame)}\n`);
	});

	it("matches oversized terminal messages in the JSON shape sent by message_end", () => {
		const messages = oversizedMessageHistory("wire-shape");
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of messages) {
			encoder.encode({
				type: "message_end",
				message: {
					...message,
					disabledFeatures: undefined,
					toolCallAbortMessages: undefined,
				},
			});
		}
		const encoded = encoder.encode({ type: "agent_end", messages });

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decode(encoded)).toEqual({
			type: "agent_end",
			messages: [],
			messageCount: messages.length,
		});
	});

	it("does not let later mutation rewrite the message_end snapshot", () => {
		const messages = oversizedMessageHistory("before");
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of messages) encoder.encode({ type: "message_end", message });
		messages[0].content[0].text = "after";
		const decoded = decode(encoder.encode({ type: "agent_end", messages }));

		expect(decoded.messageCount).toBe(messages.length);
		expect(Array.isArray(decoded.messages)).toBe(true);
		expect((decoded.messages as unknown[]).length).toBeGreaterThan(0);
	});

	it("keeps the active run snapshot when a continuing agent_end arrives late", () => {
		const active = oversizedMessageHistory("active");
		const stale = { role: "assistant", content: [{ type: "text", text: "stale" }] };
		const encoder = new RpcFrameEncoder();
		encoder.encode({ type: "agent_start" });
		for (const message of active) encoder.encode({ type: "message_end", message });

		expect(decode(encoder.encode({ type: "agent_end", messages: [stale], willContinue: true }))).toEqual({
			type: "agent_end",
			messages: [stale],
			willContinue: true,
		});
		expect(decode(encoder.encode({ type: "agent_end", messages: active }))).toEqual({
			type: "agent_end",
			messages: [],
			messageCount: active.length,
		});
		const replayed = decode(encoder.encode({ type: "agent_end", messages: active }));
		expect(replayed.messageCount).toBe(active.length);
		expect(Array.isArray(replayed.messages)).toBe(true);
		expect((replayed.messages as unknown[]).length).toBeGreaterThan(0);
	});

	it("bounds a single multi-byte message without losing its event discriminator", () => {
		const encoded = encodeRpcFrame({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "😀".repeat(600_000) }] },
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.type).toBe("message_end");
		expect(encoded).toContain("chars elided for RPC frame");
	});

	it("bounds objects with many small fields", () => {
		const details = Object.fromEntries(
			Array.from({ length: 20_000 }, (_, index) => [`field-${index}`, `value-${index}-${"x".repeat(64)}`]),
		);
		const encoded = encodeRpcFrame({ type: "tool_execution_end", toolCallId: "tool-1", details });
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.type).toBe("tool_execution_end");
		expect(encoded).toContain("rpcFrameElidedKeys");
	});

	it("fails oversized responses instead of returning partial success data", () => {
		const encoded = encodeRpcFrame({
			id: "request-2",
			type: "response",
			command: "get_state",
			success: true,
			data: { transcript: "x".repeat(MAX_RPC_FRAME_BYTES) },
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded).toEqual({
			id: "request-2",
			type: "response",
			command: "get_state",
			success: false,
			error: "RPC response exceeded the transport limit",
		});
	});

	it("keeps overflow response metadata within the hard byte ceiling", () => {
		const encoded = encodeRpcFrame({
			id: "😀".repeat(MAX_RPC_FRAME_BYTES),
			type: "response",
			command: "get_state",
			success: true,
			data: {},
		});
		const decoded = decode(encoded);

		expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_RPC_FRAME_BYTES);
		expect(decoded.success).toBe(false);
		expect(decoded.id).toContain("chars elided for RPC frame");
	});
});

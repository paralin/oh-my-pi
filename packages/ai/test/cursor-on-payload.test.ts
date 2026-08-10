import { describe, expect, it } from "bun:test";
import http2 from "node:http2";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	AgentClientMessageSchema,
	type AgentRunRequest,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/agent_pb";

function frameConnectMessage(data: Uint8Array): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

describe("Cursor onPayload", () => {
	it("sends an async replacement as the final protobuf run request", async () => {
		const server = http2.createServer();
		const listening = Promise.withResolvers<void>();
		server.once("error", listening.reject);
		server.listen(0, "127.0.0.1", listening.resolve);
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Cursor test server did not bind");

		const received = Promise.withResolvers<Uint8Array>();
		server.on("stream", (request: http2.ServerHttp2Stream) => {
			request.once("data", (frame: Buffer) => {
				received.resolve(frame.subarray(5));
				const turnEnded = create(AgentServerMessageSchema, {
					message: {
						case: "interactionUpdate",
						value: create(InteractionUpdateSchema, {
							message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
						}),
					},
				});
				request.respond({ ":status": 200 });
				request.end(frameConnectMessage(toBinary(AgentServerMessageSchema, turnEnded)));
			});
		});

		const model: Model<"cursor-agent"> = buildModel({
			id: "cursor-on-payload-test",
			name: "Cursor onPayload test",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		});
		const context: Context = {
			messages: [{ role: "user", content: "replace me", timestamp: Date.now() }],
		};

		try {
			const stream = streamCursor(model, context, {
				apiKey: "test-token",
				conversationId: "original-conversation",
				onPayload: async payload => {
					await Promise.resolve();
					return create(AgentRunRequestSchema, {
						...(payload as AgentRunRequest),
						conversationId: "replacement-conversation",
					});
				},
			});
			for await (const _event of stream) {
				// Drain the stream so the client closes after the server's turn-ended frame.
			}
			await stream.result();

			const clientMessage = fromBinary(AgentClientMessageSchema, await received.promise);
			expect(clientMessage.message.case).toBe("runRequest");
			if (clientMessage.message.case !== "runRequest") throw new Error("Expected Cursor run request");
			expect(clientMessage.message.value.conversationId).toBe("replacement-conversation");
		} finally {
			server.close();
		}
	});
});

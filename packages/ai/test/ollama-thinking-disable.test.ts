import { describe, expect, it } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function createReasoningOllamaModel() {
	return buildModel({
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "ollama-chat",
		provider: "ollama-cloud",
		baseUrl: "https://ollama.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

function getHeader(headers: RequestInit["headers"], name: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (Array.isArray(headers)) {
		for (const [key, value] of headers) {
			if (key.toLowerCase() === name.toLowerCase()) return value;
		}
		return undefined;
	}
	const value = headers[name];
	return typeof value === "string" ? value : value?.[0];
}

describe("Ollama chat thinking controls", () => {
	it("sends think false when reasoning is explicitly disabled", async () => {
		let payload: object | undefined;
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const parsed: unknown = JSON.parse(String(init?.body));
			if (parsed === null || typeof parsed !== "object") {
				throw new Error("Expected Ollama payload object");
			}
			payload = parsed;
			return new Response('{"message":{"content":"391"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const context: Context = {
			messages: [{ role: "user", content: "What is 17*23?", timestamp: 0 }],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			disableReasoning: true,
			fetch: fetchMock,
		}).result();

		expect(payload ? Reflect.get(payload, "think") : undefined).toBe(false);
	});

	it("forwards per-call headers to the chat request", async () => {
		let requestHeaders: RequestInit["headers"];
		const fetchMock = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestHeaders = init?.headers;
			return new Response('{"message":{"content":"ok"},"done":true,"prompt_eval_count":1,"eval_count":1}\n', {
				status: 200,
			});
		};
		const context: Context = {
			messages: [{ role: "user", content: "Ping", timestamp: 0 }],
		};

		await streamOllama(createReasoningOllamaModel(), context, {
			apiKey: "test-key",
			headers: { "X-Proxy-Token": "proxy-token" },
			fetch: fetchMock,
		}).result();

		expect(getHeader(requestHeaders, "X-Proxy-Token")).toBe("proxy-token");
		expect(getHeader(requestHeaders, "Authorization")).toBe("Bearer test-key");
	});
});

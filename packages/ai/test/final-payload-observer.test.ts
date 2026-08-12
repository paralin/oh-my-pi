import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamGoogle } from "@oh-my-pi/pi-ai/providers/google";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { streamPiNative } from "@oh-my-pi/pi-ai/providers/pi-native-client";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const tool: Tool = {
	name: "schema_probe",
	description: "Probe the final schema",
	parameters: type({ code: "string" }),
};
const context: Context = {
	systemPrompt: ["terminal prompt"],
	messages: [{ role: "user", content: "run the probe", timestamp: 0 }],
	tools: [tool],
};

function body(init?: RequestInit): Record<string, unknown> {
	if (typeof init?.body !== "string") throw new Error("expected JSON request body");
	return JSON.parse(init.body) as Record<string, unknown>;
}

function invalidReasoning(): Response {
	return new Response(
		JSON.stringify({
			error: {
				message: `invalid reasoning value: 'xhigh' (must be "high", "medium", "low", "max", or "none")`,
				type: "invalid_request_error",
				param: "reasoning.effort",
			},
		}),
		{ status: 400, headers: { "content-type": "application/json" } },
	);
}

function responsesDone(): Response {
	const events = [
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_final", role: "assistant", content: [] },
		},
		{ type: "response.output_text.delta", delta: "ok" },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "message", id: "msg_final", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_final",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function model<T extends "anthropic-messages" | "openai-responses" | "openai-completions">(
	provider: "anthropic" | "openai",
	id: string,
	api: T,
): Model<T> {
	const bundled = getBundledModel(provider, id);
	if (!bundled) throw new Error(`${provider}/${id} unavailable`);
	return { ...bundled, api } as Model<T>;
}

describe("final provider payload observer", () => {
	it("observes Anthropic after onPayload lone-surrogate normalization", async () => {
		const observed: Record<string, unknown>[] = [];
		const sent: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(body(init));
				return new Response("stop", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);
		await streamAnthropic(model("anthropic", "claude-sonnet-4-5", "anthropic-messages"), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onPayload: payload => {
				const { stream: _stream, ...replacement } = payload as Record<string, unknown>;
				return { ...replacement, marker: "bad\ud800" };
			},
			onFinalPayload: payload => {
				observed.push(structuredClone(payload as Record<string, unknown>));
			},
		}).result();

		expect(observed).toEqual(sent);
		expect(observed[0]?.marker).toBe("bad�");
		expect(observed[0]?.stream).toBe(true);
		expect(observed[0]?.system).toEqual(sent[0]?.system);
		expect(observed[0]?.tools).toEqual(sent[0]?.tools);
	});

	it("observes each OpenAI Responses body after reasoning fallback mutations", async () => {
		const observed: Record<string, unknown>[] = [];
		const sent: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(body(init));
				return sent.length === 1 ? invalidReasoning() : responsesDone();
			},
			{ preconnect: fetch.preconnect },
		);
		await streamOpenAIResponses(model("openai", "gpt-5.2", "openai-responses"), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			reasoning: "xhigh",
			onPayload: payload => ({ ...(payload as Record<string, unknown>), extensionMarker: "after" }),
			onFinalPayload: payload => {
				observed.push(structuredClone(payload as Record<string, unknown>));
			},
		}).result();

		expect(observed).toEqual(sent);
		expect(observed.map(item => (item.reasoning as { effort?: string }).effort)).toEqual(["xhigh", "max"]);
		expect(observed[1]?.instructions).toEqual(sent[1]?.instructions);
		expect(observed[1]?.tools).toEqual(sent[1]?.tools);
		expect(observed[1]?.extensionMarker).toBe("after");
	});

	it("observes OpenAI Completions prompt and tool schema exactly as sent", async () => {
		const observed: Record<string, unknown>[] = [];
		const sent: Record<string, unknown>[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(body(init));
				return new Response("stop", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);
		await streamOpenAICompletions(model("openai", "gpt-4o-mini", "openai-completions"), context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onPayload: payload => ({ ...(payload as Record<string, unknown>), extensionMarker: "after" }),
			onFinalPayload: payload => {
				observed.push(structuredClone(payload as Record<string, unknown>));
			},
		}).result();

		expect(observed).toEqual(sent);
		expect(observed[0]?.messages).toEqual(sent[0]?.messages);
		expect(observed[0]?.tools).toEqual(sent[0]?.tools);
		expect(observed[0]?.extensionMarker).toBe("after");
	});
	it("observes the Google wire body at the shared HTTP dispatch boundary", async () => {
		const observed: unknown[] = [];
		const sent: unknown[] = [];
		const fetchMock: FetchImpl = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				sent.push(body(init));
				return new Response("stop", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);
		const google = getBundledModel("google", "gemini-2.5-flash");
		if (!google) throw new Error("google/gemini-2.5-flash unavailable");
		await streamGoogle(google as Model<"google-generative-ai">, context, {
			apiKey: "test-key",
			fetch: fetchMock,
			onPayload: payload => ({ ...(payload as Record<string, unknown>), extensionMarker: "after" }),
			onFinalPayload: payload => {
				observed.push(structuredClone(payload));
			},
		}).result();

		expect(observed).toEqual(sent);
		expect((observed[0] as Record<string, unknown>).contents).toBeDefined();
	});

	it("reports pi-native as an explicit remote transport boundary", async () => {
		const observed: unknown[] = [];
		const fetchMock: FetchImpl = Object.assign(async () => new Response("gateway unavailable", { status: 502 }), {
			preconnect: fetch.preconnect,
		});
		const base = getBundledModel("openai", "gpt-4o-mini");
		if (!base) throw new Error("openai/gpt-4o-mini unavailable");
		let failure: unknown;
		try {
			await streamPiNative({ ...base, baseUrl: "https://gateway.test" }, context, {
				apiKey: "gateway-key",
				fetch: fetchMock,
				onFinalPayload: payload => {
					observed.push(payload);
				},
			}).result();
		} catch (error) {
			failure = error;
		}
		expect(String(failure)).toContain("auth-gateway 502");

		expect(observed).toEqual([
			{
				kind: "unsupported",
				transport: "pi-native",
				reason: "The exact provider request is created beyond the auth-gateway boundary",
			},
		]);
	});
});

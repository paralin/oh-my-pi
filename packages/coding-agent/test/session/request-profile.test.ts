import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { CompressProtocol } from "../../src/compress/protocol";
import { type RequestProfileKind, RequestProfileOwner } from "../../src/session/request-profile";

function tool(name: string, schema: Record<string, unknown>, concurrency?: "exclusive"): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type(schema),
		...(concurrency ? { concurrency } : {}),
		execute: async () => ({ content: [] }),
	};
}

const ipython = tool("ipython", { code: "string" }, "exclusive");
const sharedIpython = tool("shared_ipython", { code: "string" });
const rewrite = tool("rewrite", { text: "string", losses: type({ content: "string", reason: "string" }).array() });
const approve = tool("approve", { verdict: "string" });

const CODE_SCHEMA = {
	type: "object",
	properties: { code: { type: "string" } },
	required: ["code"],
	additionalProperties: false,
};
const REWRITE_SCHEMA = {
	type: "object",
	properties: {
		text: {
			type: "string",
			minLength: 1,
			description: "the complete compressed text, ready to ship verbatim",
		},
		losses: {
			type: "array",
			items: {
				type: "object",
				properties: {
					content: {
						type: "string",
						minLength: 1,
						description: "the dropped source content, quoted or described precisely",
					},
					reason: {
						type: "string",
						minLength: 1,
						description: "why the compressed text is still correct without it",
					},
				},
				required: ["content", "reason"],
				additionalProperties: false,
			},
			description:
				"every claim, qualifier, example, default, or exact string deliberately dropped; empty array only when the draft loses nothing",
		},
	},
	required: ["text", "losses"],
	additionalProperties: false,
	description: "submit a compressed draft together with everything it drops",
};
const APPROVE_SCHEMA = {
	type: "object",
	properties: {
		verdict: {
			type: "string",
			minLength: 1,
			description: "why the newest draft is acceptable as the final output",
		},
	},
	required: ["verdict"],
	additionalProperties: false,
	description: "accept the newest draft as the final output",
};

function withoutMinLength(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutMinLength);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "minLength")
			.map(([key, item]) => [key, withoutMinLength(item)]),
	);
}

interface BoundaryObservation {
	profile: RequestProfileKind;
	context: Context;
	payload: Record<string, unknown>;
}

function assistant(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "accepted" }],
		api: model.api,
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
}

function providerFixture(owner: RequestProfileOwner, observations: BoundaryObservation[]): Agent {
	const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
	const streamFn = (requestModel: Model, context: Context, options?: SimpleStreamOptions) => {
		const stream = new AssistantMessageEventStream();
		void (async () => {
			const controller = new AbortController();
			controller.abort();
			const adapted = Promise.withResolvers<Record<string, unknown>>();
			streamOpenAICompletions(model, context, {
				...options,
				apiKey: "test-key",
				signal: controller.signal,
				onFinalPayload: async (payload, finalModel) => {
					await options?.onFinalPayload?.(payload, finalModel);
					adapted.resolve(payload as Record<string, unknown>);
				},
			});
			const payload = await adapted.promise;
			observations.push({ profile: owner.request.kind, context, payload });
			const message = assistant(requestModel);
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		})().catch(error => stream.fail(error));
		return stream;
	};
	return new Agent({
		initialState: { model, systemPrompt: owner.request.systemPrompt, tools: owner.request.tools },
		streamFn,
		onPayload: async payload => ({ ...(payload as Record<string, unknown>), extensionReplacement: "after" }),
		onFinalPayload: (payload, requestModel) => {
			owner.captureEffectiveRequest({ provider: requestModel?.provider ?? "unknown", payload });
		},
	});
}

describe("request profiles", () => {
	test("pairs each discriminated prompt with its fixed tools", () => {
		const profiles = [
			new RequestProfileOwner({ kind: "primary-ipython", systemPrompt: ["primary"], tools: [ipython] }),
			new RequestProfileOwner({ kind: "act", systemPrompt: ["act"], tools: [sharedIpython] }),
			new RequestProfileOwner({
				kind: "compression",
				systemPrompt: ["compression"],
				tools: [rewrite, approve],
			}),
			new RequestProfileOwner({ kind: "no-tools", systemPrompt: ["none"], tools: [] }),
		];
		expect(profiles.map(owner => owner.request.kind)).toEqual(["primary-ipython", "act", "compression", "no-tools"]);
		expect(profiles.map(owner => owner.request.tools.map(item => item.name))).toEqual([
			["ipython"],
			["shared_ipython"],
			["rewrite", "approve"],
			[],
		]);
	});

	test("rejects a primary profile whose exclusive ipython schema drifts", () => {
		expect(
			() =>
				new RequestProfileOwner({
					kind: "primary-ipython",
					systemPrompt: ["prompt"],
					tools: [tool("ipython", { source: "string" }, "exclusive")],
				}),
		).toThrow("{code: string}");
	});

	test("adapts each profile fixture and records extension replacement", async () => {
		const protocol = new CompressProtocol("source text");
		const surfaces: Array<{ name: string; owner: RequestProfileOwner }> = [
			{ name: "root", owner: RequestProfileOwner.primary(["root prompt"], ipython) },
			{ name: "Task-created session", owner: RequestProfileOwner.primary(["task prompt"], ipython) },
			{ name: "retained Act", owner: RequestProfileOwner.act(["act prompt"], sharedIpython) },
			{ name: "commit completeSimple", owner: RequestProfileOwner.noTools(["commit prompt"]) },
			{ name: "advisor", owner: RequestProfileOwner.noTools(["advisor prompt"]) },
			{
				name: "compression",
				owner: RequestProfileOwner.compression(
					["compression prompt"],
					[protocol.rewriteTool(), protocol.approveTool()],
				),
			},
		];
		const observations: BoundaryObservation[] = [];
		for (const surface of surfaces) {
			const agent = providerFixture(surface.owner, observations);
			await agent.prompt(`${surface.name} request`);
			if (surface.name === "root") await agent.prompt("actual continuation request");
		}

		const expectedNames: Record<string, string[]> = {
			root: ["ipython"],
			"Task-created session": ["ipython"],
			"retained Act": ["shared_ipython"],
			"commit completeSimple": [],
			advisor: [],
			compression: ["rewrite", "approve"],
		};
		const expectedSchemas: Record<string, Array<Record<string, unknown>>> = {
			root: [CODE_SCHEMA],
			"Task-created session": [CODE_SCHEMA],
			"retained Act": [CODE_SCHEMA],
			"commit completeSimple": [],
			advisor: [],
			compression: [REWRITE_SCHEMA, APPROVE_SCHEMA],
		};
		const expectedWireSchemas = Object.fromEntries(
			Object.entries(expectedSchemas).map(([name, schemas]) => [name, schemas.map(withoutMinLength)]),
		);
		let offset = 0;
		for (const surface of surfaces) {
			const count = surface.name === "root" ? 2 : 1;
			const requests = observations.slice(offset, offset + count);
			offset += count;
			for (const request of requests) {
				expect(request.context.systemPrompt).toEqual(surface.owner.request.systemPrompt);
				expect(request.context.tools?.map(item => item.name)).toEqual(expectedNames[surface.name]);
				expect(request.context.tools?.map(item => toolWireSchema(item))).toEqual(expectedSchemas[surface.name]);
				expect(request.payload.extensionReplacement).toBe("after");
			}
			const captured = surface.owner.lastEffectiveRequest;
			expect(captured?.profile).toBe(surface.owner.request.kind);
			expect(captured?.tools.map(item => item.name)).toEqual(expectedNames[surface.name]);
			expect(captured?.tools.map(item => item.parameters)).toEqual(expectedWireSchemas[surface.name]);
			const diagnostic = surface.owner.lastEffectiveRequestDiagnostic();
			expect(diagnostic?.profile).toBe(captured?.profile);
			expect(diagnostic?.systemPrompt).toEqual(captured?.systemPrompt);
			expect(diagnostic?.tools).toEqual(captured?.tools);
			expect(diagnostic?.payload).toMatchObject({
				messages: "[redacted]",
				extensionReplacement: "after",
			});
		}
		const continuation = observations[1];
		expect(continuation?.context.messages.some(message => message.role === "assistant")).toBe(true);
		expect(continuation?.context.messages.at(-1)?.role).toBe("user");
	});

	test("rejects a non-object provider request body", () => {
		const owner = RequestProfileOwner.noTools(["side request"]);
		expect(() => owner.captureEffectiveRequest({ provider: "openai", payload: "body" })).toThrow(
			"provider request body must be an object",
		);
	});

	test("keeps interleaved root, Act, and advisor captures request-local", async () => {
		const root = RequestProfileOwner.primary(["root"], ipython);
		const act = RequestProfileOwner.act(["act"], sharedIpython);
		const advisor = RequestProfileOwner.noTools(["advisor"]);
		const requests = [
			Promise.resolve().then(() =>
				root.captureEffectiveRequest({
					provider: "openai",
					payload: { instructions: "root wire", tools: [{ name: "ipython", parameters: CODE_SCHEMA }] },
				}),
			),
			Promise.resolve().then(() =>
				act.captureEffectiveRequest({
					provider: "openai",
					payload: { instructions: "act wire", tools: [{ name: "shared_ipython", parameters: CODE_SCHEMA }] },
				}),
			),
			Promise.resolve().then(() =>
				advisor.captureEffectiveRequest({ provider: "openai", payload: { instructions: "advisor wire" } }),
			),
		];
		await Promise.all(requests);

		expect(root.lastEffectiveRequest).toMatchObject({ systemPrompt: ["root wire"], tools: [{ name: "ipython" }] });
		expect(act.lastEffectiveRequest).toMatchObject({
			systemPrompt: ["act wire"],
			tools: [{ name: "shared_ipython" }],
		});
		expect(advisor.lastEffectiveRequest).toMatchObject({ systemPrompt: ["advisor wire"], tools: [] });
	});

	test("captures the post-extension provider payload and redacts diagnostic messages and credentials", () => {
		const owner = new RequestProfileOwner({
			kind: "primary-ipython",
			systemPrompt: ["final prompt"],
			tools: [ipython],
		});
		owner.captureEffectiveRequest({
			provider: "openai",
			payload: {
				instructions: "wire final prompt",
				messages: [{ role: "user", content: "secret conversation" }],
				api_key: "credential",
				tools: [{ type: "function", function: { name: "ipython", parameters: { type: "object" } } }],
			},
		});
		const diagnostic = owner.lastEffectiveRequestDiagnostic();
		expect(diagnostic?.profile).toBe("primary-ipython");
		expect(diagnostic?.systemPrompt).toEqual(["wire final prompt"]);
		expect(diagnostic?.tools[0]?.name).toBe("ipython");
		expect(JSON.stringify(diagnostic)).not.toContain("secret conversation");
		expect(JSON.stringify(diagnostic)).not.toContain("credential");
		expect(owner.lastEffectiveRequest?.payload).toHaveProperty("api_key", "credential");
	});
});

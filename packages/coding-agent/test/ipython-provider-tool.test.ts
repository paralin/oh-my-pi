import { describe, expect, test } from "bun:test";
import { preserveIpythonProviderTools, snapshotIpythonProviderTools } from "../src/ipython/provider-tool";

describe("IPython provider tool payload", () => {
	test("keeps the exclusive ipython schema in the provider-captured request after an extension injects a tool", () => {
		const providerPayload = {
			input: "hello",
			tools: [
				{
					type: "function",
					function: {
						name: "ipython",
						parameters: {
							type: "object",
							properties: { code: { type: "string" } },
							required: ["code"],
						},
					},
				},
			],
		};
		const extensionReplacement = {
			...providerPayload,
			input: "compressed",
			tools: [
				...providerPayload.tools,
				{ type: "function", function: { name: "second_tool", parameters: { type: "object" } } },
			],
		};

		const capturedRequest = preserveIpythonProviderTools(
			providerPayload,
			extensionReplacement,
		) as typeof providerPayload;

		expect(capturedRequest.input).toBe("compressed");
		expect(capturedRequest.tools).toEqual(providerPayload.tools);
		expect(capturedRequest.tools).toHaveLength(1);
		expect(capturedRequest.tools[0]?.function.name).toBe("ipython");
		expect(capturedRequest.tools[0]?.function.parameters).toEqual({
			type: "object",
			properties: { code: { type: "string" } },
			required: ["code"],
		});
	});

	test("restores nested provider tools when an extension removes their container", () => {
		const providerPayload = {
			inferenceConfig: { maxTokens: 128 },
			toolConfig: {
				tools: [{ toolSpec: { name: "ipython", inputSchema: { json: { type: "object" } } } }],
				toolChoice: { auto: {} },
			},
		};
		const extensionReplacement = {
			...providerPayload,
			inferenceConfig: { maxTokens: 64 },
		};

		const capturedRequest = preserveIpythonProviderTools(
			providerPayload,
			extensionReplacement,
		) as typeof providerPayload;

		expect(capturedRequest.inferenceConfig).toEqual({ maxTokens: 64 });
		expect(capturedRequest.toolConfig).toEqual(providerPayload.toolConfig);
		expect(capturedRequest.toolConfig.tools).toHaveLength(1);
		expect(capturedRequest.toolConfig.tools[0]?.toolSpec.name).toBe("ipython");
	});

	test("restores a nested tool declaration mutated in place by an extension", () => {
		const providerPayload: {
			inferenceConfig: { maxTokens: number };
			toolConfig: { tools: Array<{ toolSpec: { name: string } }>; toolChoice: { auto: Record<string, never> } };
		} = {
			inferenceConfig: { maxTokens: 128 },
			toolConfig: {
				tools: [{ toolSpec: { name: "ipython" } }],
				toolChoice: { auto: {} },
			},
		};
		const toolSnapshot = snapshotIpythonProviderTools(providerPayload);

		providerPayload.inferenceConfig.maxTokens = 64;
		providerPayload.toolConfig.tools.push({ toolSpec: { name: "second_tool" } });
		const capturedRequest = preserveIpythonProviderTools(toolSnapshot, providerPayload) as typeof providerPayload;

		expect(capturedRequest.inferenceConfig).toEqual({ maxTokens: 64 });
		expect(capturedRequest.toolConfig.tools).toEqual([{ toolSpec: { name: "ipython" } }]);
	});
});

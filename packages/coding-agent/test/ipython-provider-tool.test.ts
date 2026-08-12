import { describe, expect, test } from "bun:test";
import {
	createIpythonProviderTool,
	preserveIpythonProviderTools,
	snapshotIpythonProviderTools,
} from "../src/ipython/provider-tool";

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

describe("IPython provider tool validation diagnostic", () => {
	const tool = createIpythonProviderTool(async code => {
		return {
			cellId: "cell-1",
			executionId: "execution-1",
			sequence: 1,
			origin: "model",
			authority: "trusted-cell",
			code,
			status: "ok",
			requestedAt: 0,
			startedAt: 0,
			finishedAt: 1,
			durationMs: 1,
			stdout: "",
			stderr: "",
			result: undefined,
			events: [],
			errors: [],
			updates: [],
			artifacts: [],
			modelText: { text: code, truncated: false, totalBytes: code.length, outputBytes: code.length },
		};
	});

	test.each([
		["malformed JSON", { __parseError: "unrecognized '/'", __rawJson: "/" }, "/"],
		["nonobject", "not-an-object", "not-an-object"],
		["missing code", { other: 1 }, '{"other":1}'],
		["nonstring code", { code: 42 }, '{"code":42}'],
	] as const)("reports the expected shape and received prefix for %s", (_name, args, received) => {
		const diagnostic = tool.formatValidationError?.(args, new Error("schema failure"));
		expect(diagnostic).toBe(
			`Invalid ipython payload; expected {code: string}. Received first ${new TextEncoder().encode(received).byteLength} bytes: ${received}`,
		);
	});

	test("caps the received prefix at 512 bytes on a Unicode boundary and redacts credentials", () => {
		const secret = "sk-super-secret-value";
		const raw = `{"token":"${secret}","value":"${"😀".repeat(200)}"}`;
		const diagnostic = tool.formatValidationError?.({ __parseError: "bad JSON", __rawJson: raw }, new Error());
		expect(diagnostic).toMatch(
			/^Invalid ipython payload; expected \{code: string\}\. Received first \d{1,3} bytes: \{"token":"\[REDACTED\]","value":"/,
		);
		expect(diagnostic).toEndWith("…");
		expect(diagnostic).not.toContain(secret);
		expect(diagnostic).not.toContain("�");
		const prefix = diagnostic?.slice(diagnostic.indexOf(": ", diagnostic.indexOf("bytes")) + 2, -1) ?? "";
		expect(new TextEncoder().encode(prefix).byteLength).toBeLessThanOrEqual(512);
		expect(new TextEncoder().encode(prefix).byteLength).toBeGreaterThan(508);
	});

	test.each([
		["multitoken password", "{password: correct horse battery staple}", "correct horse battery staple"],
		["AWS secret access key", "{aws_secret_access_key: AKIAIOSFODNN7EXAMPLE}", "AKIAIOSFODNN7EXAMPLE"],
		["PEM private key", "{key: -----BEGIN PRIVATE KEY-----abc}", "BEGIN PRIVATE KEY"],
	] as const)("fails closed for malformed %s values", (_name, raw, secret) => {
		const diagnostic = tool.formatValidationError?.({ __parseError: "bad JSON", __rawJson: raw }, new Error());
		expect(diagnostic).toContain("[REDACTED");
		expect(diagnostic).not.toContain(secret);
	});

	test("keeps valid execution and the sole exclusive provider contract unchanged", async () => {
		expect(tool.name).toBe("ipython");
		expect(tool.concurrency).toBe("exclusive");
		const result = await tool.execute("call-1", { code: "print('ok')" });
		expect(result.content).toEqual([{ type: "text", text: "print('ok')" }]);
	});
});

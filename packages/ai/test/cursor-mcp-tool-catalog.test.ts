import { describe, expect, it } from "bun:test";
import { fromBinary } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { buildMcpToolDefinitions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Tool } from "@oh-my-pi/pi-ai/types";

const ipython: Tool = {
	name: "ipython",
	description: "Execute code in the persistent IPython kernel",
	parameters: {
		type: "object",
		properties: { code: { type: "string" } },
		required: ["code"],
	},
};

describe("cursor tool catalog", () => {
	it("advertises the host-provided IPython schema without native-tool filtering", () => {
		const [definition] = buildMcpToolDefinitions([ipython]);

		expect(definition?.name).toBe("ipython");
		expect(definition?.providerIdentifier).toBe("pi-agent");
		expect(definition?.toolName).toBe("ipython");
		expect(fromBinary(ValueSchema, definition!.inputSchema)).toMatchObject({
			kind: {
				case: "structValue",
				value: expect.any(Object),
			},
		});
	});

	it("advertises no tools when the host roster is empty", () => {
		expect(buildMcpToolDefinitions(undefined)).toEqual([]);
	});
});

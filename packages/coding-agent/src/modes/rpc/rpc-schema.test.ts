import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const RPC_TYPES_SHA256 = "c108669860fd582225e949375f6e1b921302ce82d4dcc8341b2ab509efbc6ebd";

describe("RPC wire schema", () => {
	it("matches the Go client's pinned source digest", async () => {
		const source = await readFile(new URL("./rpc-types.ts", import.meta.url));
		const digest = createHash("sha256").update(source).digest("hex");
		expect(digest).toBe(RPC_TYPES_SHA256);
	});
});

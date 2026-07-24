import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const RPC_TYPES_SHA256 = "4b43545604d9f7372353a04a43e04c7f750f0a2b26c1a85d8c8ef80778e7e35c";

describe("RPC wire schema", () => {
	it("matches the Go client's pinned source digest", async () => {
		const source = await readFile(new URL("./rpc-types.ts", import.meta.url));
		const digest = createHash("sha256").update(source).digest("hex");
		expect(digest).toBe(RPC_TYPES_SHA256);
	});
});

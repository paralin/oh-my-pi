import { expect, test } from "bun:test";
import { Client } from "starpc";

test("aborting a streaming call consumes a failed cancel write", async () => {
	const started = Promise.withResolvers<void>();
	const releaseSource = Promise.withResolvers<void>();
	const client = new Client(async () => ({
		source: (async function* () {
			await releaseSource.promise;
			yield new Uint8Array();
		})(),
		sink: async source => {
			for await (const _packet of source) started.resolve();
		},
	}));
	const controller = new AbortController();
	const responses = client.serverStreamingRequest("test.Service", "Watch", new Uint8Array(), controller.signal);
	const iterator = responses[Symbol.asyncIterator]();

	await started.promise;
	controller.abort();
	await expect(iterator.next()).rejects.toThrow("ERR_RPC_ABORT");
	releaseSource.resolve();
});

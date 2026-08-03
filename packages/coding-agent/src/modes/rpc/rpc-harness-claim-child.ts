import { RpcHarnessSessionOwner } from "./rpc-harness";

try {
	const owner = await RpcHarnessSessionOwner.open(
		process.env.RPC_SESSION_ID ?? "",
		process.env.RPC_RECORD_FILE ?? "",
		undefined,
		process.env.RPC_RUN_INDEX_FILE ?? "",
	);
	const result = await owner.bindRun(process.env.RPC_RUN_ID ?? "run-1");
	console.log(JSON.stringify({ ok: true, existing: result.existing, sessionId: result.sessionId }));
	await Bun.sleep(200);
	await owner.dispose();
} catch (error) {
	console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}

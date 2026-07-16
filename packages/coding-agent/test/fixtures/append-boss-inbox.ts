import { appendSessionBossInboxMessage } from "../../src/session/boss-inbox";

const [sessionFile, id, message] = Bun.argv.slice(2);
if (!sessionFile || !id || !message) throw new Error("session file, id, and message are required");

await appendSessionBossInboxMessage(sessionFile, {
	id,
	now: new Date("2026-07-15T12:00:00.000Z"),
	sessionId: "child-session",
	from: "ChildWorker",
	kind: "status",
	message,
});

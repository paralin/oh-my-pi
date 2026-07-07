Send and receive short text messages between agents. When the session was
started with `--boss-inbox`, `op: "send"` to `to: "boss"` writes a durable
question, status, or finding for the managing boss and returns immediately; the
boss answers through normal steering, not through a second reply channel.

# Addressing and Discovery
The main in-process agent is always `Main`. Subagents inherit their task ID (e.g., `AuthLoader`). If you don't know who is currently running, use `op: "list"` to view all peers alongside their status, unread count, and recent activity. Address peers by their exact ID from the roster; use `boss` only for the out-of-process boss inbox when enabled.

# Messaging Rules
Use `op: "send"` to deliver a message to a specific peer, broadcast to `"all"`,
or write to the boss inbox with `to: "boss"` when enabled.
- **Fire and forget:** Sending NEVER blocks. You get delivery receipts immediately (`delivered`, `queued`, or `failed`). Do not wait around—send your message and keep working. If a receipt says `failed`, the peer is gone or the boss inbox was not enabled; do not retry until the configuration changes.
- **Waking peers:** Sending a message to an `idle` or `parked` agent automatically wakes them up.
- **Answering:** When replying to a question, use `op: "send"`, lead directly with your answer (NEVER quote the original message), and set `replyTo` so the recipient can correlate it.
- **Format:** Messages MUST be plain prose. NEVER send JSON status objects. Keep it terse and share paths via `local://` or `artifact://` URLs, not pasted blobs.
- **Boss inbox kind:** For `to: "boss"`, set `kind` to `question`, `status`, or `finding`. Keep the message plain prose; do not set `await`.

# Waiting and Inboxes
Messages only arrive when the peer actively sends one—do not interrogate a peer for status.
- If you are completely blocked and MUST wait for an answer, use `op: "wait"` (or `await: true` on a send). The wait returns when a matching message arrives, the timeout elapses, or any IRC / steering message interrupts the wait. Parent-agent IRC interrupts with steering-level priority.
- No need to alternate `irc wait`, `irc inbox`, and `job poll`: waits surface cross-channel interrupts promptly. The next turn includes the interrupt reason and message.
- To check for messages without blocking, use `op: "inbox"` to drain your queue.

# When to Coordinate
Message peers instead of guessing, duplicating work, or spying.
- Use IRC when you hit an unexpected state (e.g., missing files) or an out-of-scope decision. DM `Main` or your spawner for guidance.
- If you overlap with another agent's work or need a file they are touching, DM them before editing.
- NEVER use shell tools, grep, or read other sessions' files to figure out what a peer is doing. Message them directly.
- NEVER use IRC for something a tool can answer (e.g., grepping codebase, running a build).

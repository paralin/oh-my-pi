# RPC Protocol Reference

`omp --mode rpc` is an NDJSON server. The client writes one JSON object per line
to stdin. OMP writes one JSON object per line to stdout. A request id is echoed
in its response; asynchronous session and agent events do not require an id.

The server starts by emitting:

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}
```

Use `negotiate_protocol` before relying on version-2 durable-session commands.
The server enforces its advertised frame and reassembly byte limits. Clients
must treat malformed, oversized, or unknown frames as failures rather than
assuming local fallback behavior.

## Commands

Each command is `{ "id"?, "type": "..." }`. Successful responses have
`{ "type": "response", "command": "...", "success": true }`; failures set
`success` to `false` and include `error` and, when available, `code`.

| Group | Commands |
| --- | --- |
| Protocol | `negotiate_protocol` |
| Prompting | `prompt`, `steer`, `follow_up`, `abort`, `abort_and_prompt`, `new_session` |
| Durable session | `session.start`, `session.resume`, `session.replay`, `session.result`, `session.steer`, `session.watch` |
| State | `get_state`, `set_fast_mode`, `get_available_commands`, `set_todos`, `set_subagent_subscription`, `get_subagents`, `get_subagent_messages` |
| Model and thinking | `set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `cycle_thinking_level` |
| Queue and retry | `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `set_auto_retry`, `abort_retry` |
| Compaction | `compact`, `set_auto_compaction` |
| Session | `get_session_stats`, `export_html`, `switch_session`, `branch`, `get_branch_messages`, `get_last_assistant_text`, `set_session_name`, `handoff` |
| Messages | `get_messages`, `get_messages_page` |
| Login | `get_login_providers`, `login` |

`prompt` accepts `message`, optional images, and optional
`streamingBehavior` (`steer` or `followUp`). `steer` and `follow_up` add work
to the active session according to its queue policy. `abort_and_prompt` first
cancels the active run, then starts the supplied prompt.

## Events and durable custody

OMP publishes normal agent and session events while work runs. Version 2 adds a
durable ledger: `session.start` claims a `run_id`, `session.resume` reattaches
it, and `session.replay` or `session.watch` returns ordered events after an
optional sequence. The terminal `session_terminal` event and `session.result`
carry the outcome, stop reason, final message, usage, result id, and terminal
sequence.

Subagent clients can select `off`, `progress`, or `events` subscriptions. OMP
then emits `subagent_lifecycle`, `subagent_progress`, and `subagent_event`
frames as appropriate. `available_commands_update` publishes command metadata
when it changes.

## Extension UI

When an extension needs host UI, OMP emits `extension_ui_request`. The request
may ask the client to select, confirm, collect input, open an editor, notify,
set status or a widget, set the title or editor text, or open a URL. Reply with
an `extension_ui_response` carrying the request id and the value, confirmation,
or cancellation shape for that method. Closing stdin rejects outstanding UI
requests, disposes the session, and exits cleanly.

## Provider boundary

RPC controls an OMP session; it does not add functions to the model. The session
always exposes the fixed `ipython` provider interface. Model work and
host-owned operations follow the typed Python boundary described in
[Persistent IPython runtime](./ipython.md).

## Minimal exchange

```text
< {"type":"ready",...}
> {"id":"p1","type":"prompt","message":"Inspect this repository"}
< {"id":"p1","type":"response","command":"prompt","success":true,...}
< {"type":"agent_start",...}
< {"type":"ipython_cell_start",...}
< {"type":"ipython_cell_end",...}
< {"type":"agent_end",...}
```

Use `get_state` to inspect the selected model, queue modes, session identity,
usage, and current provider interface description. Use `get_messages_page` for
bounded transcript paging instead of assuming every transcript is returned in
one frame.

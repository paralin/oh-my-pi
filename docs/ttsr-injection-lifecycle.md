# TTSR Injection Lifecycle

TTSR interrupts or reminds on a regex match in assistant text, thinking, or a
serialized IPython code stream.

## Registration

At session creation, `createAgentSession()` discovers rules and passes them to
`bucketRules(...)` with `ttsr.builtinRules` and `ttsr.disabledRules`. Rules with
a usable regex `condition` register in `TtsrManager`; others remain always-apply
or rulebook rules when their metadata permits it. Invalid regex conditions are
skipped, and duplicate names are first-wins before registration.

The manager buffers stream chunks by source. Text and thinking have one buffer
each; every IPython call has its own `streamKey` buffer. A rule scope may select
`text`, `thinking`, `tool`, or `tool:ipython`; path-qualified tool scopes are not
valid.

## Streaming

On `turn_start`, the coordinator clears TTSR buffers. During `message_update`,
it sends text and thinking deltas to the manager. For a `toolcall_delta`, it
looks up the call block and ignores the delta unless its name is `ipython`.
Matching IPython chunks use `{ source: "tool", toolName: "ipython", streamKey }`.

A match is deduplicated, records its injection state, and follows the configured
`interruptMode`. Interrupting matches abort the current turn, render
`ttsr-interrupt.md`, persist a `ttsr_injection` entry, and retry. Non-interrupting
IPython matches prepend `ttsr-tool-reminder.md` to that IPython result;
non-interrupting text and thinking matches queue the same guidance after the
assistant message completes.

The persisted injection names are restored when a session resumes. `repeatMode`
and `repeatGap` decide whether a previously injected rule may match again.

## Limits

TTSR is stream regex matching only. It does not inspect paths, scan files, parse
ASTs, or run post-edit semantic or project-reference analysis. The runtime's
only code-tool stream is IPython.

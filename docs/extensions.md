# Extensions

Extensions are host-side packages that add prompt context, commands, rules,
skills, session observation, and UI behavior. They run in the OMP process and
must treat their inputs as untrusted session data.

## Provider boundary

Extensions do not register provider-callable functions. Every model receives
the fixed `ipython` interface. Reusable model workflows belong in Python skill
packages. Operations that need process state, credentials, browser or computer
resources, MCP connections, or external authority belong behind typed host
handlers exposed through `omp.*` modules.

## Lifecycle and UI

Extensions can observe session and prompt lifecycle events, add slash commands,
and request UI through the extension UI context. In RPC mode, UI requests are
sent as `extension_ui_request` frames and the client supplies the matching
response. Extension UI is optional: an extension must work correctly when no
interactive UI is available.

Persist extension state as namespaced session entries. Rebuild it from the
session branch at startup rather than retaining module globals across sessions.
Do not store credentials or opaque host handles in provider-visible prompt
content.

See [Persistent IPython runtime](./ipython.md) for the supported model and host
capability boundary, and [Skills](./skills.md) for reusable Python workflows.

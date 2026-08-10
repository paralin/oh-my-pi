# Hooks

Hooks are compatibility extension entry points. `--hook` paths are merged with
`--extension` paths, and discovered JS/TS hook factories load through the
extension runtime. A hook registers lifecycle handlers with `pi.on(...)` and
may add slash commands or use the supported UI context.

Hooks do not register provider functions or wrap host operations. Every model
receives the fixed `ipython` interface. Use a Python skill for a reusable model
workflow, or a typed `omp.*` host handler for an operation that needs host
state, credentials, or external authority.

`tool_call` and `tool_result` remain available only for the fixed IPython cell.
Both events have `toolName: "ipython"` and `input: { code: string }`.
`tool_call` can block or replace the cell code; `tool_result` can replace its
content, details, or error status. Lifecycle, UI, and slash-command behavior is
otherwise the ordinary extension behavior described in
[Extensions](./extensions.md).

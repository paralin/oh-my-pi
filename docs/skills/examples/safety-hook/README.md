# safety-hook

An `oh-my-pi` extension that demonstrates whole-cell `tool_call` blocking. It inspects the sole `ipython` call's `code` string and returns `{ block: true, reason: "..." }` when a cell contains the literal destructive shell command `rm -rf /`.

## What it demonstrates

- `pi.on("tool_call", ...)` — pre-cell interception
- `event.input.code` — the complete IPython cell
- `return { block: true, reason: "..." }` — blocking contract

## Install

```
cp -r . ~/.omp/agent/extensions/safety-hook
```

Restart `omp`, or load it once with `omp --extension ./safety-hook`.

The reason is returned as the cell error so the model can choose a safe action.

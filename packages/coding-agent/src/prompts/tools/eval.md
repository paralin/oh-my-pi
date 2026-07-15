Run one step of code in a persistent kernel. State persists across calls and subagents.

Work incrementally: imports → define → test → use, each its own cell. Re-run setup ONLY after `reset`, kernel crash.
Parallelize *within* a cell with `parallel(thunks)`, not by batching.

{{#if py}}Top-level `await` works; `asyncio.run(…)` raises error.{{/if}}
{{#if js}}JS runs under **Bun**: globals (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`) available; top-level `await`/`return` work.{{/if}}

On error, fix and re-run only the failing step.

<prelude>
{{#ifAll py js}}Python: sync, kwargs. JS: async, ONE trailing object literal, never positional.{{else}}{{#if py}}Sync; kwargs.{{/if}}{{#if js}}Async; ONE trailing object literal, never positional.{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, kwargs.{{/if}}{{#if jl}} Julia: sync, kwargs.{{/if}}
```
display(value) → None        print(value, ...) → None
read(path, offset?=1, limit?=None) → str
write(path, content) → str
env(key?=None, value?=None) → str | None | dict
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
tool.<name>(args) → unknown
completion(prompt, model?="default"|"smol"|"slow", system?=None, schema?=None) → str | dict
{{#if spawns}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, schema?=None, handle?=False) → str | dict{{#if spawnAllowedAgentsText}}  Allowed: {{spawnAllowedAgentsText}}.{{/if}}
{{#if js}}    JS: agent(prompt, { agent, schema, handle }).{{/if}}
{{/if}}
parallel(thunks) → list     pipeline(items, ...stages) → list
log(message) → None         phase(title) → None
budget → {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()`{{/if}}{{#if js}}`await budget.total()`, `await budget.spent()`, `await budget.remaining()`{{/if}}{{#if rb}}`budget.total`, `budget.spent`, `budget.remaining`{{/if}}{{#if jl}}`budget.total`, `budget.spent()`, `budget.remaining()`{{/if}}; ceiling `+Nk` advisory, `+Nk!` hard.
    Use `completion()` with the `"smol"` model for cheap per-item lookup/classification.
```
</prelude>
{{#if spawns}}
<dag>
Acyclic waves via `agent(…, handle=true)` + `pipeline`/`parallel`:
- **Right-size nodes.** Each `agent()` pays full cache/context startup. One large node beats per-file, per-function, or per-item nodes; parallel agents require independent, substantial workstreams.
- **Name nodes.** Capture agent result → `handle` (`agent://<id>`) + `output`.
- **Wire edges.** Put upstream `handle`/`output` in downstream prompt. Bulk: `write("local://<name>.md", …)`.
- **`pipeline`** = staged waves, barrier between stages. **`parallel`** = one wave.
- **Isolate failure.** Wrap risky nodes in try/except; a failure degrades only its subtree.
- **Acyclic only.** No node waits on its own descendant.
</dag>
{{/if}}

<critical>
Prior top-level names survive into the next cell — reuse; NEVER re-import/re-declare. Re-read only if file changed since last read.
</critical>

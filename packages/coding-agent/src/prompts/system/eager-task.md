<system-reminder>
Task delegation is enabled — subagents are the default for this request.

Explore and settle the approach FIRST — scoping, top-level decomposition, and cross-slice contracts are YOUR job; NEVER spawn a subagent to produce the overall plan. Once the design is settled, you MUST delegate nontrivial work through `{{toolRefs.task}}`. Prefer ONE capable subagent carrying the largest coherent assignment; NEVER split related work by file, function, or item.{{#if taskBatch}} Spawn multiple subagents only for independent, substantial workstreams, then dispatch them in ONE parallel `{{toolRefs.task}}` call.{{/if}}

Each spawn pays fixed cache/context cost. Minimize spawn count.

Work alone for: a single-file edit under ~30 lines, a direct answer requiring no code changes, a command the user explicitly asked you to run, or when only ONE runnable slice exists — a lone subagent is a lossy handoff, not parallelism.
</system-reminder>

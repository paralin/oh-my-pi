<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic delegated workflow. Prefer ONE capable `task` subagent carrying a large, complete assignment. Use parallel subagents only when workstreams are truly independent AND each is substantial. Every spawn pays fixed cache/context cost, so the smallest sufficient fan-out is usually cheaper and better.

<when>
Worth it when one substantial subagent benefits from isolated context/tool work, or when several independent substantial workstreams need parallel coverage. Related files, functions, dimensions, and migration sites belong together. Common shapes:
- **Understand** — one reader maps related subsystems; split only independent roots.
- **Design** — one primary design; add an independent critique only for substantial stakes.
- **Review** — one reviewer covers related dimensions; split only independent domains.
- **Research** — one broad sweep → deep-read hits → synthesize.
- **Migrate** — one owner per independent subsystem, NEVER per site.
</when>

<task-contract>
{{#if taskBatch}}
Call `task` once for the smallest sufficient batch of substantial workstreams. Put shared background in `context`, and put each independent workstream in `tasks[]`. Do not emulate batching with shell loops or eval helper APIs.

- `agent(prompt, *, agent="task", model=None, label=None, schema=None, isolated=None, apply=None, merge=None, handle=False)` — run ONE subagent; returns its final text, or the validated object when `schema` (a JSON Schema dict) is given. With `schema` the subagent is forced to emit structured output that is validated for you — branch on the object, not on parsed prose. `agent` picks a discovered agent ("scout", "reviewer", …); `label` names the artifact. Shared background goes in a `local://` file referenced from each prompt, not a parameter. Subagents are told their final text IS the return value, so they hand back raw data. `agent()` blocks until the subagent finishes. Recursion follows `task.maxRecursionDepth` (default 2; a negative value disables the cap): main agent depth = 0, each `agent()` child increments depth by 1, and, when the cap is non-negative, a spawner may call `agent()` only while its current `taskDepth < cap`. Pass `isolated=True` to run the spawn in a copy-on-write worktree so parallel `agent()` calls can edit overlapping files safely — strict opt-in, mirrors the `task` tool, defaults off regardless of `task.isolation.mode`; `isolated=True` while the setting is `"none"` errors out instead of silently downgrading. With isolation, `apply=False` keeps changes in the worktree, and `merge=False` forces patch mode even when the setting is `"branch"`. Captured root patch path, branch name, nested repo patches, and apply summary reach the workflow through `handle=True` — combine it with `apply=False` (or `apply=False, schema=…`) and read `node["patch_path"]`, `node["branch_name"]`, `node["nested_patches"]`, `node["changes_applied"]`, `node["isolation_summary"]` (JS: same keys camelCased) to recover artifacts.
- `parallel(thunks)` — run zero-arg callables concurrently through a bounded pool, preserving input order; returns once all finish. The pool is bounded by the session's `task` concurrency — don't hand-tune it; fan out as wide as the work divides. A thunk that raises propagates — wrap risky work in `try/except` inside the thunk to keep partial results. In a loop, bind each closure's value with a default arg (`lambda d=d: …`) or every thunk captures the last one.
- `pipeline(items, *stages)` — map items through `stages` left-to-right. There is a BARRIER between stages: ALL items clear stage N before stage N+1 begins. Each stage is a one-arg callable; stage 1 gets the original item, later stages get the previous result. Same pool width as `parallel()`.
- `completion(prompt, *, model="default", system=None, schema=None)` — oneshot, stateless model call (no tools, no history). Tiers: "smol", "default", "slow". Cheap classification/scoring inside a fan-out.
- `log(message)` — emit a progress line above the status tree. `phase(title)` — start a phase; the status lines that follow group under it.
- `budget` — `budget.total` (output-token ceiling, or `None` when none is set), `budget.spent()` (tokens spent this turn — main loop + eval subagents), `budget.remaining()` (`math.inf` when total is `None`), `budget.hard` (whether it's enforced). A ceiling is set by the user: `+Nk` in their message is advisory (you self-limit via `budget.remaining()`), `+Nk!` (or Goal Mode) is hard — `agent()` refuses to spawn once spent reaches it. Gate loops on `budget.total` first, since it's `None` when the user set no budget.

    # Goal
    What the batch accomplishes.
    # Constraints
    Rules, non-goals, permissions, and verification limits.
    # Contract
    Shared interfaces, output shape, branch/base assumptions, and coordination rules.

Each task assignment must be complete and substantial:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    What to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.
{{else}}
Call `task` once per substantial workstream only when batch calls are disabled. Put the full shared background and the complete workstream in that call's `assignment`. Do not pass `context` or `tasks[]`: the flat task schema rejects them when batch calls are disabled.

Each assignment must be complete and substantial:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    Shared background plus what to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.
{{/if}}

<structure>
Decompose into the smallest number of large, complete workstreams, then {{#if taskBatch}}batch the independent workstreams{{else}}issue one task call per independent workstream in the same turn{{/if}}:

**Python (`eval`, Python backend):**

{{#if taskBatch}}Prefer one task. Multiple truly independent, substantial workstreams SHOULD use the smallest sufficient batch. If assignments overlap, merge them or name the overlap and coordinate through IRC.{{else}}Prefer one task. Dispatch multiple calls in the same turn only for truly independent, substantial workstreams. If assignments overlap, merge them or name the overlap and coordinate through IRC.{{/if}}
</structure>

<patterns>
- **Adversarial verify** — add a separate skeptical reviewer only when stakes justify a full second context.
- **Perspective-diverse review** — one reviewer covers related dimensions unless independent domains each warrant deep review.
- **Completeness critic** — for broad high-risk work, one critic checks missed modality, file, claim, or proof.
- **No silent caps** — if you bound coverage (top-N, no retry, sampling), state what was dropped and why before acting.
- **Parent owns closure** — subagents return evidence; the parent reads it, resolves contradictions, runs proof, and makes the final decision.
</patterns>
<execution>
- Capture multi-phase workflow state in the visible todo system when available.
{{#if taskBatch}}- Dispatch the smallest sufficient batch of substantial subagents.{{else}}- Dispatch the smallest sufficient set of substantial subagents.{{/if}}
- Give every subagent a large, complete target, explicit non-goals, and a concrete return packet.
- After delegated work returns, read the artifacts, patch or decide, and run the shared gate.
- Keep going until the task is closed — delegation is a step, not a stopping point.
</execution>
</system-notice>

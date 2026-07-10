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

`context` must carry the shared contract:

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

{{#if taskBatch}}
    task(
      context: "# Goal\nReview the auth diff…\n# Constraints\nRead-only…\n# Contract\nReturn findings as severity/file/line/fix…",
      tasks: [
        { id: "AuthOwner", role: "Auth Storage Reviewer", assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\nTrace credential selection…\n# Acceptance\nReturn confirmed findings only…" },
        { id: "PromptOwner", role: "Prompt Contract Reviewer", assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\nCheck active-tool guidance…\n# Acceptance\nReturn mismatches and exact prompt lines…" },
      ]
    )
{{else}}
    task(
      role: "Auth Storage Reviewer",
      assignment: "# Target\npackages/ai/src/auth-storage.ts\n# Change\nReview the auth diff. Shared contract: read-only; return findings as severity/file/line/fix.\n# Acceptance\nReturn confirmed findings only…"
    )
    task(
      role: "Prompt Contract Reviewer",
      assignment: "# Target\npackages/coding-agent/src/prompts/**\n# Change\nCheck active-tool guidance. Shared contract: read-only; return mismatches and exact prompt lines.\n# Acceptance\nReturn confirmed findings only…"
    )
{{/if}}

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

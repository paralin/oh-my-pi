{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.
Execution does not block — you receive IDs immediately; results deliver when subagents finish.{{else}}Delegate work to ONE background subagent per call.
Execution does not block — you receive an ID immediately; the result delivers when the subagent finishes.{{/if}}{{#if hasBlockingAgents}}
Agents marked BLOCKING run inline — results return in this call; non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch. Execution blocks until all work finishes.{{else}}Run ONE subagent synchronously. Execution blocks until work finishes.{{/if}}{{/if}}

# Delegation Strategy
- **Agent typing:** Choose each item's `agent` type first. Read-only research MUST use `agent: "scout"`, which runs on a faster model. Use the default worker only when no listed specialist fits.
- **Prefer one substantial task:** Give one capable subagent a large, complete assignment. Batch related files, functions, and items together; NEVER spawn per-file, per-function, or per-item agents.
- **Pay startup cost once:** Every spawn pays fixed cache/context cost. N small agents cost roughly N times one large agent doing the same total work.
- **Parallelize selectively:** Spawn multiple subagents only when workstreams are truly independent AND each is substantial. Different files alone do not justify separate agents.
- **Diverse verify, not retry:** a second agent on the same work is justified only as an engineered-diversity check — different lens, evidence set, or model on a high-regret result — never the same assignment sampled twice.
{{#when MAX_CONCURRENCY ">" 0}}
- **Concurrency cap:** At most {{pluralize MAX_CONCURRENCY "subagent" "subagents"}} run at once in this session — anything beyond that just queues. After right-sizing the work, keep any justified fan-out at or under the cap.
{{/when}}
- **Sequence dependencies:** After right-sizing tasks, serialize only when one subagent needs another's output (e.g. a core API contract or schema migration).
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent `hub` messages are delivered immediately as steering; subagents blocked in `hub` wait do not need to poll separately for them.{{/if}}
- **Role matching:** Assign each subagent a specific `role` (e.g. "Security Reviewer", "DB Migrator"). Do not spawn generic workers.
- **No overhead:** Each assignment MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in a single pass; only spin a read-only discovery step (e.g. `agent: "scout"`) when the affected files are genuinely unknown.
- **Parent owns closure:** subagents return evidence; you read it, resolve contradictions, run the shared proof once, and decide. Size fan-out to your review budget.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state for the entire batch — don't duplicate into individual tasks.
- `tasks[]`: Subagents to spawn.
  - `name`: CamelCase ≤32 chars (auto-generated if omitted).
  - `agent`: specialist type (optional).
  - `task`: Complete, self-contained instructions — no one-liners, no missing acceptance criteria.
{{#if isolationEnabled}}
  - `isolated`: Run in dedicated worktree, return patches. Destroyed on completion, cannot be addressed afterward.
{{/if}}
{{else}}
- `name`: CamelCase ≤32 chars (auto-generated if omitted).
- `agent`: specialist type (optional).
- `task`: Complete, self-contained instructions — no one-liners, no missing acceptance criteria.
{{#if isolationEnabled}}
- `isolated`: Run in dedicated worktree, return patches.
{{/if}}
{{/if}}

# Communication
Subagents start blank — no conversation history.{{#if ircEnabled}} Parent-to-subagent IRC delivered immediately as steering.{{/if}}
Pass large payloads via `local://<path>` URIs, NEVER inline text.

# Format Contracts
{{#if batchEnabled}}
`context` format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

`task` format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific agent; use default worker only when no specialist fits.
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY){{/if}}{{#if blocking}} (BLOCKING: inline result){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation; do edits yourself or assign to a writing agent.{{/if}}
{{/list}}
{{/if}}

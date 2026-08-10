Scratch continuity:
- Path: `{{displayPath}}`; session: `{{sessionId}}`. {{#if exists}}Current contents already supplied as continuation state.{{else}}File not created yet; create it only when closeout requests a checkpoint.{{/if}}
- Continue as if no reset occurred. Scratch maintenance stays internal; NEVER report it as task progress or evidence unless user asks.
- Scratch = bounded current-state checkpoint, not session history or artifact dump.
- Keep exactly one root `* TODO` current-work subtree. Put future work under `** TODO`; completed history belongs in linked plans, logs, or artifacts.
- Root TODO MUST contain: Objective, minimal current Skill stack, Work completed, Files changed, Verification, Blockers or risks, Next action, Source refs.
- Skill stack: only dependencies needed by current TODO or next executable action, original relative order. Remove historical, completed-phase, one-shot, stale, superseded, duplicate skills. Empty allowed.
- Resume: select skills from current TODO + next action. Load only first executable step's needed skill; apply normal matching for newly relevant skills. NEVER replay full stack or restart orientation.
- Update only on explicit closeout/handoff, except substantial completed work plus substantial remaining work under likely context pressure.
- Update existing root TODO in place; no duplicate status blocks. Link large evidence rather than copying it.
- Child TODO blocks parent completion unless explicitly deferred with owner, blocker, next action, return condition, source refs.
- Verification = current proof + residual risk, not command transcript.
- Scratch owns task tracking; do not duplicate it in `omp.harness.todo`.
- Keep `#+TITLE`, `#+SESSION`, `#+PATH`, optional `#+PARENT_SCRATCH` as root keywords; no wrapper heading.
{{#if parentDisplayPath}}- Parent scratch: `{{parentDisplayPath}}`. Link when needed; NEVER write child state into parent.{{/if}}
- No update needed? Leave unchanged. NEVER mention scratch state/path in final response unless asked.

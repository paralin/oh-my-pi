Manage the active goal-mode objective.

Use a single `op` field:
- `set` starts goal mode when no goal exists, or replaces the active goal. Requires `objective`; optional `token_budget` must be positive.
- `create` starts a goal. Requires `objective`; optional `token_budget` must be positive. Use only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

Set a goal by its objective and keep working until it is done and verified. The
token budget is an operator setting, not yours to size or cap.
NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal and you intend to continue that same goal, call `resume` before continuing work on it.

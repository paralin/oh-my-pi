Manage active goal-mode objective.

Single `op` field:
- `set`: starts goal mode when no goal exists, or replaces an active or paused goal with a fresh active goal. Requires `objective`.
- `create`: starts goal; enables goal mode. Requires `objective`. Only when no goal exists and none is paused.
- `get`: returns current active/paused goal.
- `resume`: re-activates paused goal for continued work.
- `complete`: marks goal complete only when actually done and every deliverable verified against current evidence. NEVER because budget low or turn ending.
- `drop`: discards current goal without completing it.

The token budget is an operator setting, not yours to size or cap; there is no budget parameter.
If `get` shows a paused goal and you intend to continue it, call `resume` before continuing work.

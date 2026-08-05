---
description: "Keep Go control flow flat after an early return"
scope:
  - "tool:edit(*.go)"
  - "tool:write(*.go)"
interruptMode: never
semanticCondition:
  - candidate:
      ast: "if $COND { $$$BODY return $$$RESULT } else { $$$ELSE }"
---
After an early return, continue at the outer level instead of wrapping the remaining path in `else`. Keep getters and simple projections direct; do not destructure or add narration merely to rename values that already have a clear owner. The exact owner split and multi-action paragraph quality still require review when source evidence cannot decide them.

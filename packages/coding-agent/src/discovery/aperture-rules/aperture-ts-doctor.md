---
description: "Give React Doctor suppressions a local reason"
scope:
  - "tool:edit(*.ts)"
  - "tool:edit(*.tsx)"
  - "tool:write(*.ts)"
  - "tool:write(*.tsx)"
interruptMode: never
semanticCondition:
  candidate:
    regex: "(?im)^(?![^\\n]*\\s--\\s\\S)\\s*//\\s*eslint-disable(?:-next-line)?[^\\n]*(?:no-giant-component|rerender-state-only-in-handlers|async-await-in-loop)[^\\n]*$"
---

Resolve React Doctor findings in the component or resource that implements the behavior. When the rule is wrong for the local contract, keep a narrow suppression and state the reason after `--` on the same line.

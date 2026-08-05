---
description: "Keep async work out of React effect callbacks"
scope:
  - "tool:edit(*.ts)"
  - "tool:edit(*.tsx)"
  - "tool:write(*.ts)"
  - "tool:write(*.tsx)"
interruptMode: never
semanticCondition:
  - candidate:
      ast: "useEffect(async () => { $$$BODY }, $DEPS)"
  - candidate:
      ast: "React.useEffect(async () => { $$$BODY }, $DEPS)"
---

React effect callbacks cannot return a promise. Put async data in the component that provides the resource or subscription, then consume it through the matching hook. Keep DOM-only synchronization in a synchronous effect with an inner task when needed.

Hook selection, abort-signal forwarding, and timer lifecycle require local API and data-flow evidence and remain review checks.

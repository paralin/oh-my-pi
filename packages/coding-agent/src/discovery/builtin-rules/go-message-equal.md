---
description: "Call generated EqualVT directly instead of wrapping it"
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    codeRegex: '(?ms)^func\s+(?<NAME>[a-z]\w*)\s*\([^)]*\)\s+bool\s*\{\s*return\s+[A-Za-z_]\w*\.EqualVT\([^)]*\)\s*\}'
---

Generated `EqualVT` methods already implement typed message equality. Call the method directly instead of adding a helper whose complete body forwards to `EqualVT`.

Keep a helper when it clears fields, compares through an interface, or implements another domain equality contract. Those effects are absent from this exact candidate.

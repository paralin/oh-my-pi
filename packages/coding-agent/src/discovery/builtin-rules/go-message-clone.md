---
description: "Call generated CloneVT directly instead of wrapping its nil-safe behavior"
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    codeRegex: '(?ms)^func\s+(?<NAME>[a-z]\w*)\s*\(\s*(?<V>\w+)\s+\*(?<T>\w+)\s*\)\s+\*\k<T>\s*\{\s*if\s+\k<V>\s*==\s*nil\s*\{\s*return\s+nil\s*\}\s*return\s+\k<V>\.CloneVT\(\)\s*\}'
---

Generated `CloneVT` methods already handle a nil pointer receiver. Call the method directly rather than adding a helper that checks nil and returns `CloneVT`.

```go
next := decision.CloneVT()
```

Keep a wrapper when it clears fields, performs other policy work, or must clone through an interface the generator cannot see. Those effects are not present in the exact wrapper candidate and remain outside this rule.

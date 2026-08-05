---
description: "Use slices.Clone or bytes.Clone instead of append-based slice copies"
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    ast: "append([]$T(nil), $S...)"
---

Use `slices.Clone` for ordinary slices and `bytes.Clone` for byte slices instead of the legacy `append([]T(nil), values...)` copy.

```go
keys := slices.Clone(source)
data := bytes.Clone(raw)
```

The `append` form is only equivalent when the caller wants a distinct backing array with the same elements. Keep it when preserving a deliberate capacity, aliasing, or nil-versus-empty distinction is part of the contract; those requirements are not decidable from this expression alone.

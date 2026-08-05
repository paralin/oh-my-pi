---
description: "Do not extract one-return unexported Go helpers that only wrap an expression"
scope: "tool:edit(*.go), tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    ast: "func $NAME($$$ARGS) $RET { return $VALUE }"
  captures:
    NAME:
      regex: "^[a-z_$]"
      notRegex: "^(?:new|mock|stub|test)[A-Z_a-z0-9]"
  references:
    capture: NAME
    min: 1
    max: 1
---

Do not extract an unexported function whose entire body is one return expression. The semantic matcher reports a changed helper only when it has exactly one project call site; two or more call sites are a canonical local exception. Inline the wrapper unless the name carries a durable contract or the function is an intentional seam.

## Avoid

```go
func normalizeID(id string) string { return strings.TrimSpace(id) }
```

## Use

```go
id := strings.TrimSpace(rawID)
```


## Allowed exceptions

- An exported identifier is a package API and is not a local helper.
- Constructors (`New...`) and test seams (`mock...`, `stub...`, `test...`) are intentionally named boundaries.
- An interface method, callback value, or dependency-injection seam may need a function-shaped contract.
- A helper with two or more call sites, a non-obvious formula, or behavior beyond one return earns its name.

The matcher excludes common constructor and test-seam names and rejects helpers with two or more references. Whether a function is an interface method, callback, or dependency-injection seam is not available from this candidate and remains review-only.

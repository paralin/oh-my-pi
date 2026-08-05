---
description: "Use package error primitives instead of fmt.Errorf"
scope:
  - "tool:edit(*.go)"
  - "tool:write(*.go)"
interruptMode: never
semanticCondition:
  - candidate:
      codeRegex: '\bfmt\.Errorf\s*\('
  - candidate:
      codeRegex: '\berrors\.Wrap\s*\(\s*context\.Canceled\b'
---

Use the package error primitives for the contract. Prefer `errors.New` for sentinels and simple errors, and use `errors.Errorf` or `errors.Wrap` for formatted context. Return `context.Canceled` directly so callers preserve cancellation identity.

Sentinel placement and identifier-first documentation require file and comment evidence beyond this candidate and remain review checks.

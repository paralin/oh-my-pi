---
description: "Do not extract 1-2 line functions that only wrap an expression — inline them"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
semanticCondition:
  - candidate:
      ast: "function $NAME($$$ARGS) { return $VALUE }"
    captures:
      NAME:
        regex: "^[a-z_$]"
    file:
      forbidden:
        regex: "(?im)generated (?:code|file)|DO NOT EDIT"
    references:
      capture: NAME
      min: 1
      max: 2
  - candidate:
      ast: "const $NAME = ($$$ARGS) => $VALUE"
    captures:
      NAME:
        regex: "^[a-z_$]"
    file:
      forbidden:
        regex: "(?im)generated (?:code|file)|DO NOT EDIT"
    references:
      capture: NAME
      min: 1
      max: 2
  - candidate:
      ast: "const $NAME = ($$$ARGS) => { return $VALUE }"
    captures:
      NAME:
        regex: "^[a-z_$]"
    file:
      forbidden:
        regex: "(?im)generated (?:code|file)|DO NOT EDIT"
    references:
      capture: NAME
      min: 1
      max: 2
  - candidate:
      ast: "const $NAME = $ARG => $VALUE"
    captures:
      NAME:
        regex: "^[a-z_$]"
    file:
      forbidden:
        regex: "(?im)generated (?:code|file)|DO NOT EDIT"
    references:
      capture: NAME
      min: 1
      max: 2
  - candidate:
      ast: "const $NAME = $ARG => { return $VALUE }"
    captures:
      NAME:
        regex: "^[a-z_$]"
    file:
      forbidden:
        regex: "(?im)generated (?:code|file)|DO NOT EDIT"
    references:
      capture: NAME
      min: 1
      max: 2
---
Do not extract a function whose whole body is one expression or one `return`. The semantic matcher checks local function and arrow candidates, then keeps only names with at most two project call sites. Inline the wrapper unless the name creates a durable contract.

## Why

- One-line wrappers: no real behavior.
- Readers: jump to verify trivial code.
- Signature: freezes shape too early.
- Inline expressions: better search and type flow.

## Avoid

```typescript
// Bad — pure rename, no behavior added.
function isEmpty(value: string): boolean {
	return value.length === 0;
}

const getDisplayName = (user: User) => user.profile.displayName;

function double(value: number) {
	return value * 2;
}

if (isEmpty(name)) { ... }
```

## Use

```typescript
if (name.length === 0) { ... }
const displayName = user.profile.displayName;
const doubled = value * 2;
```

## Allowed tiny functions

- Three or more call sites need lockstep behavior.
- Exported name: stable domain concept.
- Callback identity matters.
- Type guard preserves narrowing.
- Public API, test seam, or DI boundary needs indirection.
- Names non-obvious formula or magic-constant computation the inlined expression would not explain alone.

The matcher excludes generated files and rejects uppercase names, which covers the common exported naming form. It cannot inspect whether a lowercase function or const is exported from its parent declaration, so lowercase exported stable names remain a review-only exception.

If none apply, inline it.

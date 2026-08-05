---
description: "Keep TypeScript components as declarations and relative runtime imports explicit"
scope:
  - "tool:edit(*.ts)"
  - "tool:edit(*.tsx)"
  - "tool:write(*.ts)"
  - "tool:write(*.tsx)"
interruptMode: never
semanticCondition:
  - candidate:
      codeRegex: "(?m)^export\\s+const\\s+[A-Z]\\w*\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[A-Za-z_]\\w*)\\s*=>\\s*(?:<|\\(\\s*<|\\{\\s*return\\s+(?:<|\\(\\s*<))"
  - candidate:
      codeRegex: "(?m)^import\\s+(?!type\\b)(?!\\{\\s*type\\b)[^\\n]*\\sfrom\\s+[\\\"'](?<PATH>[^\\\"']+)[\\\"']"
    captures:
      PATH:
        regex: "^\\."
        notRegex: "\\.js$"
---

Declare an exported React component with `function ComponentName(...)`. Relative runtime imports name the emitted `.js` path.

One-component export counts, filename identity, import groups, and type-only import elision require path or repository evidence and remain review checks.

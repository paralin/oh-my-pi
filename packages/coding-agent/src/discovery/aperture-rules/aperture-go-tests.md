---
description: "Use direct Go test assertions instead of testify globals"
scope:
  - "tool:edit(*_test.go)"
  - "tool:write(*_test.go)"
interruptMode: never
semanticCondition:
  - candidate:
      codeRegex: '\bassert\.(?:Equal|NoError|Error|True|False|Nil|NotNil)\s*\('
    file:
      required:
        regex: '"github.com/stretchr/testify/assert"'
  - candidate:
      codeRegex: '\brequire\.(?:Equal|NoError|Error|True|False|Nil|NotNil)\s*\('
    file:
      required:
        regex: '"github.com/stretchr/testify/require"'
---

Use the standard `testing` package and direct comparisons that keep one condition and the failure location visible. Call `t.Helper()` in reusable helpers and register resource teardown with `t.Cleanup`.

The candidates cover common `testify/assert` and `testify/require` calls on executable code lines. Missing helper and cleanup calls require function-level sequence evidence and remain review checks.

---
description: "Name Go mutex fields mtx"
scope:
  - "tool:edit(*.go)"
  - "tool:write(*.go)"
interruptMode: never
semanticCondition:
  candidate:
    codeRegex: "(?ms)^type\\s+[A-Za-z_]\\w*\\s+struct\\s*\\{(?:(?!^\\s*\\}).)*?^\\s*(?<FIELD>[A-Za-z_]\\w*)\\s+sync\\.(?:RW)?Mutex\\s*$"
  captures:
    FIELD:
      notRegex: "^mtx$"
---

Name a struct mutex field `mtx`. Use `sync.Mutex` unless profiling demonstrates a read-heavy workload that benefits from `sync.RWMutex`.

Constructor return shape, context-field lifecycle, field comments, and declaration order require whole-file or repository evidence and remain review checks.

---
description: "Use explicitly plumbed Go logging instead of package globals"
scope:
  - "tool:edit(*.go)"
  - "tool:write(*.go)"
interruptMode: never
semanticCondition:
  - candidate:
      codeRegex: '\blog\.(?:Print|Printf|Println)\s*\('
    file:
      required:
        regex: '"log"'
  - candidate:
      codeRegex: '\blogrus\.(?:WithField|WithFields|WithError|Print|Printf|Println)\s*\('
    file:
      required:
        regex: '"github.com/sirupsen/logrus"'
---

Do not use the standard-library `log` package or package-level `logrus` calls. Pass a `*logrus.Entry` into the component that emits the event. If adding a logger would incoherently widen the component boundary, omit the log.

The candidates cover package-global constructors and print calls on executable code lines. Aliased imports and other package-global methods remain review checks.

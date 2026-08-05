---
description: "Compose conditional React classes with cn()"
scope:
  - "tool:edit(*.ts)"
  - "tool:edit(*.tsx)"
  - "tool:write(*.ts)"
  - "tool:write(*.tsx)"
interruptMode: never
semanticCondition:
  candidate:
    codeRegex: 'className\s*=\s*\{(?:`[^`]*\$\{|[^{}]*\?[^{}]*:)'
---
Use the project `cn()` class composition primitive for conditional class names, such as `cn(baseClass, enabled && activeClass)`, instead of hand-interpolating a template or ternary into `className`. A static class string does not need `cn`; this candidate only addresses conditional interpolation.

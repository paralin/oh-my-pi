# Changelog

## [Unreleased]

### Added

- Initial `@oh-my-pi/pi-dstui` package: a safe Lisp-flavored DSL runtime for composable, on-demand TUI components.
  - Bounded S-expression parser with structured diagnostics (line/column/offset spans) and hard caps on source bytes, parse depth, and AST node count.
  - Compiler for `defcomponent` / `defview` forms, with caps on bindings, state slots, timers, and parameters per definition.
  - Safe evaluator: per-instance fuel and recursion-depth budgets, prototype-key denial (`__proto__`, `prototype`, `constructor`) on every dynamic key access, no host realm escapes (no `globalThis`, `eval`, `Function`, `import`, or filesystem builtins).
  - Bounded layout/render path with output row and column caps; per-line ANSI styling via a small fixed style table.
  - Component instance runtime with idempotent `emit` / `cancel`, automatic timer teardown on first settle, capped timer count, minimum timer interval, and explicit `dispose()`.
  - DSL forms carried over verbatim: `defcomponent`, `defview`, `state`, `bind`, `every`, `view`, `use`, `each`, `let`, `if`, `when`, `cond`, `do`, `set!`, `fn`, `quote`, `emit`, `cancel`.
  - Layout primitives: `text`, `spacer`, `row`, `col`, `flex-row`, `flex-col`, `item`, `grid`, `bar`.
  - Builtins (bounded): math (`+ - * / mod abs round floor ceil min max clamp ratio`), compare (`< > <= >= =`), logic (`not and or`), strings (`str join repeat pad pad-end`), lists (`len nth list append slice swap splice-move`), objects (`field`).
  - DSL shape and bundled example components derived from [unitdhda/pi-dstui](https://github.com/unitdhda/pi-dstui) (MIT). The evaluator, loader, layout engine, and runner are rewritten from scratch with strict safety limits.

Tracks issue [#1564](https://github.com/can1357/oh-my-pi/issues/1564).

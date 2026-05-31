# @oh-my-pi/pi-dstui

Safe Lisp-flavored DSL runtime for composable, on-demand TUI components.

This package is the **core engine** for omp's dynamic TUI components: it parses
the DSL, evaluates it under strict resource limits, and produces lines of styled
text. It deliberately has **no** filesystem, no agent integration, and no
dependency on `@oh-my-pi/pi-tui` — those layers are added by later packages:

- A `@oh-my-pi/pi-tui` `Component` adapter (chunk 2 of the rollout) maps render
  output onto the existing TUI primitives, applying `replaceTabs` /
  `truncateToWidth` at the boundary.
- A persistence manager in `@oh-my-pi/pi-coding-agent` (chunk 3) stores
  `.omp/ui-components/<name>.lisp` modules with atomic writes, per-module locks,
  and a strict single-segment name regex with post-resolve containment.
- The `tui_define_component` / `tui_create_dynamic_ui` agent tools (chunk 4)
  are gated by `dstui.enabled` (default `false`) and only constructed when
  `session.hasUI` is true.

## Safety

The runtime is designed to evaluate **untrusted, model-authored DSL source**:

- Parser caps: source bytes, parse depth, AST node count; malformed source
  fails fast with structured diagnostics (line/column/offset spans).
- Evaluator caps: per-instance evaluation step budget and recursion depth.
- Prototype-key denial on every dynamic key access (`__proto__`, `prototype`,
  `constructor`); DSL named-arg parsing uses null-prototype records.
- No host realm escapes: no `globalThis`, `eval`, `Function`, dynamic import,
  or filesystem builtins are exposed.
- Output caps: hard limits on rendered rows, columns per row, string lengths,
  list lengths, and timer count; minimum timer interval is enforced.
- Settle semantics: `(emit value)` and `(cancel)` are idempotent and tear down
  every active timer and binding on the first call. `dispose()` is safe at any
  point.

## DSL shape

```lisp
(defcomponent confirm (message)
  (state (focused 0))

  (view
    (flex-col :gap 1
      (text message :accent)
      (flex-row :gap 2
        (text (if (= focused 0) "[Yes]" " Yes ") :bold)
        (text (if (= focused 1) "[No]"  " No "))))
    (text "←/→ choose  enter confirm  esc cancel" :muted))

  (bind :left  (set! focused 0))
  (bind :right (set! focused 1))
  (bind :enter (emit (= focused 0)))
  (bind :escape (cancel)))
```

See `src/index.ts` for the full programmatic API and the [DSL form
reference](#dsl-forms) below.

### Module forms

- `(defcomponent name (params...) (state ...) (view ...) (bind :KEY ...) (every MS ...))`
- `(defview name (params...) body...)`

### Layout primitives

- `(text VALUE :style?)` — styled text node
- `(spacer N?)` — N blank lines
- `(row CHILDREN...)` / `(col CHILDREN...)` — natural stacks
- `(flex-row :gap N? CHILDREN...)` / `(flex-col :gap N? CHILDREN...)`
- `(item :basis N? :grow N? CHILDREN...)` — flex child
- `(grid :columns N :gap N CHILDREN...)`
- `(bar VALUE :width N :cursor C :fill C :empty C :style :KW)`

### Control flow

`use` (view call), `each`, `let`, `if`, `when`, `cond`, `do`.

### State

`(state (NAME EXPR) ...)`, `(bind :KEY BODY...)`, `(every MS BODY...)`,
`(set! NAME EXPR)`, `(emit VALUE)`, `(cancel)`.

### Built-in functions

Math: `+ - * / mod abs round floor ceil min max clamp ratio`.
Compare: `< > <= >= =`. Logic: `not and or`.
Strings: `str join repeat pad pad-end`.
Lists: `len nth list append slice swap splice-move`.
Objects: `field` (denies `__proto__` / `prototype` / `constructor`).

## Attribution

The DSL surface (`defcomponent` / `defview` forms, layout primitives, key
binding shape, and three bundled example components) is derived from
[unitdhda/pi-dstui](https://github.com/unitdhda/pi-dstui) (MIT). The parser,
evaluator, layout engine, runtime, and persistence layer are rewritten from
scratch with strict safety limits suitable for evaluating untrusted,
model-authored source.

Tracks issue [#1564](https://github.com/can1357/oh-my-pi/issues/1564).

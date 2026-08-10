# Rulebook Matching Pipeline

Rules provide project guidance through discovered Markdown files. A rule may be
always applied, listed in the rulebook, or registered as a Time-Traveling Stream
Rule (TTSR).

## Rule shape

`buildRuleFromMarkdown` parses the frontmatter fields used by the runtime:

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  _source: SourceMeta;
}
```

`condition` is a JavaScript regular expression or list of expressions. The
legacy `ttsr_trigger` and `ttsrTrigger` frontmatter keys remain parsing aliases
for `condition`. Leading `(?i)`, `(?m)`, and `(?s)` flag groups are translated
to JavaScript `RegExp` flags.

`scope` accepts `text`, `thinking`, `tool`, or a named tool such as
`tool:ipython`. Omitted scope watches text and tool streams but not thinking.
The live provider emits TTSR tool chunks only for IPython, so
`tool:ipython` is the portable code scope. Scope tokens do not accept path
patterns.

`globs` are rulebook metadata from discovery providers; they do not participate
in TTSR matching.

## Discovery and buckets

Discovery providers normalize rule files through `buildRuleFromMarkdown`.
`bucketRules` first removes names in `ttsr.disabledRules` and removes bundled
rules when `ttsr.builtinRules === false`. It then registers rules with a usable
regex `condition` in `TtsrManager`. Registered rules are TTSR-only; remaining
`alwaysApply` rules enter the always-apply bucket and remaining described rules
enter the rulebook bucket.

Capability deduplication is first-wins by rule name before bucket assignment.
The active session combines all three buckets for `rule://<name>` lookup.

## Matching

`TtsrManager` compiles each condition once and buffers deltas independently for
text, thinking, and each IPython call. A match tests the accumulated stream
buffer, so a regex may span delta boundaries. Invalid regex conditions are
skipped with a warning; a rule with no usable regex is not registered.

The coordinator observes `text_delta`, `thinking_delta`, and `toolcall_delta`.
For a tool delta it verifies the call name is `ipython`, then supplies the
serialized code delta with `{ source: "tool", toolName: "ipython", streamKey }`.
No filesystem scan, file-path glob matching, AST matching, or post-edit semantic
evaluation runs in the TTSR path.

## CLI

`omp ttsr list` displays registered regex rules and their effective settings.
`omp ttsr test` evaluates inline text, `--file` content, or stdin against the
same manager. Use `--source tool --tool ipython` to test a code rule. The CLI
accepts no scan or path flags and rejects non-IPython tool streams.

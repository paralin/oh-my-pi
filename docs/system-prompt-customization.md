# System prompt customization

OMP sends every model the same fixed provider interface. `SYSTEM.md`, custom
prompt inputs, and project instructions add context to that interface; they do
not replace it.

The implementation is `packages/coding-agent/src/system-prompt.ts`:
`buildSystemPrompt()` builds the provider-facing blocks, and
`loadProjectContextFiles()` and `loadSystemPromptFiles()` load discovered
context. The static templates are:

- `src/prompts/system/system-prompt.md` — the fixed IPython ABI
- `src/prompts/system/project-prompt.md` — project and operator context
- `src/prompts/system/runtime-notice.md` — volatile session facts

## Fixed block order

`buildSystemPrompt()` emits up to three blocks in this order:

1. **Fixed IPython ABI.** Every provider receives exactly one `ipython` call
   with `{ "code": "<cell>" }`. Python cells and `%%bash` cells run in the
   retained IPython namespace. This block is always present unless
   `NULL_PROMPT=true`.
2. **Stable project and operator context.** This block is omitted only when it
   has no rendered content.
3. **Runtime notice.** The current date and working directory, plus the
   optional session notice and recursive depth, are rendered after stable
   context.

No custom input selects another base template or restores a tool catalog. The
fixed ABI remains the first block for CLI and SDK sessions alike.

## Project context and precedence

`loadProjectContextFiles()` loads the context-file capability for the session
working directory. It expands `@` imports, removes identical content, and
orders entries from the outer directory toward the current directory. A nested
instruction therefore appears after its ancestor and governs its own scope.
The fixed ABI states the same precedence rule: applicable project instructions,
including nested `AGENTS.md`, take precedence over the runtime guidance.

Additional workspace roots contribute context through the same loader. Their
files are combined with the primary workspace files, deduplicated by exact
content, and sorted by depth and path before rendering.

Always-apply rules render after project context. A rule is omitted when the
same normalized text already occurs in project context or an operator input, so
one instruction is not presented twice.

## Operator context

`project-prompt.md` renders these operator inputs after project context and
always-apply rules:

1. discovered `SYSTEM.md` as `<operator-context source="SYSTEM.md">`;
2. caller-supplied custom text as
   `<operator-context source="custom-system-prompt">`;
3. appended text as `<operator-context source="append-system-prompt">`.

A non-empty caller custom prompt suppresses discovered `SYSTEM.md`. Otherwise
`loadSystemPromptFiles()` selects the first discovered project-level
`SYSTEM.md`, then the first user-level file. Capability-provider precedence has
already decided ties at each level. A caller can also pass
`resolvedSystemPromptCustomization`, including `null`, to bypass discovery.

The CLI resolves `--system-prompt` and `--append-system-prompt` before it
creates the session. When a flag is absent, its startup path chooses a
project-level config file before a user-level file. The resolved text becomes
the caller custom or append input above; it still does not replace the fixed
IPython ABI.

## Text-or-file values

`resolvePromptInput()` treats a one-line custom or append value as a candidate
file path. If that read fails because the path is absent or too long, the value
is literal text. A value containing a newline is always literal text. Other
read failures are logged and also fall back to literal text.

Operator inputs are plain text. They are inserted into the static templates and
are not compiled as Handlebars. For example, `{{cwd}}` in `SYSTEM.md` reaches
the model literally.

## Title prompts and full SDK replacement

`TITLE_SYSTEM.md` is separate from the provider prompt. It affects automatic
session-title generation only. `discoverTitleSystemPromptFile()` checks a
project config file before a user config file; it does not add text to
`buildSystemPrompt()`.

`CreateAgentSessionOptions.systemPrompt` is the lower-level SDK escape hatch.
A string, array, or callback replaces the complete block array returned by
`buildSystemPrompt()`. Use it only when the embedder intentionally accepts
responsibility for replacing the fixed ABI, project context, operator context,
and runtime notice. CLI files and flags use `customSystemPrompt` and
`appendSystemPrompt` instead.

## Examples

To add context while retaining the normal block order, pass append text:

```ts
await buildSystemPrompt({ appendSystemPrompt: "Run the focused check before reporting completion." });
```

To supply operator context without changing the IPython ABI, pass custom text:

```ts
await buildSystemPrompt({ customPrompt: "Review changes and report concrete findings." });
```

For the full persistent-runtime contract, see [Persistent IPython runtime](./ipython.md).

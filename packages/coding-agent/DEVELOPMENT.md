# Developing `@oh-my-pi/pi-coding-agent`

This package is the `omp` CLI. This file is a **developer's map**: where things live
in `src/`, how to run the local loops, and — for each subsystem — which document in
the repo [`docs/`](../../docs/) tree is the authoritative reference.

The long architecture walkthrough that used to live here drifted out of date faster
than anyone re-read it. The `docs/` tree is kept current (and indexed for the
in-agent `docs://` / `/docs` surface), so this file links there instead of
duplicating prose that goes stale.

## Local development

Run from `packages/coding-agent/` (or add `--cwd=packages/coding-agent`):

| Task | Command |
|---|---|
| Typecheck + lint (the gate) | `bun run check` |
| Types only | `bun run check:types` |
| Lint only | `bun run lint` |
| Tests | `bun run test` |
| Autofix: lint + format prompts | `bun run fix` |
| Build the `dist/omp` binary | `bun run build` |

Never invoke `tsc`/`npx tsc` directly — `bun run check` is the typecheck gate.

## Boot flow

```text
process argv
   │
   ▼
src/cli.ts (runCli)            ── worker-host dispatch + Bun version guard;
   │  default subcommand: launch    argv normalization
   ▼
src/commands/* (+ src/cli/)   ── per-command adapters
   │
   ▼
src/main.ts (runRootCommand)  ── theme / settings / model registry / session opts
   │
   ▼
createAgentSession(...)        ── src/sdk.ts → AgentSession
   │
   ├── InteractiveMode   (src/modes/, TUI event loop)
   ├── runPrintMode      (one-shot text/json)
   └── runRpcMode        (JSONL stdin/stdout server)
```

`cli.ts` doubles as the worker host: it declares itself via `declareWorkerHostEntry()`
and dispatches the hidden `__omp_worker_*` argv selectors before loading the command
registry (see `AGENTS.md` → *Worker scripts*).

## Source layout (`src/`)

Top-level entry modules: `cli.ts`, `main.ts`, `sdk.ts`, `index.ts` (SDK barrel),
`config.ts`, `system-prompt.ts`, `thinking.ts`, `workspace-tree.ts`,
`cli-commands.ts`, `telemetry-export.ts`.

| Directory | Responsibility | Reference |
|---|---|---|
| `cli/`, `commands/`, `commit/`, `export/` | Command-line adapters and concrete subcommands | — |
| `modes/` | Interactive TUI, print, and RPC runtimes | [rpc.md](../../docs/rpc.md), [sdk.md](../../docs/sdk.md) |
| `session/` | `AgentSession`, JSONL session tree, storage, history | [session.md](../../docs/session.md), [session-tree-plan.md](../../docs/session-tree-plan.md) |
| `config/`, `registry/` | Settings and model/provider registry | [settings.md](../../docs/settings.md), [config-usage.md](../../docs/config-usage.md), [models.md](../../docs/models.md) |
| `tools/` | Retained autonomous-mode components and shared host-service types | [ipython.md](../../docs/ipython.md) |
| `exec/`, `ipython/`, `ssh/`, `dap/`, `debug/` | IPython, shell, remote, and debugger runtime components | [ipython.md](../../docs/ipython.md) |
| `lsp/` | Language-server client/runtime used by typed IPython host capabilities | [lsp-config.md](../../docs/lsp-config.md), [ipython.md](../../docs/ipython.md) |
| `task/`, `swarm/`, `irc/`, `goals/` | Retained subagent delegation, parallelism, inter-agent IRC, goals | [task-agent-discovery.md](../../docs/task-agent-discovery.md) |
| `web/`, `exa/` | Typed IPython browser/search host services and provider adapters | [ipython.md](../../docs/ipython.md), [environment-variables.md](../../docs/environment-variables.md) |
| `mcp/` | MCP transport, manager, loader, and typed IPython host service | [mcp-config.md](../../docs/mcp-config.md), [mcp-runtime-lifecycle.md](../../docs/mcp-runtime-lifecycle.md) |
| `extensibility/`, `slash-commands/` | Extensions, hooks, custom commands, skills, plugins | [extensions.md](../../docs/extensions.md), [hooks.md](../../docs/hooks.md), [skills.md](../../docs/skills.md) |
| `capability/`, `discovery/` | Capability registry + provider discovery modules | [extension-loading.md](../../docs/extension-loading.md), [context-files.md](../../docs/context-files.md) |
| `advisor/`, `autolearn/`, `autoresearch/` | Advisor/watchdog, managed skills, background research | [advisor-watchdog.md](../../docs/advisor-watchdog.md) |
| `memories/`, `memory-backend/`, `mnemopi/`, `hindsight/` | Memory subsystems and backends | [memory.md](../../docs/memory.md), [mnemosyne-memory-backend.md](../../docs/mnemosyne-memory-backend.md) |
| `internal-urls/` | Router + handlers (`agent://`, `docs://`, `rule://`, …) | [tree.md](../../docs/tree.md) |
| `tui/`, `collab/` | Low-level TUI primitives, live session sharing | [tui.md](../../docs/tui.md), [collab.md](../../docs/collab.md) |
| `tts/`, `stt/` | Text-to-speech / speech-to-text | — |
| `tiny/`, `auto-thinking/` | Embedded tiny-model experiments, auto thinking level | [local-models.md](../../docs/local-models.md) |
| `async/`, `lib/`, `utils/`, `prompts/`, `edit/` | Shared plumbing, retained prompt assets, and patch/diff engine | [ipython.md](../../docs/ipython.md) |

## Subsystem reference

### Sessions, persistence, and turn lifecycle
- [session.md](../../docs/session.md) — storage and entry model
- [session-tree-plan.md](../../docs/session-tree-plan.md) — branch/tree architecture
- [session-switching-and-recent-listing.md](../../docs/session-switching-and-recent-listing.md)
- [session-operations-export-share-fork-resume.md](../../docs/session-operations-export-share-fork-resume.md)
- [compaction.md](../../docs/compaction.md) — compaction and branch summaries
- [ttsr-injection-lifecycle.md](../../docs/ttsr-injection-lifecycle.md)
- [non-compaction-retry-policy.md](../../docs/non-compaction-retry-policy.md)
- [handoff-generation-pipeline.md](../../docs/handoff-generation-pipeline.md)

### Configuration, models, providers, auth
- [settings.md](../../docs/settings.md), [config-usage.md](../../docs/config-usage.md)
- [environment-variables.md](../../docs/environment-variables.md)
- [models.md](../../docs/models.md), [providers.md](../../docs/providers.md), [adding-a-provider.md](../../docs/adding-a-provider.md)
- [local-models.md](../../docs/local-models.md)
- [provider-streaming-internals.md](../../docs/provider-streaming-internals.md), [ai-schema-normalize.md](../../docs/ai-schema-normalize.md)
- [keybindings.md](../../docs/keybindings.md)
[auth-broker-gateway.md](../../docs/auth-broker-gateway.md), [install-id.md](../../docs/install-id.md)
- [system-prompt-customization.md](../../docs/system-prompt-customization.md)

### IPython and typed host capabilities
- Runtime and capability boundary: [ipython.md](../../docs/ipython.md)
- Output/artifacts: [blob-artifact-architecture.md](../../docs/blob-artifact-architecture.md)
- Gating and whole-cell approval: [approval-mode.md](../../docs/approval-mode.md)
- The injected `omp` object and Python docstrings are the authoritative host-capability reference.

### Execution backends
- [ipython.md](../../docs/ipython.md), [lsp-config.md](../../docs/lsp-config.md)
- [rpc.md](../../docs/rpc.md)

### Task delegation and subagents
- [task-agent-discovery.md](../../docs/task-agent-discovery.md)
- [collab.md](../../docs/collab.md)

### Web I/O and retrieval
- [ipython.md](../../docs/ipython.md), [environment-variables.md](../../docs/environment-variables.md)

### MCP
- [mcp-config.md](../../docs/mcp-config.md), [mcp-runtime-lifecycle.md](../../docs/mcp-runtime-lifecycle.md)
- [mcp-protocol-transports.md](../../docs/mcp-protocol-transports.md), [mcp-server-tool-authoring.md](../../docs/mcp-server-tool-authoring.md)

### Memory
- [memory.md](../../docs/memory.md), [mnemosyne-memory-backend.md](../../docs/mnemosyne-memory-backend.md)

### Discovery, context, and rules
- [context-files.md](../../docs/context-files.md), [rulebook-matching-pipeline.md](../../docs/rulebook-matching-pipeline.md)
- [advisor-watchdog.md](../../docs/advisor-watchdog.md), [fs-scan-cache-architecture.md](../../docs/fs-scan-cache-architecture.md), [tree.md](../../docs/tree.md)

### TUI and theming
- [tui.md](../../docs/tui.md), [tui-core-renderer.md](../../docs/tui-core-renderer.md), [tui-runtime-internals.md](../../docs/tui-runtime-internals.md)
- [theme.md](../../docs/theme.md)

### Natives (`crates/pi-natives`, `packages/natives`)
- [natives-architecture.md](../../docs/natives-architecture.md), [natives-addon-loader-runtime.md](../../docs/natives-addon-loader-runtime.md), [natives-binding-contract.md](../../docs/natives-binding-contract.md)
- [natives-text-search-pipeline.md](../../docs/natives-text-search-pipeline.md), [natives-shell-pty-process.md](../../docs/natives-shell-pty-process.md), [natives-media-system-utils.md](../../docs/natives-media-system-utils.md)
- [natives-build-release-debugging.md](../../docs/natives-build-release-debugging.md), [natives-rust-task-cancellation.md](../../docs/natives-rust-task-cancellation.md), [porting-to-natives.md](../../docs/porting-to-natives.md)

### Build, release, and porting
- [macos-signing-notarization.md](../../docs/macos-signing-notarization.md)
- [porting-from-pi-mono.md](../../docs/porting-from-pi-mono.md)

## Extending omp

| To add… | Start here |
|---|---|
| A typed host capability | [ipython.md](../../docs/ipython.md) and the responsible `src/ipython/*-service.ts` component |
| An extension (TS/JS module) | [extensions.md](../../docs/extensions.md), [extension-loading.md](../../docs/extension-loading.md), [skills/authoring-extensions.md](../../docs/skills/authoring-extensions.md) |
| A hook | `src/extensibility/hooks/types.ts` + [hooks.md](../../docs/hooks.md), [skills/authoring-hooks.md](../../docs/skills/authoring-hooks.md) |
| A slash command | [slash-command-internals.md](../../docs/slash-command-internals.md) |
| An RPC command | `src/modes/rpc/rpc-types.ts` + [rpc.md](../../docs/rpc.md) |
| A skill | [skills.md](../../docs/skills.md) |
| A marketplace plugin | [marketplace.md](../../docs/marketplace.md), [plugin-manager-installer-plumbing.md](../../docs/plugin-manager-installer-plumbing.md), [skills/authoring-marketplaces.md](../../docs/skills/authoring-marketplaces.md), [gemini-manifest-extensions.md](../../docs/gemini-manifest-extensions.md) |
| An MCP tool/server | [mcp-server-tool-authoring.md](../../docs/mcp-server-tool-authoring.md), [mcp-runtime-lifecycle.md](../../docs/mcp-runtime-lifecycle.md) |
| A provider | [adding-a-provider.md](../../docs/adding-a-provider.md) |
| Programmatic/SDK use | [sdk.md](../../docs/sdk.md) |

## Writing a doc

Everything under `docs/` is embedded at build time and served over `omp://`, so
a page written for someone working on omp lands in the same corpus an agent
browses while working on an unrelated project. Say who a page is for with an
HTML comment on its first line:

```markdown
<!-- omp-audience: maintainer -->
```

Markdown renderers drop the comment, so it shows up nowhere. A page carrying it
stays readable at its exact `omp://` path and stops appearing in the `omp://`
listing and in completions; a page without it is offered to every session. Set
`docs.hideMaintainer = false` to list the whole corpus while working on omp
itself.

See also `AGENTS.md` at the repo root for repo-wide conventions (Bun-over-Node,
logging, TUI sanitization, generated files, changelog, releasing).

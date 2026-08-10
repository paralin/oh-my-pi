# SDK

The SDK is the in-process integration surface for `@oh-my-pi/pi-coding-agent`.
Use it when you want direct access to agent state, event streaming, tool wiring, and session control from a Bun process.

If you need cross-language/process isolation, use RPC mode instead.

## Installation

```bash
bun add @oh-my-pi/pi-coding-agent
```

Requires Bun 1.3.14 or newer. Before the first model-backed prompt, configure
credentials for a provider or run a keyless local provider; see
[Providers](./providers.md). Session construction can succeed without an
available model, but prompting cannot.

## Entry points

The package root, `@oh-my-pi/pi-coding-agent`, is the complete embedding surface. It includes `createAgentSession` and the focused `/sdk` exports, plus lower-level session, auth, model, mode, extension, and tool APIs.

Import these core embedding APIs from the package root:

- `createAgentSession`
- `SessionManager`
- `Settings`
- `AuthStorage`
- `ModelRegistry`
- `AgentRegistry`
- `discoverAuthStorage`
- Discovery helpers (`discoverExtensions`, `discoverSkills`, `discoverContextFiles`, `discoverPromptTemplates`, `discoverSlashCommands`, `discoverCustomTSCommands`)

The narrower `@oh-my-pi/pi-coding-agent/sdk` subpath exports `createAgentSession`, its option/result types, `Settings`, `AgentRegistry`, discovery and system-prompt helpers, workspace-tree helpers, selected extension and MCP types. It does **not** export `SessionManager`, `AuthStorage`, or `ModelRegistry`; import those three from the package root as the examples below do.

## Quick start (auto-discovery defaults)

```ts
import { createAgentSession } from "@oh-my-pi/pi-coding-agent";

const { session, modelFallbackMessage } = await createAgentSession();

if (modelFallbackMessage) {
  process.stderr.write(`${modelFallbackMessage}\n`);
}

const unsubscribe = session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Summarize this repository in 3 bullets.");
unsubscribe();
await session.dispose();
```

## What `createAgentSession()` discovers by default

`createAgentSession()` follows “provide to override, omit to discover”.

If omitted, it resolves:

- `cwd`: `getProjectDir()`
- `agentDir`: `~/.omp/agent` (via `getAgentDir()`)
- `authStorage`: `discoverAuthStorage(agentDir)`
- `modelRegistry`: `new ModelRegistry(authStorage)` + background `refreshInBackground()` when the registry is not provided
- `settings`: `await Settings.init({ cwd, agentDir })`
- `sessionManager`: `SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))` (file-backed)
- skills/rules/context files/prompt templates/slash commands/extensions/custom TS commands
- the fixed persistent IPython runtime and its cell journal
- MCP, language-intelligence, browser, computer, and other typed host capability services
- `eventBus`: new `EventBus()` unless supplied

### Required vs optional inputs

Typically you must provide only what you want to control:

```ts
function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

- **Must provide**: nothing for a minimal session
- **Usually provide explicitly** in embedders:
  - `sessionManager` (if you need in-memory or custom location)
  - `authStorage` + `modelRegistry` (if you own credential/model lifecycle)
  - `model` or `modelPattern` (if deterministic model selection matters)
  - `settings` (if you need isolated/test config)

For multiple concurrent top-level sessions in one process, pass a private
`AgentRegistry` to each session. The default process-global registry admits
only one `"Main"` identity per generation.

## Session manager behavior (persistent vs in-memory)

`AgentSession` always uses a `SessionManager`; behavior depends on which factory you use.

### File-backed (default)

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.create(process.cwd()),
});

console.log(session.sessionFile); // absolute .jsonl path
```

- Persists conversation/messages/state deltas to session files.
- Supports resume/open/list/fork workflows.
- `session.sessionFile` is defined.

### In-memory

```ts
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});

console.log(session.sessionFile); // undefined
```

- No filesystem persistence.
- Useful for tests, ephemeral workers, request-scoped agents.
- Session methods still work, but persistence-specific behaviors (file resume/fork paths) are naturally limited.

### Resume/open/list helpers

```ts
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

const recent = await SessionManager.continueRecent(process.cwd());
const listed = await SessionManager.list(process.cwd());
const opened = listed[0] ? await SessionManager.open(listed[0].path) : null;
```

## Model and auth wiring

`createAgentSession()` uses `ModelRegistry` + `AuthStorage` for model selection and API key resolution.

If both `authStorage` and `modelRegistry` are supplied,
`modelRegistry.authStorage` MUST be the same instance; session creation rejects
divergent stores.

### Explicit wiring

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const available = modelRegistry.getAvailable();
if (available.length === 0)
  throw new Error("No authenticated models available");

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model: available[0],
  thinkingLevel: "medium",
  sessionManager: SessionManager.inMemory(),
});
```

### Selection order when `model` is omitted

When no explicit `model`/`modelPattern` is provided:

1. restore model from existing session (if restorable + key available)
2. settings default model role (`default`)
3. an authenticated provider-default model in availability order (falling back to the first authenticated available model when no provider default is present)

If restore fails, `modelFallbackMessage` explains fallback.

### Auth priority

`AuthStorage.getApiKey(...)` resolves in this order:

1. runtime override (`setRuntimeApiKey`, used by CLI `--api-key`)
2. config-sourced API key override (`models.yml` provider `apiKey`)
3. stored OAuth credential, including refresh when needed
4. API key persisted by a successful `/login`
5. provider environment variables
6. other stored API-key credential in `agent.db` / broker-backed storage
7. custom-provider resolver fallback

## Event subscription model

Subscribe with `session.subscribe(listener)`; it returns an unsubscribe function.

```ts
const unsubscribe = session.subscribe((event) => {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_start":
      break;
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
  }
});
```

`AgentSessionEvent` includes core `AgentEvent` plus session-level events:

- `auto_compaction_start` / `auto_compaction_end`
- `auto_retry_start` / `auto_retry_end`
- `retry_fallback_applied` / `retry_fallback_succeeded`
- `model_changed`
- `thinking_level_changed`
- `ttsr_triggered`
- `todo_reminder` / `todo_auto_clear`
- `irc_message`
- `notice`
- `goal_updated`

`agent_end` includes `messages`, optional telemetry fields, and
`isTerminal?: boolean`. When `isTerminal` is `false`, maintenance or async
delivery will resume the session before its true final settle. Subscribers that
use `agent_end` as a completion signal MUST wait for `isTerminal !== false`.
Treat an absent field as terminal for compatibility with older runtimes.

## Prompt lifecycle

`session.prompt(text, options?)` is the primary entry point.

Behavior:

1. optional command/template expansion (`/` commands, custom commands, file slash commands, prompt templates)
2. if currently streaming:
   - `streamingBehavior: "steer" | "followUp"` chooses how `prompt()` queues
   - extension `sendUserMessage(content)` defaults to steer when `deliverAs` is omitted
   - queued messages are preserved instead of throwing work away
3. if idle:
   - validates model + API key
   - appends user message
   - starts agent turn

Related APIs:

- `sendUserMessage(content, { deliverAs? })`
- `steer(text, images?)`
- `followUp(text, images?)`
- `sendCustomMessage({ customType, content, ... }, { deliverAs?, triggerTurn? })`
- `abort()`

## `AgentSession` lifecycle and disposal

Call `await session.dispose()` when the embedder is completely done with a session. `dispose()` starts disposal itself and is idempotent: repeated or concurrent calls receive the same teardown promise, so shutdown events and owned resources are not drained twice.

`beginDispose()` is the synchronous admission barrier for wrappers that must await their own teardown before calling `dispose()`. Call it before the wrapper's first `await`; otherwise deferred work can enter the gap. It immediately marks the session disposed, cancels memory startup, title generation, and auto-learn capture, clears queued yield/asides, stops advisor runtime, detaches aside delivery, and rejects new IPython cells. Deferred session work checks the disposed state and is dropped or skipped. `beginDispose()` is also idempotent, and the later `dispose()` call remains required to finish asynchronous cleanup.

```ts
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

async function closeEmbeddedSession(
  session: AgentSession,
  closeHostInputAndUi: () => Promise<void>,
): Promise<void> {
  session.beginDispose(); // no new deferred work may enter after this point
  await closeHostInputAndUi();
  await session.dispose();
}
```

During asynchronous disposal, the session records and synchronously flushes its exit diagnostic, emits `session_shutdown` once, stops extension fallback timers, aborts retries, compaction, and the active agent turn, and gives post-prompt and auto-learn work bounded time to settle. It then tears down session-owned async jobs, IPython kernels, browser tabs, native computer sessions, MCP connections, advisor state, and memory state concurrently. These subsystem drains are best-effort and bounded where applicable; failures are logged rather than preventing the remaining subsystem cleanup.

Only after work capable of appending session entries has settled does disposal clean up an empty moved session, close the `SessionManager`, close provider session state, disconnect the agent, and remove listeners. A failure from the final persistence cleanup or `SessionManager.close()` rejects the shared disposal promise; individual provider-session close failures are logged.

## IPython and extension integration

Every SDK session exposes the fixed `ipython` provider interface. The retained
kernel uses ordinary Python for workspace work and typed `omp.*` or skill APIs
for host-owned services. The SDK does not accept a provider function allowlist
or runtime capability-catalog changes.

Extensions may contribute prompt context, commands, UI, rules, and skills, but
they do not extend the provider interface. See [Persistent IPython runtime](./ipython.md)
and [Extensions](./extensions.md).

## Discovery helpers

Use these when you want partial control without recreating internal discovery logic:

- `discoverAuthStorage(agentDir?)`
- `discoverExtensions(cwd?)`
- `discoverSkills(cwd?, _agentDir?, settings?)`
- `discoverContextFiles(cwd?, _agentDir?, disabledExtensions?)`
- `discoverPromptTemplates(cwd?, agentDir?)`
- `discoverSlashCommands(cwd?)`
- `discoverCustomTSCommands(cwd?, agentDir?)`
- `buildSystemPrompt(options?)`

## Subagent-oriented options

For SDK consumers building orchestrators (similar to task executor flow):

- `outputSchema`: validates a subagent session’s final response
- `outputSchemaMode`: selects permissive or strict structured-output enforcement
- `taskDepth`: recursion-depth context for nested task sessions
- `parentTaskPrefix`: artifact naming prefix for nested task outputs

These are optional for normal single-agent embedding.

## `createAgentSession()` return value

```ts
type CreateAgentSessionResult = {
  session: AgentSession;
  extensionsResult: LoadExtensionsResult;
  setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
  mcpManager?: MCPManager;
  modelFallbackMessage?: string;
  lspServers?: Array<{
    name: string;
    status: "connecting" | "ready" | "error" | "available";
    fileTypes: string[];
    error?: string;
  }>;
  eventBus: EventBus;
};
```

Use `setToolUIContext(...)` only if your embedder provides UI capabilities that host services or extensions should call into.

## Startup performance

`createAgentSession()` runs two background optimizations to overlap I/O with the rest of session setup:

- **Model-host preconnect.** As soon as the model is resolved, the SDK fires a best-effort `fetch.preconnect(model.baseUrl)` so DNS + TCP + TLS + HTTP/2 to the provider's host happens in parallel with extension/skill load, tool registry build, and system-prompt assembly. The first real `fetch(...)` then reuses the warm connection, saving 100–300 ms on transcontinental hops (e.g. residential IP → `api.anthropic.com`). Implementation lives in `preconnectModelHost()` in `packages/coding-agent/src/sdk.ts`. If `fetch.preconnect` is unavailable (non-Bun runtime) or the call throws, the optimization is silently skipped — never a hard dependency. Applies to every mode (interactive, print, RPC, ACP).
- **Conditional LSP warmup.** Startup LSP servers (those returned by `discoverStartupLspServers(cwd)`) are only warmed when **all** of these hold:
  - `enableLsp !== false` on the session options, **and**
  - `options.hasUI === true` (interactive TUI), **and**
  - the `lsp.lazy` setting is disabled (it defaults to `true`).

  With `lsp.lazy` enabled — the default — no language servers launch at startup. A server cold-starts on the first matching typed `omp.code` request. Print, script, RPC, and ACP invocations (`hasUI=false`) skip warmup regardless of the setting because they do not render startup status and usually finish before a server stabilizes. The returned `lspServers` field remains populated for lazy UI sessions: recognized servers appear as `"available"` without starting a process. It is `undefined` only when `enableLsp === false` or `hasUI === false`.

## Minimal controlled embed example

```ts
import {
  createAgentSession,
  discoverAuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const authStorage = await discoverAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
await modelRegistry.refresh();

const settings = Settings.isolated({
  "compaction.enabled": true,
  "retry.enabled": true,
});

const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  settings,
  sessionManager: SessionManager.inMemory(),
  enableMCP: false,
  enableLsp: true,
});

session.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await session.prompt("Find all TODO comments in this repo and propose fixes.");
await session.dispose();
```

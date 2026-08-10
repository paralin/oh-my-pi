# Advisor, WATCHDOG.md, and WATCHDOG.yml

The advisor subsystem attaches one or more optional reviewer models to a session. Each advisor reviews primary-agent transcript updates and injects concise advice back into the primary session.

An advisor does not approve actions or mutate primary session state directly. It reviews bounded session and IPython-cell evidence. Any additional investigation stays behind the same typed host capability boundary and session policy; grant it only when the advisor model and workspace are trusted (see [Tools and isolation](#tools-and-isolation)).

## Implementation files

- [`src/advisor/runtime.ts`](../packages/coding-agent/src/advisor/runtime.ts)
- [`src/advisor/emission-guard.ts`](../packages/coding-agent/src/advisor/emission-guard.ts)
- [`src/advisor/watchdog.ts`](../packages/coding-agent/src/advisor/watchdog.ts)
- [`src/advisor/config.ts`](../packages/coding-agent/src/advisor/config.ts)
- [`src/advisor/transcript-recorder.ts`](../packages/coding-agent/src/advisor/transcript-recorder.ts)
- [`src/prompts/advisor/system.md`](../packages/coding-agent/src/prompts/advisor/system.md)
- [`src/session/session-advisors.ts`](../packages/coding-agent/src/session/session-advisors.ts)
- [`src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`src/slash-commands/builtin-registry.ts`](../packages/coding-agent/src/slash-commands/builtin-registry.ts)
- [`src/config/settings-schema.ts`](../packages/coding-agent/src/config/settings-schema.ts)

---

## Enabling the advisor

The subsystem requires `advisor.enabled: true`. Model selection then depends on the roster:

- Without any discovered `WATCHDOG.yml` advisor entries, OMP creates the legacy/default advisor and resolves its model from `modelRoles.advisor`.
- With a roster, each enabled entry uses its explicit `model` when present, otherwise `modelRoles.advisor`. An unresolvable entry is reported as `no_model` without preventing other entries from running.
- `advisors[].enabled: false` keeps an entry visible as paused but does not build its runtime.

Example:

```yaml
modelRoles:
  advisor: anthropic/claude-sonnet-4-5:medium

advisor:
  enabled: true
```

Model selectors use normal role/model resolution, including provider-prefixed ids, canonical ids, fallback lists, and optional thinking suffixes.

`tier.advisor` controls service tier for all advisors. It defaults to `none` (standard processing); `inherit` follows the primary's live per-family tier, including `/fast` changes. Concrete values (`auto`, `default`, `flex`, `scale`, `priority`) are applied only when the advisor model's provider family supports them.

### Headless runs

Use `--advisor` to enable the advisor for one print-mode process without
persisting `advisor.enabled`:

```sh
omp -p --advisor "Review this task."
```

While a primary prompt is running, advisor concerns and blockers continue to steer that live turn. After the final prompt settles, print mode preserves late advisor notes without starting hidden primary turns, then waits up to ten minutes for final reviews before disposing the session. Error exits use a 30-second drain budget so failed automation can terminate. If either deadline expires, OMP logs the reviews that disposal will abandon; completed reviews retain their transcript and token/cost usage.

Slash commands:

| Command              | Effect                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/advisor`           | Toggle the advisor subsystem for this session (session-scoped override; does not change persisted `advisor.enabled`).                |
| `/advisor on`        | Enable the configured/default advisor runtimes for this session. Session-scoped; not persisted to config.                            |
| `/advisor off`       | Disable the advisor subsystem for this session and stop its runtimes. Session-scoped; not persisted to config.                       |
| `/advisor status`    | Show each advisor's runtime state, model, context usage, token usage, and cost.                                                      |
| `/advisor dump`      | Copy the compact transcript (all active advisors when a roster is present) to the clipboard.                                         |
| `/advisor dump raw`  | Copy the full dump, including system prompt, tools, thinking, and calls.                                                             |
| `/advisor configure` | Open the interactive TUI editor for project- or user-level `WATCHDOG.yml`. Non-TUI command hosts report that the editor is TUI-only. |

If the subsystem is enabled but no legacy/default or roster model resolves, status reports the configured advisors as inactive/`no_model`.

## What the advisor sees

At each primary update, `AdvisorRuntime` receives only the new transcript delta since its previous update. Deltas are rendered with reasoning, tool intent, watched-role markers, and expanded primary constraint context, so advisors can review assistant reasoning as well as user-visible text, tool calls, and tool results. Provider credentials remain host-only; stored transcript text is not transformed before it reaches the advisor model.

Most hidden `custom` messages collapse to a one-line summary in the delta. Advisors also receive the primary's discovered project context files (`AGENTS.md` and related standing instructions) in a `<project-context>` system-prompt block. If the session cwd is outside Git with exactly one direct child repository, an additional watchdog block tells the advisor which child is the active project.

Advisor messages already injected into the primary transcript are filtered out before the next delta is rendered. This prevents the advisor from recursively reviewing its own advice.

When the primary transcript is rewritten, the advisor runtime is reset:

- compaction
- session switch/resume
- branch/fork style history replacement
- context-maintenance re-prime when the advisor's own context cannot fit

Reset clears the advisor's private in-memory transcript and rewinds its cursor. The next advisor update replays the current bounded primary transcript instead of continuing from stale pre-rewrite context.

When the advisor is enabled mid-session, the cursor seeds to the current primary transcript length. That avoids replaying the whole old conversation on the first enabled turn.

## Advisor response contract

Each advisor has a private `Agent` instance with an empty tool catalog. The model returns one final JSON response to a host-owned `AdviceSink`, which validates and submits accepted notes to the primary transcript without sharing the primary agent runtime. The provider receives no advisor tool definition or tool schema.

The response accepts one note and an optional severity:

| Severity        | Delivery                                                                                                                                                             | Intended use                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| omitted / `nit` | Non-interrupting aside, batched into the primary transcript at the next step boundary.                                                                               | Cleanup, simplification, low-risk edge cases.                                |
| `concern`       | Interrupting steering message when the delivery constraints below permit it. A late terminal-answer `concern` is preserved as a visible card instead.                | Material risk, likely wrong direction, missing constraint, hallucinated API. |
| `blocker`       | Interrupting steering message when the delivery constraints below permit it. Unlike a `concern`, a terminal answer alone does not prevent it from triggering a turn. | Continuing would clearly waste work or produce broken output.                |

Accepted notes are rendered into the primary transcript as XML-escaped `<advisory>` elements. Named roster advisors add an `advisor` attribute:

```text
<advisory advisor="Architecture" severity="concern" guidance="weigh, don't blindly obey">
note text
</advisory>
```

When you deliberately interrupt the agent (Esc, or a cancel from collab, ACP, RPC, the SDK, or an extension), the advisor stops auto-resuming it. An interrupting `concern`/`blocker` raised while the run is stopped is recorded as a visible advisor card instead of restarting the turn, and a concern already in flight when you interrupt is preserved the same way rather than driving a surprise resume. The advice re-enters context the next time you resume — a new message, the `.`/`c` continue shortcut, or a steer/follow-up.

A normal yield the agent drove itself is treated differently from a deliberate interrupt, but it is not a blanket "always steers and resumes". The loop state and completed turn first determine the normal delivery path:

- **While the loop is still streaming** (the raise arrived before the yield, or during a resume you already drove), the note normally steers into the live turn.
- **Once the loop has yielded and gone idle**, delivery keys on how the turn ended:
  - If the primary's tail is a **terminal text answer with no queued work**, a late `concern` is preserved as a visible card rather than waking the agent to restate a completed turn (#4840) — it re-enters context on the next resume (a new message, `.`/`c`, or a steer/follow-up), exactly like the interrupt case. A `blocker` is the exception: it normally steers a triggered turn, because it means the agent handed off broken or unexercised work that must be acknowledged before the turn is considered done (#5628).
  - Otherwise (the agent yielded mid-work, no terminal answer), an idle `concern`/`blocker` normally triggers a fresh turn so the advice is acted on immediately.

Two session/client constraints can still preserve a note whose normal delivery path is steering:

- **ACP with deferred agent-initiated turns:** when `deferAgentInitiatedTurns` is enabled and the bridge has not allowed agent-initiated turns, an idle would-be steer is preserved because the client cannot represent the triggered turn as busy. Advice raised while the primary loop is already streaming can still steer into that live turn.

The advisor can steer and resume a run the agent ended on its own while it is running or yielded mid-work and the current client permits steering. When steering is blocked, the note is preserved as a card for a terminal answer or deferred ACP client, or downgraded to a non-interrupting aside by the cooldown below; it waits for the next step boundary instead of waking the agent.

`advisor.immuneTurns` limits interruption frequency. After the advisor successfully delivers a `concern` or `blocker` through the steering channel, later concerns/blockers are routed as non-interrupting asides until the configured number of primary turns has completed. The default is `3`. `nit` notes are unchanged, and advice raised while user-interrupt auto-resume suppression is active is still preserved instead of restarting a stopped run.

While an advisor update is reviewing work still in progress, the host-owned `AdviceSink` withholds `nit` and `concern` responses; only a `blocker` may interrupt partial work. The sink also suppresses the same whitespace-normalized note at an equal or lower severity while allowing a real escalation (`nit` → `concern` → `blocker`). The advisor receives no tools or provider tool schema: its final assistant response is exactly `{"note":null}` for silence or `{"note":"…","severity":"nit|concern|blocker"}` for one note.

### Emission guard

Each advisor has its own `AdvisorEmissionGuard` (`src/advisor/emission-guard.ts`) after `AdviceSink` validation and before the YieldQueue/steer channel. It enforces the system prompt's "at most one accepted note per update" and no-repeat rules:

1. **Normalization.** Lowercase, NFKC, collapse every run of non-alphanumeric characters to one space, then trim. `"Stop."`, `"*Stop*"`, and `"  stop  "` all key to `stop`.
2. **Content-free phrase filter.** Short phrases with no concrete reason — `stop`, `done`, `complete`, `no issue continue`, `lgtm`, `nothing to add`, and similar — are suppressed.
3. **Severity-aware dedupe.** A normalized note already accepted at an equal or higher severity is dropped; a real escalation may pass. The FIFO history holds at most 4096 entries.
4. **Per-update rate limit.** At most one note per advisor model `prompt()` cycle is accepted. Suppressed noise never consumes the budget.

Guard-level suppression and sink-level duplicate or in-progress withholding are invisible to the model. The final assistant response remains in the advisor transcript while only accepted notes reach the primary session.

The guard's full state — dedupe history and per-update gate — clears on every advisor reset (compaction, session switch, `/new`), so a re-primed reviewer can re-raise issues it already raised against the rewritten transcript.

## Bounded catch-up with `advisor.syncBacklog`

`advisor.syncBacklog` is not lockstep turn execution. It is a bounded catch-up delay for the primary agent when the advisor falls behind.

Allowed values:

- `off` — never wait for advisor catch-up
- `1`
- `3`
- `5`

On primary turn end:

1. the primary turn delta is queued for the advisor
2. the advisor drain loop starts or continues in the background
3. if `advisor.syncBacklog` is not `off`, the primary agent waits only while advisor backlog is at or above the configured threshold
4. the wait is capped at 30 seconds
5. if the advisor catches up below the threshold, the primary continues immediately
6. if the cap expires, the primary continues anyway

Practical interpretation:

- `off` favors maximum primary throughput.
- `1` is the closest mode to synchronous review: after each queued advisor delta, the primary waits up to 30 seconds for backlog to return to zero.
- `3` and `5` allow more advisor lag before the primary pauses.

Advisor failures do not permanently stall the primary. The host first attempts its credential/fallback recovery. Retriable failures are attempted up to three times before that backlog is dropped; three dropped-backlog cycles halt the runtime until an explicit reset, and a permanent request rejection can halt it after one cycle. A quota/usage-limit failure pauses the advisor with its batch retained until `/advisor` rebuilds it, configuration is reloaded, a new session starts, or the process restarts. Catch-up waiters are released as soon as an advisor is failing.

Unsafe Advisor output follows a separate quarantine path rather than that
three-attempt request-retry policy. Before tool dispatch, the runtime
quarantines a turn that requests non-bridge tools unavailable to the Advisor.
It also quarantines generated text/advice when an output-only destructive-shell
directive is detected, or when at least three output-only hazard classes match
among destructive shell, instruction override, denial instruction, and
account-deletion claim. A new instruction override paired with a destructive
command quoted in the input also qualifies. The entire Advisor turn, including
any advice in it, is discarded before dispatch.

The first consecutive quarantine silently resets and re-primes the Advisor with
the latest pending context. A second consecutive quarantine emits one
deduplicated host warning, drops the affected batch, and resets the Advisor
context to break the loop. Any successful Advisor turn resets the quarantine
counter.

## WATCHDOG.md

`WATCHDOG.md` is advisor-only guidance. It is appended to the advisor system prompt; it is not injected into the primary agent's normal context and does not behave like `AGENTS.md`, `RULES.md`, or other context files.

Use it for review priorities: risks the advisor should watch for, project-specific traps, dangerous APIs, architectural boundaries, and quality bars that are useful to a reviewer but too noisy for the main executor.

Example:

```markdown
# Watchdog notes

Especially watch for:

- Changes that bypass the durable queue in `src/jobs/`.
- UI renderer paths that display unsanitized tool output.
- New worker spawns that do not re-enter the CLI host.
```

### Discovery locations

`discoverWatchdogFiles(cwd, agentDir)` loads every readable candidate from these locations:

1. user level: `<active agent dir>/WATCHDOG.md` (`~/.omp/agent/WATCHDOG.md` by default; relocated by `PI_CODING_AGENT_DIR`)
2. project levels while walking from `cwd` upward to the git repository root, or to the home directory when no repo root is found:
   - `<dir>/WATCHDOG.md`
   - `<dir>/.omp/WATCHDOG.md`

Unlike native context files, watchdog discovery does not stop at the nearest project file. Multiple project watchdog files can load together.

Candidates in hidden owner directories are ignored unless the file is inside an `.omp` directory. This keeps unrelated dot-directory conventions from being picked up accidentally while still allowing `.omp/WATCHDOG.md`.

### `@` imports

`WATCHDOG.md` content is expanded with the same `@` import helper used by context files:

- relative imports resolve from the importing file's directory
- `~/` resolves from the user's home directory
- imports inside fenced code blocks and inline code spans stay literal
- cycles are skipped
- missing or unreadable imports leave the original `@path` text in place

### Prompt order

Loaded watchdog blocks are sorted as:

1. user-level `WATCHDOG.md`
2. project-level files from farther ancestors down toward `cwd`

Each file is appended to the advisor system prompt as:

```xml
Especially pay attention to:
<attention>
...expanded watchdog content...
</attention>
```

Later project files sit closer to the end of the advisor prompt, so narrower directory guidance is more prominent than broad ancestor guidance.

## WATCHDOG.yml

`WATCHDOG.yml` (or `WATCHDOG.yaml`) is the advisor roster. Where `WATCHDOG.md` supplies review priorities, `WATCHDOG.yml` declares the advisors themselves — one entry per name, each with its own enable flag, model, and specialization prompt. Advisors use the same host-owned final-response contract described above. The interactive `/advisor configure` overlay edits this file in place. Files that fail to parse or fail schema validation are logged and skipped so one bad project config cannot kill the session.

Example:

```yaml
instructions: |
  Everyone: prefer diffs that keep tests unified.

advisors:
  - name: Architecture
    enabled: true
    model: anthropic/claude-sonnet-4-5:medium
    instructions: |
      Watch cross-module coupling and public-API growth.

  - name: Fixer
    enabled: false
    model: anthropic/claude-sonnet-4-5:high
    instructions: |
      You may edit and run tests to prove a fix locally, then advise.
```

Fields:

- `instructions` (top level): shared prompt prepended to every advisor's system prompt alongside `WATCHDOG.md`. Concatenated across all discovered `WATCHDOG.yml` files.
- `advisors[].name`: human label; slugified for the session id and its `__advisor.<slug>.jsonl` filename. Duplicate slugs across files are resolved by the same specificity rule as `WATCHDOG.md` discovery (project leaf > project ancestor > user).
- `advisors[].enabled`: optional per-advisor switch, default `true`. `false` leaves the advisor visible as paused in status/configuration.
- `advisors[].model`: optional model selector with optional `:level` thinking suffix (e.g. `x-ai/grok-code-fast:high`). Omitted → the advisor uses `modelRoles.advisor`.
- `advisors[].instructions`: this advisor's specialization, appended after the shared baseline. Both instruction fields expand `@path` imports like `WATCHDOG.md`.

### Discovery locations

`WATCHDOG.yml`/`WATCHDOG.yaml` share the same user + project search path as `WATCHDOG.md`: the user-level `<active agent dir>/WATCHDOG.yml` plus every `WATCHDOG.yml`/`.omp/WATCHDOG.yml` encountered while walking from `cwd` up to the repository root (or the home directory when no repo root is found). All discovered files are loaded together; a more-specific file (project leaf > project ancestor > user) replaces an earlier entry with the same advisor slug.

## Subagents

`advisor.subagents` controls whether spawned IPython task subagents also get an advisor runtime.

- `false` (default): only the main session can run an advisor.
- `true`: eligible subagent sessions build their own advisor subsystem with the same settings/model-role resolution, then rerun both `WATCHDOG.md` and `WATCHDOG.yml` discovery for that subagent session's `cwd` and agent directory.

Subagent advisors remain isolated from the subagent's primary tool session in the same way the main advisor is isolated from the main agent.

## Cost and context behavior

Advisor usage is separate model usage. `/advisor status` reports advisor token counts and cost from the advisor agent's own transcript.

The advisor has its own append-only context. Before each advisor prompt, `AgentSession` estimates incoming tokens and may maintain advisor context:

1. try model-level context promotion when enabled and a larger compatible model is available
2. if promotion cannot fit enough context, compact the advisor's own message history
3. if compaction has no candidates or still cannot fit, re-prime from the current bounded primary transcript

The advisor's live context is in-memory and append-only; it is retained while the session runs so `/advisor dump` can inspect it, and is independently promoted/compacted/re-primed (above). It is not a replacement for the primary persisted transcript.

## Transcript persistence and observability

The advisor is a passive reviewer with its own model usage, so — like a task subagent — every finalized advisor turn is appended to JSONL inside the owning session's artifacts directory:

- legacy/default advisor: `<session>/__advisor.jsonl`
- named advisor: `<session>/__advisor.<slug>.jsonl`
- subagent advisor (`advisor.subagents: true`): `<session>/<SubId>/__advisor[.<slug>].jsonl`

Paths derive from the owning session file (not the shared artifacts root), so each primary/subagent advisor writes a distinct file. The reserved `__advisor` stem cannot collide with a task subagent id.

Why a file:

- **Usage attribution.** `omp stats` scans each session folder recursively, so advisor assistant turns (with their usage/cost) are attributed to the same project/session like any other subagent. Advisor "session update" prompts are persisted as `synthetic`, agent-attributed user messages so they never inflate user-message metrics.
- **Observability.** [Agent Hub](./agent-hub.md) discovers legacy and named `__advisor*.jsonl` files on open and shows each as a read-only `advisor`-kind transcript under its owning session.

The file follows session switches: on `/new`, resume/switch, and branch the recorder reopens at the new session's path on the next advisor turn; before a `/drop` deletes the old artifacts dir the recorder feed is detached and drained so a queued write cannot recreate the deleted file. The on-disk log is append-only and independent of the in-memory context — re-primes and compaction never truncate it.

The advisor is never a peer. The `advisor`-kind registry ref is excluded from every agent-facing surface — the `hub` peer roster and broadcast targets, the subagent peer prompt, and the `history://` index/lookup/completions — and cannot be messaged (`hub` send and collab chat refuse it) or [revived or killed from Agent Hub](./agent-hub.md#persisted-agents-and-advisors) or collab. It is not addressable as a peer, regardless of what tools it has been granted.

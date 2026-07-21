# cron_create

> Schedule a prompt for delivery at a future local-time cron match.

## Source
- Entry: `packages/coding-agent/src/tools/cron.ts` (`CronCreateTool`)
- Scheduler: `packages/coding-agent/src/cron.ts` (`CronManager.create`, `nextCronFire`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-create.md`
- Session delivery: `packages/coding-agent/src/sdk.ts` and `packages/coding-agent/src/session/agent-session.ts` (`deliverScheduledPrompt`)

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `expression` | `string` | Yes | Standard five-field cron expression in the machine's local time: minute, hour, day-of-month, month, day-of-week. |
| `prompt` | `string` | Yes | Prompt text to enqueue when the job fires. It must not be empty after trimming. |
| `recurring` | `boolean` | No | Repeat on each match. Defaults to `true`; `false` creates a one-shot. |
| `durable` | `boolean` | No | Persist across process/session restart. Defaults to `false`; requires a persisted session. |

## Outputs

- Success returns one text block beginning `Scheduled <job id> | <expression> | next <local time> | ...`.
- `details` is the created `CronJob`: `id`, `expression`, `prompt`, `recurring`, `durable`, `createdAt`, optional `expiresAt`, and `nextFireAt`.
- The returned job id is the `id` accepted by `cron_delete`.

## Flow

1. The tool requires a session `CronManager`; unavailable scheduling throws an error.
2. `CronManager.create` validates the prompt and five-field expression, computes the next matching local minute, assigns a `cron-...` id, persists durable state, and arms the scheduler timer.
3. Recurring jobs expire after seven days. One-shot jobs are removed before their prompt is enqueued at the first due match.
4. A due job is marked consumed or rescheduled before delivery is enqueued; durable state is persisted at that point. During an active turn, the session emits one system-authored custom notification after the next completed tool call; it does not interrupt that call or wait for Escape. While idle, the notification wakes a turn.

## Side Effects

- Session state: adds the job to the current session's schedule and starts or re-arms its timer.
- Filesystem: durable jobs are written to `scheduled_tasks.json` under the persisted session's steering directory; session-only jobs remain in memory.
- Delivery: a later fire enqueues the prompt through the session's scheduled-notification yield channel.

## Limits & Caps

- Expressions have exactly five fields. Minutes are `0..59`, hours `0..23`, days-of-month `1..31`, months `1..12`, and days-of-week `0..7` (`7` aliases Sunday); ranges, lists, and steps are supported.
- The next match search is bounded to one year. A recurring job's lifetime is seven days, including its final matching fire.
- There is no separate prompt-length cap in this tool's schema.

## Errors

- `Cron scheduling is not available in this session.` when the session has no cron manager.
- `Cron prompt cannot be empty.` for blank prompt text.
- `Durable cron jobs require a persisted session.` when `durable=true` has no persisted session.
- Invalid field counts, values, ranges, or steps throw validation errors; an expression with no match within one year also throws.
- Delivery failures are emitted as process warnings by the scheduler; the create call itself only succeeds after durable persistence completes.

## Notes

- Durable missed one-shots are loaded with their fire time set to now and are surfaced when the resumed session becomes idle. Missed recurring jobs advance to their next future match; expired recurring jobs are dropped.
- Recurring defaults to `true` and durable defaults to `false`; set both explicitly when the intended lifecycle matters.

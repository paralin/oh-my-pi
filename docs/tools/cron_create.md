# cron_create

> Schedule a prompt with a standard five-field cron expression.

## Source

- Entry: `packages/coding-agent/src/tools/cron.ts`
- Scheduler: `packages/coding-agent/src/cron.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-create.md`

## Availability

The cron tools are not part of the default tool set. Activate them with `--tools` alongside the tools the session needs, for example `--tools read,bash,cron_create,cron_list,cron_delete`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `expression` | `string` | Yes | Five-field cron expression evaluated in local time. |
| `prompt` | `string` | Yes | Prompt delivered when the job fires. |
| `recurring` | `boolean` | No | Repeat on every match. Defaults to `true`. |
| `durable` | `boolean` | No | Persist across sessions. Defaults to `false`. |

## Outputs

The text result names the job ID, expression, next-fire time, recurrence, expiry, and durability. Structured details contain the created `CronJob`.

## Flow

`CronCreateTool` forwards the validated input to the session's `CronManager`. A fired job reaches `AgentSession.deliverScheduledPrompt` as a system notification. Active turns receive it at the next tool boundary, and an idle session wakes a turn for it. One-shot jobs delete themselves after firing. Recurring jobs expire after seven days by default.

## Errors

The tool throws `Cron scheduling is not available in this session.` when the session has no `CronManager`. Invalid expressions are rejected by the scheduler.

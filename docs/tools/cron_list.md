# cron_list

> List scheduled prompt jobs for the current session.

## Source

- Entry: `packages/coding-agent/src/tools/cron.ts`
- Scheduler: `packages/coding-agent/src/cron.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-list.md`

## Availability

The cron tools are not part of the default tool set. Activate them with `--tools` alongside the tools the session needs, for example `--tools read,bash,cron_create,cron_list,cron_delete`.
## Inputs

The tool accepts no fields.

## Outputs

The text result is `No scheduled jobs.` when the list is empty. Otherwise each row contains the job ID, cron expression, next-fire time, recurrence and expiry, and durability. Structured details contain `{ jobs: CronJob[] }`.

## Flow

`CronListTool` reads the current session's `CronManager`. The list includes in-memory session jobs and durable jobs loaded for that session. The returned job ID is the input accepted by `cron_delete`.

## Errors

The tool throws `Cron scheduling is not available in this session.` when the session has no `CronManager`.

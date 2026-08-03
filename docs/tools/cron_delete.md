# cron_delete

> Delete a scheduled prompt job by ID.

## Source

- Entry: `packages/coding-agent/src/tools/cron.ts`
- Scheduler: `packages/coding-agent/src/cron.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-delete.md`

## Availability

The cron tools are not part of the default tool set. Activate them with `--tools` alongside the tools the session needs, for example `--tools read,bash,cron_create,cron_list,cron_delete`.
## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Job ID returned by `cron_create` or `cron_list`. |

## Outputs

The text result reports either `Deleted <id>.` or `No job found for <id>.`. Structured details contain `{ deleted: boolean }`.

## Flow

`CronDeleteTool` asks the current session's `CronManager` to remove the job. Deletion is immediate and prevents future delivery. Removing a durable job updates its persisted session record.

## Errors

The tool throws `Cron scheduling is not available in this session.` when the session has no `CronManager`.

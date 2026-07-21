# cron_delete

> Delete a scheduled prompt by its exact job id.

## Source
- Entry: `packages/coding-agent/src/tools/cron.ts` (`CronDeleteTool`)
- Scheduler: `packages/coding-agent/src/cron.ts` (`CronManager.delete`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-delete.md`

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `id` | `string` | Yes | Exact job id returned by `cron_create` or `cron_list`. |

## Outputs

- When the id exists, the text is `Deleted <id>.` and `details` is `{ deleted: true }`.
- When the id is absent, the text is `No job found for <id>.` and `details` is `{ deleted: false }`.

## Flow

1. The tool requires a session `CronManager`; unavailable scheduling throws an error.
2. `CronManager.delete` refreshes the current session and removes the exact id from its in-memory job map.
3. A successful deletion persists the remaining durable jobs and re-arms the scheduler timer. The removed job cannot enqueue a future prompt.
4. Deleting an already-fired one-shot or an expired recurring job is safe and returns the not-found result.

## Side Effects

- Session state: removes the matching scheduled job and updates the next timer when deletion succeeds.
- Filesystem: when a persisted session is active, a successful deletion rewrites its `scheduled_tasks.json` with the remaining durable jobs.
- Delivery: no prompt is delivered by the delete operation itself.

## Limits & Caps

- The id is matched exactly; this tool does not accept cron expressions, partial ids, or bulk deletion.
- Only jobs in the current session's schedule can be deleted.
- Durable recurring jobs expire after seven days, while one-shot jobs are removed at their first due fire.

## Errors

- `Cron scheduling is not available in this session.` when the session has no cron manager.
- Invalid or unknown ids are not exceptions; they produce `deleted: false` and explanatory text.
- Persistence or session-store errors are surfaced by the scheduler manager.

## Notes

- `cron_create` returns the id needed here. Use `cron_list` to inspect current ids and lifecycle state before deleting.
- Deletion is immediate for the manager's current session and prevents future enqueue while the job remains removed.

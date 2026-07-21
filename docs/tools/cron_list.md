# cron_list

> List scheduled prompts for the current session.

## Source
- Entry: `packages/coding-agent/src/tools/cron.ts` (`CronListTool`)
- Scheduler: `packages/coding-agent/src/cron.ts` (`CronManager.list`, `parseStoredJobs`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/cron-list.md`

## Inputs

This tool takes an empty object: `{}`.

## Outputs

- With no jobs, the text is `No scheduled jobs.`.
- Otherwise, one line is returned per job: `<id> | <expression> | next <local time> | recurring/one-shot | durable/session-only`.
- `details` is `{ jobs: CronJob[] }`, sorted by `nextFireAt`; each job includes its prompt and lifecycle timestamps in addition to the displayed fields.

## Flow

1. The tool requires a session `CronManager`; unavailable scheduling throws an error.
2. `CronManager.list` refreshes the current session and lazily loads its durable schedule, then sorts jobs by their next fire time.
3. Listing does not enqueue a prompt or explicitly create or delete a job. Refreshing may normalize a missed recurring job to its next future match and arm its timer. A durable missed one-shot remains listed with an immediate fire time until the resumed session becomes idle and processes it; expired recurring jobs are not loaded.

## Side Effects

- Session state: may load the current session's durable `scheduled_tasks.json` into the manager's in-memory session map.
- Filesystem: reads the durable schedule under the persisted session's steering directory when that session has not been loaded yet.
- No prompt is enqueued by a successful list; refresh may normalize loaded missed jobs as described above.

## Limits & Caps

- Results are scoped to the current session and are sorted by the next local fire time.
- Displayed timestamps use the local time zone through `toLocaleString()`.
- The scheduler accepts five-field cron expressions with minute `0..59`, hour `0..23`, day-of-month `1..31`, month `1..12`, and day-of-week `0..7` (`7` aliases Sunday), with lists, ranges, and steps.
- Recurring jobs have a seven-day lifetime; one-shot jobs have no recurring expiry.

## Errors

- `Cron scheduling is not available in this session.` when the session has no cron manager.
- A malformed durable store, invalid stored cron expression, or unreadable non-missing store error is surfaced while the session refreshes.

## Notes

- Durable jobs are the jobs retained in `scheduled_tasks.json`; session-only jobs exist only in memory and disappear when that session state is gone.
- A durable one-shot whose fire time was missed during shutdown is retained for catch-up until idle delivery, then is removed before enqueue.

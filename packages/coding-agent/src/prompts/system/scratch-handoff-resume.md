{{#if scratchMissing}}
No scratch checkpoint exists yet. Continue current task from live conversation. Do not read `{{displayPath}}`; create it only when explicit closeout requests a checkpoint.
{{else}}
Resume existing work from supplied scratch checkpoint.
Choose skills from active TODO + next action. Load only first executable step's needed skill; skip stale, historical, duplicate entries; apply normal matching for missing skills. NEVER replay full stack or restart orientation.
Injected checkpoint and recent delta are continuation state. Do not summarize, reconstruct completed work, or rerun stable checks unless newer evidence invalidates them.
{{#if scratchTruncated}}Only checkpoint beginning is injected. Read `{{displayPath}}` only if active TODO, next action, or a required referenced detail is missing below.{{else}}Do not reread `{{displayPath}}`; full checkpoint is supplied.{{/if}}
Batch first step's live checks and execute in same turn. Do not repeat startup repair.

{{#if parentDisplayPath}}Parent scratch: {{parentDisplayPath}}
{{/if}}<scratch-handoff-context>
Path: {{displayPath}}

{{scratchText}}
</scratch-handoff-context>
{{#if recentContextText}}
<recent-session-context>
Session context newer than checkpoint:

{{recentContextText}}
</recent-session-context>
{{/if}}
{{#if recentContextSnapcompactFrames}}
<recent-session-context>
Complete post-checkpoint delta: {{recentContextSnapcompactFrames}} attached SnapCompact frames. Read before continuing; newer tool results, decisions, verification override checkpoint.
</recent-session-context>
{{/if}}
{{/if}}

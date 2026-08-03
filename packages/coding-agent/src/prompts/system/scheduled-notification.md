{{#if multiple}}{{prompts.length}} scheduled tasks fired. These are system notifications, not user messages; act on them now that the current step has completed.
{{else}}A scheduled task fired. This is a system notification, not a user message; act on it now that the current step has completed.
{{/if}}
{{#each prompts}}<scheduled-task>
{{this}}
</scheduled-task>{{#unless @last}}

{{/unless}}{{/each}}

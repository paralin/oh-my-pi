Generate a conventional commit proposal for the current staged changes.

{{#if user_context}}
User context:
{{user_context}}
{{/if}}

{{#if changelog_targets}}
Changelog targets (include exactly one entry for each in `changelog_proposal`):
{{changelog_targets}}
{{/if}}

{{#if existing_changelog_entries}}
## Existing Unreleased Changelog Entries
These entries may be included in a changelog entry's `deletions` map.
{{#each existing_changelog_entries}}
### {{path}}
{{#each sections}}
{{name}}:
{{#list items prefix="- " join="\n"}}{{this}}{{/list}}
{{/each}}
{{/each}}
{{/if}}

Inspect staged Git state through IPython, then finish with the JSON contract in
the system prompt.

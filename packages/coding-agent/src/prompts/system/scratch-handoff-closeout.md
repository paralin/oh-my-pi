Context maintenance threshold reached. PENCILS DOWN.
Maintenance only: before more task work, run exactly one `ipython {code}` cell. Use `from pathlib import Path`, bind `scratch = Path("{{displayPath}}")`, make `scratch.parent` when needed, and call `scratch.write_text(..., encoding="utf-8")` to {{#if create}}create{{else}}update{{/if}} that exact path.
{{#if create}}Create one bounded Org checkpoint with root metadata and exactly one active `* TODO` subtree.{{else}}Keep exactly one active `* TODO` subtree; revise the document at that same path without renaming it.{{/if}}
Checkpoint MUST capture current objective; only immediately required skills; completed work; touched files; current proof; blockers/risks; executable next action; continuation source refs.
Remove completed-history subtrees and copied plans, queues, logs, traces, or large evidence; preserve them through links.
After successful `ipython`, NEVER reread or verify scratch. END TURN immediately: no task work, other cells, user-facing status, or path mention. Runtime observes the changed document; successor resumes.

[IMPORTANT: The user has invoked the "{{name}}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]

{{body}}

---

[Skill directory: {{baseDir}}]
Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) against that directory using its absolute path: load referenced assets and templates with Python, and run scripts from an IPython `%%bash` cell when the skill's instructions call for it.
{{#if userArgs}}
User: {{userArgs}}
{{/if}}

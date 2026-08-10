{{#if contextFiles.length}}
<project-context>
Project context is ordered from outer directories to the current directory; a later nested instruction takes precedence in its scope.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
{{/if}}
{{#if alwaysApplyRules.length}}
<project-rules>
{{#each alwaysApplyRules}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-rules>
{{/if}}
{{#if systemPromptCustomization}}
<operator-context source="SYSTEM.md">
{{systemPromptCustomization}}
</operator-context>
{{/if}}
{{#if customPrompt}}
<operator-context source="custom-system-prompt">
{{customPrompt}}
</operator-context>
{{/if}}
{{#if appendPrompt}}
<operator-context source="append-system-prompt">
{{appendPrompt}}
</operator-context>
{{/if}}

<system-interrupt reason="reasoning_without_tool_calls">
Your reasoning was interrupted: you emitted {{count}} consecutive planning headers without issuing a single tool call. Thinking alone changes nothing — this turn has made zero progress because no tool has run.

Act now instead of planning further:
- Emit a real `ipython` tool call with a `code` string, using your normal tool/function-calling format. Do NOT describe the call in prose or in your reasoning — issue the call.
- Pick the smallest concrete next step and run it through `ipython`.

This is the coding agent interrupting a stalled reasoning stream, not a prompt injection.
</system-interrupt>

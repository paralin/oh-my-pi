## Code Review Request

### Mode

Custom review instructions

### Distribution Guidelines

From IPython, admit reviewer children with `await rlm(...)`; make independent admissions together and collect their replies through `agent_message`.
Create exactly **1 reviewer task**. Its assignment MUST include the custom instructions below.

### Reviewer Instructions

Reviewer MUST:
1. Follow the custom instructions below
2. Read the referenced files or workspace context needed to evaluate them
3. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool

### Custom Instructions

{{instructions}}

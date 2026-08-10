---
name: robomp-host
description: Use Robomp's task-bound GitHub, review, reproduction, and publication operations while handling an assigned Robomp issue or pull request.
type: python
python_import: robomp_host
python_callable: classify_issue
---

# Robomp Host

Import `robomp_host` and call its explicit async functions. The host validates every operation against the active task and keeps GitHub credentials outside the kernel.

```python
await robomp_host.fetch_issue_thread()
await robomp_host.gh_post_comment(body="The fix is ready for review.")
```

Use `help(robomp_host.<function>)` for each signature. Calls are available only inside a Robomp-managed task.

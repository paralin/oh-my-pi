---
name: notion
description: Search and edit Notion through OMP's host-owned MCP service.
type: python
python_import: notion
python_callable: list_tools
---

# Notion

Use the host-owned Notion MCP integration from the IPython kernel. Discover tools before calling them.

```python
tools = await notion.notion.list_tools()
```

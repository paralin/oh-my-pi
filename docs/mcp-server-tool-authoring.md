# MCP server authoring

An MCP server exposes its methods, resources, prompts, and schemas through its
own protocol. Configure the server in OMP's MCP configuration. OMP keeps the
connection in the host and presents it to IPython through `omp.mcp`, not as a
provider function catalog.

```python
import omp

methods = await omp.mcp.list_tools("project")
result = await omp.mcp.call_tool("project", methods[0]["name"], {})
```

Design server schemas so callers can recover required fields and bounds without
out-of-band conventions. Return structured values or a clear protocol error.
The OMP host validates the typed Python request, holds credentials and transport
state, propagates cancellation, and returns the MCP result to the active cell.

See [MCP configuration](./mcp-config.md), [MCP runtime lifecycle](./mcp-runtime-lifecycle.md),
and [Persistent IPython runtime](./ipython.md).

# MCP runtime lifecycle

OMP connects configured Model Context Protocol servers in the host. The model
does not receive one provider function per MCP method. An IPython cell calls the
typed `omp.mcp` module instead.

```python
import omp

servers = await omp.mcp.servers()
tools = await omp.mcp.list_tools("project")
result = await omp.mcp.call_tool("project", "search", {"query": "IPython"})
```

`omp.mcp` also lists and reads resources, lists and renders prompts, returns
non-credential server configuration, refreshes a connection, and observes
notifications. The host owns discovery, credentials, transports, reconnects, cancellation,
and schema validation. A slow or unavailable server
returns a typed host error to the active cell; it does not change the provider
interface.

See [MCP configuration](./mcp-config.md) and [Persistent IPython runtime](./ipython.md).

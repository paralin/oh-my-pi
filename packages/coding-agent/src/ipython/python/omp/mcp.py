"""Host-owned MCP discovery and invocation."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def servers() -> dict[str, Any]:
    return await host_request("mcp.list_servers")


async def call_tool(server: str, tool: str, arguments: dict[str, Any] | None = None) -> Any:
    return (await host_request("mcp.call_tool", {"server": server, "tool": tool,
                                                 "arguments": arguments or {}})).get("result")


async def read_resource(server: str, uri: str) -> Any:
    return (await host_request("mcp.read_resource", {"server": server, "uri": uri})).get("result")


async def get_prompt(server: str, name: str, arguments: dict[str, str] | None = None) -> Any:
    return (await host_request("mcp.get_prompt", {"server": server, "name": name,
                                                  "arguments": arguments or {}})).get("result")

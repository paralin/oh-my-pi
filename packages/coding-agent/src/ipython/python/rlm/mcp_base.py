"""Host-owned MCP integrations exposed through OMP's typed bridge."""

from __future__ import annotations

import json
from typing import Any

from . import host_request

__all__ = ["McpIntegration", "McpToolError", "NotEnabled"]


class NotEnabled(RuntimeError):
    """Raised when an OMP MCP integration has no usable host credential."""

    def __init__(self, server: str):
        self.server = server
        super().__init__(
            f"The '{server}' integration is not enabled. Tell the user to run `/mcp login {server}`."
        )


class McpToolError(RuntimeError):
    """Raised when an MCP operation returns an error."""


class McpIntegration:
    """Subclass and set ``server``; OMP keeps transport and credentials host-side."""

    server: str = ""

    def __init__(self) -> None:
        if not isinstance(self.server, str) or not self.server:
            raise ValueError(f"{type(self).__name__} must set a non-empty `server`")
        self._tools: dict[str, dict[str, Any]] | None = None

    async def list_tools(self) -> list[dict[str, Any]] | dict[str, Any]:
        payload = await host_request("mcp.list_tools", {"server": self.server})
        tools = payload.get("tools")
        if isinstance(tools, dict) and tools.get("truncated") is True:
            return tools
        if not isinstance(tools, list):
            raise TypeError("OMP returned an invalid MCP tool list")
        self._tools = {
            item["name"]: dict(item)
            for item in tools
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        return list(self._tools.values())

    async def call_tool(
        self, tool: str, arguments: dict[str, Any] | None = None
    ) -> Any:
        if not isinstance(tool, str) or not tool:
            raise ValueError("tool must be a non-empty str")
        payload = await host_request(
            "mcp.call_tool",
            {"server": self.server, "tool": tool, "arguments": arguments or {}},
        )
        if payload.get("is_error"):
            raise McpToolError(
                str(
                    payload.get("error")
                    or payload.get("result")
                    or "MCP tool returned an error"
                )
            )
        return payload.get("result")

    async def config(self) -> dict[str, Any]:
        """Return non-credential host configuration for this server."""
        return await host_request("mcp.config", {"server": self.server})

    async def refresh(self) -> dict[str, Any]:
        """Reconnect this server through OMP's host-owned auth and transport."""
        return await host_request("mcp.refresh", {"server": self.server})

    async def list_resources(self) -> list[dict[str, Any]] | dict[str, Any]:
        payload = await host_request("mcp.list_resources", {"server": self.server})
        resources = payload.get("resources")
        if isinstance(resources, dict) and resources.get("truncated") is True:
            return resources
        if not isinstance(resources, list):
            raise TypeError("OMP returned an invalid MCP resource list")
        return resources

    async def resource_templates(self) -> list[dict[str, Any]] | dict[str, Any]:
        """Return URI templates advertised by this MCP server."""
        payload = await host_request("mcp.list_resources", {"server": self.server})
        templates = payload.get("templates")
        if isinstance(templates, dict) and templates.get("truncated") is True:
            return templates
        if not isinstance(templates, list):
            raise TypeError("OMP returned an invalid MCP resource-template list")
        return templates

    async def read_resource(self, uri: str) -> Any:
        return (
            await host_request("mcp.read_resource", {"server": self.server, "uri": uri})
        ).get("result")

    async def list_prompts(self) -> list[dict[str, Any]] | dict[str, Any]:
        payload = await host_request("mcp.list_prompts", {"server": self.server})
        prompts = payload.get("prompts")
        if isinstance(prompts, dict) and prompts.get("truncated") is True:
            return prompts
        if not isinstance(prompts, list):
            raise TypeError("OMP returned an invalid MCP prompt list")
        return prompts

    async def get_prompt(
        self, name: str, arguments: dict[str, str] | None = None
    ) -> Any:
        return (
            await host_request(
                "mcp.get_prompt",
                {"server": self.server, "name": name, "arguments": arguments or {}},
            )
        ).get("result")

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        async def call(**kwargs: Any) -> Any:
            if self._tools is None:
                await self.list_tools()
            if self._tools is not None and name not in self._tools:
                available = ", ".join(sorted(self._tools)) or "(none)"
                raise AttributeError(
                    f"'{self.server}' has no tool '{name}'. Available: {available}"
                )
            return await self.call_tool(name, kwargs)

        call.__name__ = name
        if self._tools and name in self._tools:
            item = self._tools[name]
            call.__doc__ = f"{item.get('description', '')}\n\nArguments (JSON Schema):\n{json.dumps(item.get('inputSchema', {}), indent=2)}"
        return call

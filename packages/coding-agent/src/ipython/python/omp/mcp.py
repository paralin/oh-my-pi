"""Host-owned MCP discovery and invocation."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def servers() -> dict[str, Any]:
    """List configured MCP servers without credentials."""
    return await host_request("mcp.list_servers")


async def list_tools(
    server: str, *, refresh: bool = False
) -> list[dict[str, Any]] | dict[str, Any]:
    """List tools exposed by one host-connected MCP server."""
    return (
        await host_request("mcp.list_tools", {"server": server, "refresh": refresh})
    ).get("tools", [])


async def call_tool(
    server: str, tool: str, arguments: dict[str, Any] | None = None
) -> Any:
    """Call an MCP tool through the host-owned transport."""
    response = await host_request(
        "mcp.call_tool",
        {"server": server, "tool": tool, "arguments": arguments or {}},
    )
    result = response.get("result")
    if response.get("is_error"):
        raise RuntimeError(f"MCP tool returned an error: {result}")
    return result


async def list_resources(server: str, *, refresh: bool = False) -> dict[str, Any]:
    """List resources and resource templates."""
    return await host_request(
        "mcp.list_resources", {"server": server, "refresh": refresh}
    )


async def resource_templates(
    server: str, *, refresh: bool = False
) -> list[dict[str, Any]] | dict[str, Any]:
    """List URI templates exposed by one MCP server."""
    return (
        await host_request(
            "mcp.resource_templates", {"server": server, "refresh": refresh}
        )
    ).get("templates", [])


async def read_resource(server: str, uri: str) -> Any:
    """Read one MCP resource."""
    return (
        await host_request("mcp.read_resource", {"server": server, "uri": uri})
    ).get("result")


async def list_prompts(
    server: str, *, refresh: bool = False
) -> list[dict[str, Any]] | dict[str, Any]:
    """List prompts exposed by one MCP server."""
    return (
        await host_request("mcp.list_prompts", {"server": server, "refresh": refresh})
    ).get("prompts", [])


async def get_prompt(
    server: str, name: str, arguments: dict[str, str] | None = None
) -> Any:
    """Render one MCP prompt."""
    return (
        await host_request(
            "mcp.get_prompt",
            {"server": server, "name": name, "arguments": arguments or {}},
        )
    ).get("result")


async def config(server: str) -> dict[str, Any]:
    """Return one server's non-credential host configuration."""
    return await host_request("mcp.config", {"server": server})


async def refresh(server: str) -> dict[str, Any]:
    """Reconnect one server and refresh its host-owned capabilities."""
    return await host_request("mcp.refresh", {"server": server})


async def notification_state() -> dict[str, Any]:
    """Return notification enablement and redacted subscriptions."""
    return await host_request("mcp.notification_state")


async def wait_notification(
    server: str | None = None, method: str | None = None, *, timeout: int = 30
) -> dict[str, Any]:
    """Wait for one matching server notification; timeout is in seconds, zero is indefinite."""
    payload: dict[str, Any] = {"timeout": timeout}
    if server is not None:
        payload["server"] = server
    if method is not None:
        payload["method"] = method
    return await host_request("mcp.wait_notification", payload)

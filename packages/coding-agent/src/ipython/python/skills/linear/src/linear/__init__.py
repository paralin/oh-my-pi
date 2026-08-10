"""Linear integration through OMP's host-owned MCP transport."""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Linear", "linear"]


class Linear(McpIntegration):
    server = "linear"
    url = "https://mcp.linear.app/mcp"


linear = Linear()
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(linear, name)

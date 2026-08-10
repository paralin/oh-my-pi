"""Notion integration through OMP's host-owned MCP transport."""

from __future__ import annotations

from rlm import McpIntegration

__all__ = ["Notion", "notion"]


class Notion(McpIntegration):
    server = "notion"
    url = "https://mcp.notion.com/mcp"


notion = Notion()
_RESERVED = {"run", "__wrapped__", "__call__"}


def __getattr__(name: str):
    if name.startswith("_") or name in _RESERVED:
        raise AttributeError(name)
    return getattr(notion, name)

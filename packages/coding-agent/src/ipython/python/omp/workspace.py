"""Validated OMP workspace services beyond ordinary pathlib and %%bash use."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def search(query: str, *, paths: list[str] | None = None, limit: int = 200) -> dict[str, Any]:
    """Search the workspace and return matches plus hashline snapshot headers."""
    return await host_request("workspace.search", {"query": query, "paths": paths or [], "limit": limit})


async def edit(path: str, old_str: str, new_str: str) -> dict[str, Any]:
    """Apply OMP's validated exact edit and return structured diff metadata."""
    return await host_request("workspace.edit", {"path": path, "old_str": old_str, "new_str": new_str})


async def hashline_edit(input: str) -> dict[str, Any]:
    """Apply one OMP hashline section anchored to a workspace.search snapshot."""
    return await host_request("workspace.hashline_edit", {"input": input})

"""Host-owned OMP rule records."""

from __future__ import annotations

from typing import Any

from ._managed import create_entry, delete_entry, get_entry, list_entries, update_entry


async def list(*, global_: bool = False) -> list[dict[str, Any]]:
    """List bounded managed rule records."""
    return await list_entries("rules", global_=global_)


async def get(entry_id: str, *, global_: bool = False) -> dict[str, Any] | None:
    """Get one managed rule record by id."""
    return await get_entry("rules", entry_id, global_=global_)


async def create(
    entry_id: str,
    content: str,
    *,
    description: str = "",
    global_: bool = False,
) -> dict[str, Any]:
    """Create one managed rule record."""
    return await create_entry("rules", entry_id, content, description=description, global_=global_)


async def update(
    entry_id: str,
    content: str,
    *,
    description: str = "",
    global_: bool = False,
) -> dict[str, Any]:
    """Replace one managed rule record."""
    return await update_entry("rules", entry_id, content, description=description, global_=global_)


async def delete(entry_id: str, *, global_: bool = False) -> bool:
    """Delete one managed rule record."""
    return await delete_entry("rules", entry_id, global_=global_)

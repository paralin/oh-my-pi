"""Shared typed CRUD helpers for OMP-managed capability records."""

from __future__ import annotations

from typing import Any

from rlm import host_request


def _scope(global_: bool) -> str:
    if not isinstance(global_, bool):
        raise TypeError("global_ must be a bool")
    return "global" if global_ else "local"


async def list_entries(domain: str, *, global_: bool = False) -> list[dict[str, Any]]:
    payload = await host_request(f"{domain}.list", {"scope": _scope(global_)})
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise RuntimeError(f"OMP returned an invalid {domain} list")
    return entries


async def get_entry(domain: str, entry_id: str, *, global_: bool = False) -> dict[str, Any] | None:
    payload = await host_request(f"{domain}.get", {"id": entry_id, "scope": _scope(global_)})
    entry = payload.get("entry")
    if entry is not None and not isinstance(entry, dict):
        raise RuntimeError(f"OMP returned an invalid {domain} entry")
    return entry


async def create_entry(
    domain: str,
    entry_id: str,
    content: str,
    *,
    description: str = "",
    global_: bool = False,
) -> dict[str, Any]:
    payload = await host_request(
        f"{domain}.create",
        {
            "id": entry_id,
            "content": content,
            "description": description,
            "scope": _scope(global_),
        },
    )
    entry = payload.get("entry")
    if not isinstance(entry, dict):
        raise RuntimeError(f"OMP returned an invalid {domain} entry")
    return entry


async def update_entry(
    domain: str,
    entry_id: str,
    content: str,
    *,
    description: str = "",
    global_: bool = False,
) -> dict[str, Any]:
    payload = await host_request(
        f"{domain}.update",
        {
            "id": entry_id,
            "content": content,
            "description": description,
            "scope": _scope(global_),
        },
    )
    entry = payload.get("entry")
    if not isinstance(entry, dict):
        raise RuntimeError(f"OMP returned an invalid {domain} entry")
    return entry


async def delete_entry(domain: str, entry_id: str, *, global_: bool = False) -> bool:
    payload = await host_request(f"{domain}.delete", {"id": entry_id, "scope": _scope(global_)})
    deleted = payload.get("deleted")
    if not isinstance(deleted, bool):
        raise RuntimeError(f"OMP returned an invalid {domain} deletion result")
    return deleted

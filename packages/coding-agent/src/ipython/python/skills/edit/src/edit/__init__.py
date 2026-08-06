"""Validated exact edit through OMP's host-owned workspace service."""

from __future__ import annotations

from rlm import host_request


async def run(path: str, old_str: str, new_str: str) -> str:
    """Replace one exact, unique string in an existing workspace file.

    The host validates the path, serializes concurrent writers, applies an
    atomic replacement, and publishes OMP's structured diff into this cell.

    Args:
        path: File beneath the active workspace.
        old_str: Exact text to find. It must occur exactly once.
        new_str: Replacement text.

    Returns:
        A short confirmation naming the edited file.
    """
    if not isinstance(path, str) or not path:
        raise TypeError("path must be a non-empty str")
    if not isinstance(old_str, str) or not old_str:
        raise TypeError("old_str must be a non-empty str")
    if not isinstance(new_str, str):
        raise TypeError("new_str must be a str")
    result = await host_request(
        "workspace.edit",
        {"path": path, "old_str": old_str, "new_str": new_str},
    )
    edited_path = result.get("path")
    if not isinstance(edited_path, str):
        raise RuntimeError("OMP returned an invalid edit result")
    return f"Edited {edited_path}"

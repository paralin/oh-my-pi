"""Exact single-occurrence file replacement."""

from __future__ import annotations

from pathlib import Path


async def run(path: str, old_str: str, new_str: str) -> str:
    """Replace one exact, unique string in an existing file."""
    if not isinstance(path, str) or not path:
        raise TypeError("path must be a non-empty str")
    if not isinstance(old_str, str) or not old_str:
        raise TypeError("old_str must be a non-empty str")
    if not isinstance(new_str, str):
        raise TypeError("new_str must be a str")
    target = Path(path)
    content = target.read_text()
    count = content.count(old_str)
    if count != 1:
        message = "old_str was not found" if count == 0 else "old_str must match exactly once"
        raise ValueError(message)
    target.write_text(content.replace(old_str, new_str, 1))
    return f"Edited {target}"

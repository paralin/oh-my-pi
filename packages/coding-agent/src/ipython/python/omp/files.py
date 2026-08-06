"""Bounded host file services for OMP-specific reads, writes, and globs."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def read(path: str, *, offset: int = 1, limit: int = 2000) -> dict[str, Any]:
    """Read bounded UTF-8 lines and record a hashline snapshot."""
    return await host_request("files.read", {"path": path, "offset": offset, "limit": limit})


async def write(path: str, content: str, *, overwrite: bool = False) -> dict[str, Any]:
    """Atomically create or explicitly replace one regular workspace file."""
    return await host_request("files.write", {"path": path, "content": content, "overwrite": overwrite})


async def glob(
    pattern: str,
    *,
    path: str = ".",
    hidden: bool = False,
    gitignore: bool = True,
    limit: int = 200,
) -> dict[str, Any]:
    """Find bounded workspace entries with OMP's native glob owner."""
    return await host_request(
        "files.glob",
        {"pattern": pattern, "path": path, "hidden": hidden, "gitignore": gitignore, "limit": limit},
    )

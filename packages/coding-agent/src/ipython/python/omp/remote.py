"""Host-owned SSH connection, command, and file-transfer services."""

from __future__ import annotations

import base64
from typing import Any

from rlm import host_request


async def hosts() -> dict[str, Any]:
    """List configured SSH hosts without returning key material."""
    return await host_request("remote.hosts", {})


async def ensure(host: str) -> dict[str, Any]:
    """Ensure one shared SSH connection and capability probe are ready."""
    return await host_request("remote.ensure", {"host": host})


async def status(host: str) -> dict[str, Any]:
    """Inspect cached connection and remote host metadata without probing."""
    return await host_request("remote.status", {"host": host})


async def exec(host: str, command: str, *, timeout: int = 30) -> dict[str, Any]:
    """Execute one bounded command through OMP's managed SSH transport."""
    return await host_request(
        "remote.exec", {"host": host, "command": command, "timeout": timeout}
    )


async def read_file(
    host: str, path: str, *, max_bytes: int = 1024 * 1024, timeout: int = 30
) -> dict[str, Any]:
    """Read one bounded UTF-8 file from a POSIX remote."""
    return await host_request(
        "remote.read_file",
        {"host": host, "path": path, "max_bytes": max_bytes, "timeout": timeout},
    )


async def write_file(
    host: str,
    path: str,
    content: str | bytes,
    *,
    timeout: int = 30,
) -> dict[str, Any]:
    """Write one bounded text or byte value through the guarded transfer owner."""
    if isinstance(content, bytes):
        encoded = base64.b64encode(content).decode("ascii")
        encoding = "base64"
    else:
        encoded = content
        encoding = "utf-8"
    return await host_request(
        "remote.write_file",
        {
            "host": host,
            "path": path,
            "content": encoded,
            "encoding": encoding,
            "timeout": timeout,
        },
    )


async def list_dir(
    host: str,
    path: str,
    *,
    offset: int = 0,
    limit: int = 200,
    timeout: int = 30,
) -> dict[str, Any]:
    """List one bounded page of a POSIX remote directory."""
    return await host_request(
        "remote.list_dir",
        {
            "host": host,
            "path": path,
            "offset": offset,
            "limit": limit,
            "timeout": timeout,
        },
    )


async def stat(host: str, path: str, *, timeout: int = 30) -> dict[str, Any]:
    """Classify one remote path as file, directory, other, or missing."""
    return await host_request(
        "remote.stat", {"host": host, "path": path, "timeout": timeout}
    )


async def close(host: str) -> dict[str, Any]:
    """Close one named managed SSH connection and invalidate its host probe."""
    return await host_request("remote.close", {"host": host})


__all__ = [
    "close",
    "ensure",
    "exec",
    "hosts",
    "list_dir",
    "read_file",
    "stat",
    "status",
    "write_file",
]

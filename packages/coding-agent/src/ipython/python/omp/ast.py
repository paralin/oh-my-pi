"""Structural search and rewrite backed by OMP's bundled native engine."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request

Strictness = Literal["cst", "smart", "ast", "relaxed", "signature", "template"]


async def search(
    path: str,
    patterns: list[str],
    *,
    language: str | None = None,
    glob: str | None = None,
    selector: str | None = None,
    strictness: Strictness = "smart",
    limit: int = 50,
    offset: int = 0,
    include_meta: bool = False,
    timeout_ms: int = 0,
) -> dict[str, Any]:
    """Search workspace files with ast-grep patterns through the bundled native engine."""
    payload: dict[str, Any] = {
        "path": path,
        "patterns": patterns,
        "strictness": strictness,
        "limit": limit,
        "offset": offset,
        "include_meta": include_meta,
        "timeout_ms": timeout_ms,
    }
    if language is not None:
        payload["language"] = language
    if glob is not None:
        payload["glob"] = glob
    if selector is not None:
        payload["selector"] = selector
    return await host_request("ast.search", payload)


async def rewrite(
    path: str,
    rewrites: dict[str, str],
    *,
    language: str | None = None,
    glob: str | None = None,
    selector: str | None = None,
    strictness: Strictness = "smart",
    dry_run: bool = True,
    max_replacements: int = 1_000,
    max_files: int = 500,
    fail_on_parse_error: bool = False,
    timeout_ms: int = 0,
) -> dict[str, Any]:
    """Preview or apply bounded structural rewrites within the active workspace."""
    payload: dict[str, Any] = {
        "path": path,
        "rewrites": rewrites,
        "strictness": strictness,
        "dry_run": dry_run,
        "max_replacements": max_replacements,
        "max_files": max_files,
        "fail_on_parse_error": fail_on_parse_error,
        "timeout_ms": timeout_ms,
    }
    if language is not None:
        payload["language"] = language
    if glob is not None:
        payload["glob"] = glob
    if selector is not None:
        payload["selector"] = selector
    return await host_request("ast.rewrite", payload)


__all__ = ["Strictness", "rewrite", "search"]

"""Structural code and language-intelligence services."""

from __future__ import annotations

from typing import Any, Iterable

from rlm import host_request


async def ast_search(
    pattern: str,
    *,
    path: str = ".",
    glob: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> dict[str, Any]:
    """Return structured native AST matches for one bounded workspace scope."""
    return await host_request(
        "code.ast_search",
        {"pattern": pattern, "path": path, "glob": glob or "", "offset": offset, "limit": limit},
    )


async def ast_edit(
    operations: Iterable[tuple[str, str]],
    *,
    path: str = ".",
    glob: str | None = None,
    apply: bool = False,
    max_files: int = 50,
    fail_on_parse_error: bool = True,
) -> dict[str, Any]:
    """Preview or apply bounded structural rewrites through OMP's native AST owner."""
    rewrites = [{"pattern": pattern, "replacement": replacement} for pattern, replacement in operations]
    return await host_request(
        "code.ast_edit",
        {
            "operations": rewrites,
            "path": path,
            "glob": glob or "",
            "apply": apply,
            "max_files": max_files,
            "fail_on_parse_error": fail_on_parse_error,
        },
    )


async def lsp_status() -> dict[str, Any]:
    """Return configured and active language-server state."""
    return await host_request("code.lsp_status", {})


async def definition(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return structured definition locations."""
    return await host_request("code.definition", {"file": file, "line": line, "symbol": symbol or ""})


async def type_definition(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return structured type-definition locations."""
    return await host_request("code.type_definition", {"file": file, "line": line, "symbol": symbol or ""})


async def implementation(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return structured implementation locations."""
    return await host_request("code.implementation", {"file": file, "line": line, "symbol": symbol or ""})


async def references(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return structured reference locations."""
    return await host_request("code.references", {"file": file, "line": line, "symbol": symbol or ""})


async def hover(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return the language server's structured hover value."""
    return await host_request("code.hover", {"file": file, "line": line, "symbol": symbol or ""})


async def symbols(file: str) -> dict[str, Any]:
    """Return bounded structured document symbols."""
    return await host_request("code.symbols", {"file": file})


async def diagnostics(file: str) -> dict[str, Any]:
    """Request bounded structured pull diagnostics for one file."""
    return await host_request("code.diagnostics", {"file": file})


async def rename(
    file: str,
    new_name: str,
    *,
    line: int = 1,
    symbol: str | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    """Preview or apply one language-server workspace rename."""
    return await host_request(
        "code.rename",
        {"file": file, "line": line, "symbol": symbol or "", "new_name": new_name, "apply": apply},
    )


async def code_actions(file: str, *, line: int = 1, symbol: str | None = None) -> dict[str, Any]:
    """Return bounded structured code actions at one source position."""
    return await host_request("code.code_actions", {"file": file, "line": line, "symbol": symbol or ""})

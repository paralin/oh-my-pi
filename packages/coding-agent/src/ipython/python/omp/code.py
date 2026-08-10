"""Structural code and language-intelligence services."""

from __future__ import annotations

from typing import Any

from rlm import host_request


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

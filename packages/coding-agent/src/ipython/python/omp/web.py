"""Host-owned web search and content extraction services."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request


async def search(
    query: str,
    *,
    provider: str = "auto",
    recency: Literal["day", "week", "month", "year"] | None = None,
    limit: int | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
    num_search_results: int | None = None,
) -> dict[str, Any]:
    """Search through the session's configured provider chain."""
    payload: dict[str, Any] = {"query": query, "provider": provider}
    if recency is not None:
        payload["recency"] = recency
    if limit is not None:
        payload["limit"] = limit
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    if temperature is not None:
        payload["temperature"] = temperature
    if num_search_results is not None:
        payload["num_search_results"] = num_search_results
    return await host_request("web.search", payload)


async def fetch(url: str, *, raw: bool = False) -> dict[str, Any]:
    """Fetch one HTTP or HTTPS URL through OMP's bounded renderer."""
    return await host_request("web.fetch", {"url": url, "raw": raw})


async def scrape(url: str, *, raw: bool = False) -> dict[str, Any]:
    """Extract one HTTP or HTTPS resource with OMP's site-aware scrapers."""
    return await host_request("web.scrape", {"url": url, "raw": raw})


__all__ = ["fetch", "scrape", "search"]

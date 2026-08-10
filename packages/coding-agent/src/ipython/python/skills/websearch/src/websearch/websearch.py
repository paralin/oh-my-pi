"""Search through OMP's typed host-owned web service."""

from __future__ import annotations

from typing import Any, Literal

from omp import web


async def run(
    query: str,
    *,
    max_output: int = 8192,
    timeout: int | None = None,
    num_results: int | None = None,
    provider: str = "auto",
    recency: Literal["day", "week", "month", "year"] | None = None,
) -> str:
    """Run a host-owned web search and return bounded readable text.

    ``timeout`` is retained for Prime-call compatibility; OMP owns transport
    timeouts and therefore does not forward it into Python.
    """
    del timeout
    payload: dict[str, Any] = {"query": query, "provider": provider}
    if recency is not None:
        payload["recency"] = recency
    if num_results is not None:
        payload["num_search_results"] = num_results
    result = await web.search(**payload)
    response = result.get("response")
    if isinstance(response, dict):
        answer = response.get("answer")
        sources = response.get("sources")
        parts: list[str] = []
        if isinstance(answer, str) and answer.strip():
            parts.append(answer.strip())
        if isinstance(sources, list):
            for index, source in enumerate(sources[: max(0, num_results or 5)]):
                if not isinstance(source, dict):
                    continue
                title = str(source.get("title") or "Untitled").strip()
                url = str(source.get("url") or "").strip()
                snippet = str(source.get("snippet") or "").strip()
                lines = [f"Result {index}: {title}"]
                if url:
                    lines.append(f"URL: {url}")
                if snippet:
                    lines.append(snippet)
                parts.append("\n".join(lines))
        text = "\n\n---\n\n".join(parts) if parts else "No results returned"
    elif isinstance(result.get("error"), str):
        text = result["error"]
    else:
        text = str(result)
    output = f'Results for query "{query}":\n\n{text}'
    limit = max(0, max_output)
    if len(output) > limit:
        marker = f"\n... [output truncated, {len(output)} chars total] ...\n"
        half = max(0, (limit - len(marker)) // 2)
        output = output[:half] + marker + output[len(output) - half :]
        if len(output) > limit:
            output = output[:limit]
    return output

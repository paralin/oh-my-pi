"""Session-owned scheduled prompt operations."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def create(
    expression: str,
    prompt: str,
    *,
    recurring: bool = True,
    durable: bool = False,
) -> dict[str, Any]:
    """Create a session or durable scheduled prompt."""
    return await host_request(
        "cron.create",
        {
            "expression": expression,
            "prompt": prompt,
            "recurring": recurring,
            "durable": durable,
        },
    )


async def list() -> dict[str, Any]:
    """Return scheduled prompts ordered by their next fire time."""
    return await host_request("cron.list")


async def update(
    job_id: str,
    *,
    expression: str | None = None,
    prompt: str | None = None,
    recurring: bool | None = None,
) -> dict[str, Any]:
    """Update the mutable fields of one scheduled prompt."""
    payload: dict[str, Any] = {"id": job_id}
    if expression is not None:
        payload["expression"] = expression
    if prompt is not None:
        payload["prompt"] = prompt
    if recurring is not None:
        payload["recurring"] = recurring
    return await host_request("cron.update", payload)


async def delete(job_id: str) -> dict[str, Any]:
    """Delete one scheduled prompt by ID."""
    return await host_request("cron.delete", {"id": job_id})

"""Structured questions displayed by the host-owned interactive UI."""

from __future__ import annotations

from typing import Any

from rlm import host_request


async def questions(questions: list[dict[str, Any]]) -> dict[str, Any]:
    """Ask ordered structured questions and return the user's answers."""
    return await host_request("ask.questions", {"questions": questions})

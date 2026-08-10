"""Typed host-owned Auto-QA grievance reporting."""

from __future__ import annotations

from rlm import host_request


async def report_issue(tool: str, report: str) -> dict[str, object]:
    """Record one bounded tool grievance through the host consent and storage owner."""
    return await host_request("qa.report_issue", {"tool": tool, "report": report})


__all__ = ["report_issue"]

"""Host-owned GitHub repository, issue, pull request, and Actions services."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request


async def repo_view(
    *, repo: str | None = None, branch: str | None = None
) -> dict[str, Any]:
    """Inspect one repository through the configured GitHub CLI session."""
    return await host_request(
        "github.repo_view", {"repo": repo or "", "branch": branch or ""}
    )


async def file_read(
    path: str, *, repo: str | None = None, branch: str | None = None
) -> dict[str, Any]:
    """Read one repository-relative file through GitHub."""
    return await host_request(
        "github.file_read", {"path": path, "repo": repo or "", "branch": branch or ""}
    )


async def issue(
    number_or_url: int | str, *, repo: str | None = None, comments: bool = False
) -> dict[str, Any]:
    """Read one cache-aware issue view."""
    return await host_request(
        "github.issue",
        {"issue": str(number_or_url), "repo": repo or "", "comments": comments},
    )


async def pull_request(
    number: int, *, repo: str | None = None, comments: bool = False
) -> dict[str, Any]:
    """Read one cache-aware pull request view."""
    return await host_request(
        "github.pull_request",
        {"number": number, "repo": repo or "", "comments": comments},
    )


async def pull_request_diff(number: int, *, repo: str | None = None) -> dict[str, Any]:
    """Read and parse one cache-aware pull request diff."""
    return await host_request(
        "github.pull_request_diff", {"number": number, "repo": repo or ""}
    )


async def search(
    kind: Literal["issues", "pull_requests", "code", "commits", "repositories"],
    query: str,
    *,
    repo: str | None = None,
    since: str | None = None,
    until: str | None = None,
    date_field: Literal["created", "updated"] | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Search one GitHub domain with repository, date, and result bounds."""
    payload: dict[str, Any] = {"kind": kind, "query": query, "repo": repo or ""}
    if since is not None:
        payload["since"] = since
    if until is not None:
        payload["until"] = until
    if date_field is not None:
        payload["date_field"] = date_field
    if limit is not None:
        payload["limit"] = limit
    return await host_request("github.search", payload)


async def run(
    run_id_or_url: int | str | None = None,
    *,
    repo: str | None = None,
    branch: str | None = None,
    tail: int | None = None,
) -> dict[str, Any]:
    """Watch a GitHub Actions run or the current commit's runs."""
    payload: dict[str, Any] = {
        "run": "" if run_id_or_url is None else str(run_id_or_url),
        "repo": repo or "",
        "branch": branch or "",
    }
    if tail is not None:
        payload["tail"] = tail
    return await host_request("github.run", payload)


async def create_pull_request(
    *,
    title: str | None = None,
    body: str | None = None,
    repo: str | None = None,
    base: str | None = None,
    head: str | None = None,
    draft: bool = False,
    fill: bool = False,
    reviewers: list[str] | None = None,
    assignees: list[str] | None = None,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Create one pull request through the host's authenticated GitHub CLI."""
    return await host_request(
        "github.create_pull_request",
        {
            "title": title or "",
            "body": body or "",
            "repo": repo or "",
            "base": base or "",
            "head": head or "",
            "draft": draft,
            "fill": fill,
            "reviewers": reviewers or [],
            "assignees": assignees or [],
            "labels": labels or [],
        },
    )


async def checkout_pull_request(
    pull_requests: int | str | list[int | str],
    *,
    repo: str | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Check out one or more pull requests into managed worktrees."""
    values = pull_requests if isinstance(pull_requests, list) else [pull_requests]
    return await host_request(
        "github.checkout_pull_request",
        {
            "pull_requests": [str(value) for value in values],
            "repo": repo or "",
            "force": force,
        },
    )


async def push_pull_request(
    *, branch: str | None = None, force_with_lease: bool = False
) -> dict[str, Any]:
    """Push a local pull request branch to its resolved remote branch."""
    return await host_request(
        "github.push_pull_request",
        {"branch": branch or "", "force_with_lease": force_with_lease},
    )


__all__ = [
    "checkout_pull_request",
    "create_pull_request",
    "file_read",
    "issue",
    "pull_request",
    "pull_request_diff",
    "push_pull_request",
    "repo_view",
    "run",
    "search",
]

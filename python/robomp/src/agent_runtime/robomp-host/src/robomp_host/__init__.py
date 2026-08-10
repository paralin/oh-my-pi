"""Typed Robomp operations backed by task-local host authority."""

from __future__ import annotations

from typing import Literal, TypeAlias, cast

from rlm import host_request

__all__ = [
    "abort_task",
    "classify_issue",
    "classify_pr",
    "fetch_issue_thread",
    "fetch_pr",
    "gh_open_pr",
    "gh_post_comment",
    "gh_push_branch",
    "gh_request_review",
    "gh_search_issues",
    "mark_unable_to_reproduce",
    "pr_review_comment",
    "repro_record",
    "search_commits",
    "set_issue_labels",
    "submit_pr_review",
]

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
Operation: TypeAlias = Literal[
    "abort_task",
    "classify_issue",
    "classify_pr",
    "fetch_issue_thread",
    "fetch_pr",
    "gh_open_pr",
    "gh_post_comment",
    "gh_push_branch",
    "gh_request_review",
    "gh_search_issues",
    "mark_unable_to_reproduce",
    "pr_review_comment",
    "repro_record",
    "search_commits",
    "set_issue_labels",
    "submit_pr_review",
]


async def _call(operation: Operation, arguments: dict[str, JsonValue]) -> JsonValue:
    response = await host_request(f"extension.robomp.{operation}", arguments)
    if set(response) != {"result"}:
        raise RuntimeError(f"Robomp host returned an invalid {operation} response")
    return cast(JsonValue, response["result"])


def _defined(**values: JsonValue) -> dict[str, JsonValue]:
    return {key: value for key, value in values.items() if value is not None}


async def abort_task(*, reason: str) -> JsonValue:
    """Abort the active Robomp task with a durable reason."""
    return await _call("abort_task", {"reason": reason})


async def classify_issue(
    *,
    primary: str,
    rationale: str,
    priority: str | None = None,
    functional: list[str] | None = None,
    provider: str | None = None,
    platform: str | None = None,
    branch_slug: str | None = None,
) -> JsonValue:
    """Classify the issue and apply its authorized labels and branch name."""
    return await _call(
        "classify_issue",
        _defined(
            primary=primary,
            rationale=rationale,
            priority=priority,
            functional=functional,
            provider=provider,
            platform=platform,
            branch_slug=branch_slug,
        ),
    )


async def classify_pr(
    *,
    rank: str,
    type: str,
    rationale: str,
    area: str | None = None,
    provider: str | None = None,
) -> JsonValue:
    """Classify the active pull request under Robomp's review policy."""
    return await _call(
        "classify_pr",
        _defined(rank=rank, type=type, rationale=rationale, area=area, provider=provider),
    )


async def fetch_issue_thread() -> JsonValue:
    """Fetch the active issue or pull-request conversation."""
    return await _call("fetch_issue_thread", {})


async def fetch_pr() -> JsonValue:
    """Fetch the active pull request and its changed files."""
    return await _call("fetch_pr", {})


async def gh_open_pr(
    *,
    title: str,
    body: str,
    base: str | None = None,
    draft: bool | None = None,
    skip_checks: bool | None = None,
) -> JsonValue:
    """Open the task branch as a pull request after Robomp's publication gates."""
    return await _call(
        "gh_open_pr",
        _defined(title=title, body=body, base=base, draft=draft, skip_checks=skip_checks),
    )


async def gh_post_comment(*, body: str, number: int | None = None) -> JsonValue:
    """Post a comment to the authorized issue or pull-request thread."""
    return await _call("gh_post_comment", _defined(body=body, number=number))


async def gh_push_branch(*, branch: str | None = None, skip_checks: bool | None = None) -> JsonValue:
    """Push the task branch through Robomp's checks and safe Git transport."""
    return await _call("gh_push_branch", _defined(branch=branch, skip_checks=skip_checks))


async def gh_request_review(*, reviewers: list[str] | None = None, assignees: list[str] | None = None) -> JsonValue:
    """Request reviewers or assignees allowed by the active task."""
    return await _call("gh_request_review", _defined(reviewers=reviewers, assignees=assignees))


async def gh_search_issues(*, query: str, limit: int | None = None) -> JsonValue:
    """Search repository issues through Robomp's bounded GitHub client."""
    return await _call("gh_search_issues", _defined(query=query, limit=limit))


async def mark_unable_to_reproduce(*, diagnosis: str, info_needed: str) -> JsonValue:
    """Record that reproduction failed and ask for the missing information."""
    return await _call(
        "mark_unable_to_reproduce",
        {"diagnosis": diagnosis, "info_needed": info_needed},
    )


async def pr_review_comment(
    *,
    path: str,
    line: int,
    body: str,
    side: str | None = None,
    start_line: int | None = None,
    start_side: str | None = None,
) -> JsonValue:
    """Queue one inline pull-request review comment."""
    return await _call(
        "pr_review_comment",
        _defined(path=path, line=line, body=body, side=side, start_line=start_line, start_side=start_side),
    )


async def repro_record(
    *,
    title: str,
    command: str,
    output: str,
    exit_code: int,
    reproduced: bool | None = None,
) -> JsonValue:
    """Record one bounded reproduction attempt in the task audit trail."""
    return await _call(
        "repro_record",
        _defined(
            title=title,
            command=command,
            output=output,
            exit_code=exit_code,
            reproduced=reproduced,
        ),
    )


async def search_commits(
    *,
    query: str,
    mode: str | None = None,
    paths: list[str] | None = None,
    limit: int | None = None,
) -> JsonValue:
    """Search task-repository commit history under Robomp's bounds."""
    return await _call(
        "search_commits",
        _defined(query=query, mode=mode, paths=paths, limit=limit),
    )


async def set_issue_labels(*, labels: list[str], number: int | None = None) -> JsonValue:
    """Apply the authorized label set to an issue."""
    return await _call("set_issue_labels", _defined(labels=labels, number=number))


async def submit_pr_review(*, body: str, event: str | None = None) -> JsonValue:
    """Submit the accumulated pull-request review through Robomp's policy gates."""
    return await _call("submit_pr_review", _defined(body=body, event=event))

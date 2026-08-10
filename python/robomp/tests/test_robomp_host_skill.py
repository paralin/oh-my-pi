from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SKILL_INIT = Path(__file__).parents[1] / "src/agent_runtime/robomp-host/src/robomp_host/__init__.py"
OPERATIONS = {
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
}


def _load_skill(monkeypatch: pytest.MonkeyPatch, host_request: Any) -> ModuleType:
    rlm = ModuleType("rlm")
    rlm.host_request = host_request  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "rlm", rlm)
    spec = importlib.util.spec_from_file_location("robomp_host_test", SKILL_INIT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_skill_exposes_exact_operation_set_and_omits_undefined_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[tuple[str, dict[str, object]]] = []

    async def host_request(operation: str, arguments: dict[str, object]) -> dict[str, object]:
        requests.append((operation, arguments))
        return {"result": {"accepted": True}}

    skill = _load_skill(monkeypatch, host_request)
    assert set(skill.__all__) == OPERATIONS

    result = await skill.classify_issue(primary="bug", rationale="reproduced", priority=None)
    assert result == {"accepted": True}
    assert requests == [
        (
            "extension.robomp.classify_issue",
            {"primary": "bug", "rationale": "reproduced"},
        )
    ]


async def test_skill_rejects_invalid_host_response(monkeypatch: pytest.MonkeyPatch) -> None:
    async def host_request(_operation: str, _arguments: dict[str, object]) -> dict[str, object]:
        return {"unexpected": True}

    skill = _load_skill(monkeypatch, host_request)
    with pytest.raises(RuntimeError, match="invalid fetch_pr response"):
        await skill.fetch_pr()

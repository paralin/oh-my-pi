"""Phase 5 item 6: executed Python tests over the OMP kernel-side rlm control slice.

These import the actual ``rlm`` module from the coding-agent kernel runtime and
drive its functions directly (no source-parsing claims). The goal pause/resume
facility belongs to the goal skill, not the rlm module, so ``rlm.__all__`` must
not export them while the goal skill must.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[3]
_RUNTIME_PY = _REPO / "packages/coding-agent/src/ipython/python"
_GOAL_SRC = _RUNTIME_PY / "skills/goal/src"

# Make the kernel-side packages importable.
import sys

sys.path.insert(0, str(_RUNTIME_PY))
sys.path.insert(0, str(_GOAL_SRC))

import rlm  # noqa: E402
import goal  # noqa: E402


def test_rlm_all_excludes_goal_pause_resume():
    assert "run" in rlm.__all__
    assert "find_models" in rlm.__all__
    assert "pause" not in rlm.__all__
    assert "resume" not in rlm.__all__
    # The goal skill owns pause/resume; the rlm module must not expose them.
    assert not hasattr(rlm, "pause")
    assert not hasattr(rlm, "resume")


def test_goal_skill_exposes_pause_and_resume():
    assert callable(goal.pause)
    assert callable(goal.resume)


def test_validate_service_tier_accepts_all_tiers_and_none():
    for tier in ("auto", "default", "flex", "scale", "priority", None):
        rlm._validate_service_tier(tier)


def test_validate_service_tier_rejects_unknown():
    with pytest.raises(ValueError, match="service_tier must be one of"):
        rlm._validate_service_tier("bogus")


def test_run_validates_service_tier_before_host_request():
    calls: list[dict[str, object]] = []

    async def fake_host_request(request_type: str, payload: dict[str, object] | None = None):
        calls.append({"type": request_type, "payload": payload})
        return {
            "rlm_child_id": "child-1",
            "name": "worker",
            "session_dir": "/sessions/child",
            "model": "provider/model",
        }

    rlm.host_request = fake_host_request  # type: ignore[assignment]
    try:
        handle = asyncio.run(rlm.run("work", service_tier="flex"))
        assert handle.rlm_child_id == "child-1"
        sent = calls[-1]["payload"]
        assert sent is not None and sent["kwargs"]["service_tier"] == "flex"

        with pytest.raises(ValueError, match="service_tier"):
            asyncio.run(rlm.run("work", service_tier="bogus"))
        # A bogus tier must not even reach the host.
        assert len(calls) == 1
    finally:
        # Undo the monkeypatch so other tests importing rlm stay correct.
        import importlib

        importlib.reload(rlm)


def test_model_parses_camel_case_concrete_selector_and_available():
    model = rlm._model(
        {
            "provider": "acme",
            "id": "alpha",
            "name": "Alpha",
            "selector": "acme/alpha",
            "concreteSelector": "acme/alpha:high",
            "available": True,
        }
    )
    assert model.provider == "acme"
    assert model.id == "alpha"
    assert model.selector == "acme/alpha"
    assert model.concrete_selector == "acme/alpha:high"
    assert model.available is True


def test_model_optional_fields_default_to_none():
    model = rlm._model({"provider": "p", "id": "m", "name": "M", "selector": "p/m"})
    assert model.concrete_selector is None
    assert model.available is None


def test_model_rejects_invalid_available_and_concrete_selector():
    with pytest.raises(RuntimeError, match="invalid model entry"):
        rlm._model(
            {"provider": "p", "id": "m", "name": "M", "selector": "p/m", "available": "yes"}
        )
    with pytest.raises(RuntimeError, match="invalid model entry"):
        rlm._model(
            {
                "provider": "p",
                "id": "m",
                "name": "M",
                "selector": "p/m",
                "concreteSelector": "",
            }
        )

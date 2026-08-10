"""Typed host-owned autoresearch operations."""
from __future__ import annotations
from typing import Literal
from rlm import host_request
async def init(name: str, primary_metric: str, *, goal: str | None = None, metric_unit: str | None = None, direction: Literal["lower", "higher"] | None = None, secondary_metrics: list[str] | None = None, scope_paths: list[str] | None = None, off_limits: list[str] | None = None, constraints: list[str] | None = None, max_iterations: int | None = None, new_segment: bool | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"name": name, "primary_metric": primary_metric}
    for key, value in {"goal": goal, "metric_unit": metric_unit, "direction": direction, "secondary_metrics": secondary_metrics, "scope_paths": scope_paths, "off_limits": off_limits, "constraints": constraints, "max_iterations": max_iterations, "new_segment": new_segment}.items():
        if value is not None: payload[key] = value
    return await host_request("extension.autoresearch.init", payload)
async def run(*, timeout_seconds: float | None = None) -> dict[str, object]:
    return await host_request("extension.autoresearch.run", {} if timeout_seconds is None else {"timeout_seconds": timeout_seconds})
async def log(metric: float, status: Literal["keep", "discard", "crash", "checks_failed"], description: str, *, metrics: dict[str, float] | None = None, asi: dict[str, object] | None = None, commit: str | None = None, justification: str | None = None, flag_runs: list[dict[str, object]] | None = None) -> dict[str, object]:
    payload: dict[str, object] = {"metric": metric, "status": status, "description": description}
    for key, value in {"metrics": metrics, "asi": asi, "commit": commit, "justification": justification, "flag_runs": flag_runs}.items():
        if value is not None: payload[key] = value
    return await host_request("extension.autoresearch.log", payload)
async def notes(body: str | None = None, *, append_idea: str | None = None) -> dict[str, object]:
    payload: dict[str, object] = {}
    if body is not None: payload["body"] = body
    if append_idea is not None: payload["append_idea"] = append_idea
    return await host_request("extension.autoresearch.notes", payload)
__all__ = ["init", "run", "log", "notes"]

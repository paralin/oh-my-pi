"""Typed OMP domains for services that must remain host-owned."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from rlm import host_request


@dataclass(frozen=True)
class Capability:
    name: str
    module: str
    summary: str
    skill_path: Path | None = None


_ROOT = Path(__file__).resolve().parent.parent
_CAPABILITIES = (
    Capability("rlm", "rlm", "Admit and inspect OMP Task children."),
    Capability("agent_message", "agent_message", "Message reachable family agents.", _ROOT / "skills/agent-message/SKILL.md"),
    Capability("agent_observe", "agent_observe", "Observe reachable family agents.", _ROOT / "skills/agent-observe/SKILL.md"),
    Capability("attach_image", "attach_image", "Attach a local image to model context.", _ROOT / "skills/attach-image/SKILL.md"),
    Capability("compact", "compact", "Inspect or schedule OMP compaction.", _ROOT / "skills/compact/SKILL.md"),
    Capability("edit", "edit", "Apply one exact string replacement.", _ROOT / "skills/edit/SKILL.md"),
    Capability("goal", "goal", "Manage the persistent thread goal.", _ROOT / "skills/goal/SKILL.md"),
    Capability("refine", "refine", "Schedule continual-harness refinement.", _ROOT / "skills/refine/SKILL.md"),
    Capability("rlm_heartbeat", "rlm_heartbeat", "Manage agent-owned heartbeats.", _ROOT / "skills/rlm-heartbeat/SKILL.md"),
    Capability("omp.session", "omp.session", "Inspect active-cell context and publish progress or artifacts."),
    Capability("omp.files", "omp.files", "Read, write, and glob bounded workspace files through OMP owners."),
    Capability("omp.code", "omp.code", "Search and rewrite syntax trees and query language intelligence."),
    Capability("omp.debug", "omp.debug", "Control one session-private Debug Adapter Protocol lifecycle."),
    Capability("omp.workspace", "omp.workspace", "Use validated OMP workspace search and edit services."),
    Capability("omp.harness", "omp.harness", "Access continual harness, todo, and checkpoint services."),
    Capability("omp.memory", "omp.memory", "Manage host-owned OMP memory records."),
    Capability("omp.rules", "omp.rules", "Manage host-owned OMP rule records."),
    Capability("omp.skills", "omp.skills", "Manage host-owned OMP skill records."),
    Capability("omp.mcp", "omp.mcp", "Call host-owned MCP tools, resources, prompts, config, and refresh."),
)


def capabilities() -> tuple[Capability, ...]:
    """Return OMP's bounded Python capability index."""
    return _CAPABILITIES


def skill_path(name: str) -> Path:
    """Return one focused skill's adjacent SKILL.md path."""
    for capability in _CAPABILITIES:
        if capability.name == name and capability.skill_path is not None:
            return capability.skill_path
    raise KeyError(name)


from . import code, debug, files, harness, mcp, memory, rules, session, skills, workspace

__all__ = [
    "Capability",
    "capabilities",
    "code",
    "debug",
    "files",
    "harness",
    "host_request",
    "mcp",
    "memory",
    "rules",
    "session",
    "skill_path",
    "skills",
    "workspace",
]

"""Typed OMP domains for services that must remain host-owned."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from rlm import host_request

from . import (
    ask,
    ast,
    autoresearch,
    browser,
    code,
    computer,
    cron,
    debug,
    github,
    harness,
    images,
    long_term_memory,
    lsp,
    mcp,
    memory,
    process,
    qa,
    remote,
    rules,
    security,
    session,
    skills,
    tts,
    web,
    vibe,
)


@dataclass(frozen=True)
class Capability:
    name: str
    module: str
    summary: str
    skill_path: Path | None = None


_ROOT = Path(__file__).resolve().parent.parent
_CAPABILITIES = (
    Capability("rlm", "rlm", "Admit and inspect OMP Task children."),
    Capability(
        "agent_message",
        "agent_message",
        "Message reachable family agents.",
        _ROOT / "skills/agent-message/SKILL.md",
    ),
    Capability(
        "agent_observe",
        "agent_observe",
        "Observe reachable family agents.",
        _ROOT / "skills/agent-observe/SKILL.md",
    ),
    Capability(
        "attach_image",
        "attach_image",
        "Attach a local image to model context.",
        _ROOT / "skills/attach-image/SKILL.md",
    ),
    Capability(
        "compact",
        "compact",
        "Inspect or schedule OMP compaction.",
        _ROOT / "skills/compact/SKILL.md",
    ),
    Capability(
        "edit",
        "edit",
        "Apply one exact string replacement.",
        _ROOT / "skills/edit/SKILL.md",
    ),
    Capability(
        "goal",
        "goal",
        "Manage the persistent thread goal.",
        _ROOT / "skills/goal/SKILL.md",
    ),
    Capability(
        "refine",
        "refine",
        "Schedule continual-harness refinement.",
        _ROOT / "skills/refine/SKILL.md",
    ),
    Capability(
        "rlm_heartbeat",
        "rlm_heartbeat",
        "Manage agent-owned heartbeats.",
        _ROOT / "skills/rlm-heartbeat/SKILL.md",
    ),
    Capability(
        "websearch",
        "websearch",
        "Search the web through OMP's host-owned web service.",
        _ROOT / "skills/websearch/SKILL.md",
    ),
    Capability(
        "linear",
        "linear",
        "Access Linear through OMP's host-owned MCP transport.",
        _ROOT / "skills/linear/SKILL.md",
    ),
    Capability(
        "notion",
        "notion",
        "Access Notion through OMP's host-owned MCP transport.",
        _ROOT / "skills/notion/SKILL.md",
    ),
    Capability(
        "omp.session",
        "omp.session",
        "Inspect active-cell context and publish progress or artifacts.",
    ),
    Capability(
        "omp.ast",
        "omp.ast",
        "Search and rewrite workspace syntax trees through the bundled native engine.",
    ),
    Capability(
        "omp.code",
        "omp.code",
        "Query host-owned language intelligence.",
    ),
    Capability(
        "omp.lsp",
        "omp.lsp",
        "Query host-owned language-server intelligence.",
    ),
    Capability(
        "omp.debug",
        "omp.debug",
        "Control one session-private Debug Adapter Protocol lifecycle.",
    ),
    Capability(
        "omp.web",
        "omp.web",
        "Search and extract web resources through host-owned providers.",
    ),
    Capability(
        "omp.github",
        "omp.github",
        "Use GitHub through host-owned command and cache services.",
    ),
    Capability(
        "omp.remote",
        "omp.remote",
        "Use host-owned SSH connections and file-transfer services.",
    ),
    Capability(
        "omp.harness",
        "omp.harness",
        "Access continual harness, todo, and checkpoint services.",
    ),
    Capability("omp.memory", "omp.memory", "Manage continual-harness memory records, not backend long-term memory."),
    Capability(
        "omp.long_term_memory",
        "omp.long_term_memory",
        "Retain, recall, reflect, edit, and learn through the configured long-term memory backend.",
    ),
    Capability("omp.qa", "omp.qa", "Report bounded tool grievances through host-owned Auto-QA."),
    Capability("omp.autoresearch", "omp.autoresearch", "Run bounded host-owned autoresearch operations."),
    Capability("omp.vibe", "omp.vibe", "Drive addressable task-backed Vibe workers."),
    Capability("omp.rules", "omp.rules", "Manage host-owned OMP rule records."),
    Capability("omp.skills", "omp.skills", "Manage host-owned OMP skill records."),
    Capability(
        "omp.mcp",
        "omp.mcp",
        "Call host-owned MCP tools, resources, prompts, reconnect, and notifications.",
    ),
    Capability(
        "omp.cron",
        "omp.cron",
        "Create, inspect, update, and delete scheduled session prompts.",
    ),
    Capability(
        "omp.process",
        "omp.process",
        "Supervise retained project-scoped long-lived processes.",
    ),
    Capability(
        "omp.tts",
        "omp.tts",
        "Synthesize bounded local or xAI speech files without exposing credentials.",
    ),
    Capability(
        "omp.ask",
        "omp.ask",
        "Ask ordered structured questions through the interactive session UI.",
    ),
    Capability(
        "omp.browser",
        "omp.browser",
        "Drive session-owned browser tabs through opaque handles.",
    ),
    Capability(
        "omp.computer", "omp.computer", "Drive the session-owned desktop supervisor."
    ),
    Capability(
        "omp.images",
        "omp.images",
        "Generate images through host-owned providers and inspect attachment metadata.",
    ),
    Capability(
        "omp.security",
        "omp.security",
        "Run native security scans and inspect public findings and provenance.",
    ),
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


__all__ = [
    "Capability",
    "ask",
    "ast",
    "autoresearch",
    "browser",
    "capabilities",
    "code",
    "computer",
    "cron",
    "debug",
    "github",
    "harness",
    "host_request",
    "images",
    "long_term_memory",
    "lsp",
    "mcp",
    "memory",
    "process",
    "qa",
    "remote",
    "rules",
    "security",
    "session",
    "skill_path",
    "skills",
    "tts",
    "web",
    "vibe",
]

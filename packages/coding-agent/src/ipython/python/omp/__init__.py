"""Typed OMP domains for services that must remain host-owned."""

from __future__ import annotations

import importlib
import inspect
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from types import CodeType, ModuleType

from rlm import host_request

try:
    from rlm import host_request_sync
except ImportError:
    host_request_sync = None

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
    """One capability declared by the active Python runtime."""

    name: str
    module: str
    summary: str
    example: str
    skill_path: Path | None = field(default=None, repr=False)
    available: bool | None = field(default=None, compare=False)

    @property
    def category(self) -> str:
        """Return this capability's stable discovery category."""
        if self.name == "rlm":
            return "agent"
        if self.name.startswith("omp."):
            return "host"
        return "skill"


@dataclass(frozen=True)
class CapabilityCall:
    """One bounded public callable exposed by a capability module."""

    name: str
    signature: str
    documentation: str
    is_async: bool


@dataclass(frozen=True)
class CapabilityDetail:
    """Bounded discovery detail for one indexed OMP capability."""

    name: str
    module: str
    category: str
    summary: str
    example: str
    available: bool | None
    skill_path: Path | None
    calls: tuple[CapabilityCall, ...]
    omitted_calls: int


_ROOT = Path(__file__).resolve().parent.parent
_RUNTIME_REGISTRY = (
    Capability('rlm', 'rlm', 'Admit and inspect OMP Task children.', 'await rlm.list_subagents()'),
    Capability('helpers', 'helpers', 'Read bounded ranges, search text, and run finite supervised commands.', "show('src/app.py', 1, 80)", _ROOT / "skills/helpers/SKILL.md"),
    Capability('agent_message', 'agent_message', 'Message reachable family agents.', 'await agent_message.list_agents()', _ROOT / "skills/agent-message/SKILL.md"),
    Capability('agent_observe', 'agent_observe', 'Observe reachable family agents.', 'await agent_observe.list_agents()', _ROOT / "skills/agent-observe/SKILL.md"),
    Capability('attach_image', 'attach_image', 'Attach a local image to model context.', "await attach_image(path='image.png')", _ROOT / "skills/attach-image/SKILL.md"),
    Capability('compact', 'compact', 'Inspect or schedule OMP compaction.', 'await compact.status()', _ROOT / "skills/compact/SKILL.md"),
    Capability('edit', 'edit', 'Apply one exact string replacement.', "await edit(path='file.py', old_str='old', new_str='new')", _ROOT / "skills/edit/SKILL.md"),
    Capability('goal', 'goal', 'Manage the persistent thread goal.', 'await goal.get()', _ROOT / "skills/goal/SKILL.md"),
    Capability('refine', 'refine', 'Schedule continual-harness refinement.', 'await refine.status()', _ROOT / "skills/refine/SKILL.md"),
    Capability('rlm_heartbeat', 'rlm_heartbeat', 'Manage agent-owned heartbeats.', 'await rlm_heartbeat.list()', _ROOT / "skills/rlm-heartbeat/SKILL.md"),
    Capability('websearch', 'websearch', "Search the web through OMP's host-owned web service.", "await websearch('OMP')", _ROOT / "skills/websearch/SKILL.md"),
    Capability('linear', 'linear', "Access Linear through OMP's host-owned MCP transport.", 'await linear.list_tools()', _ROOT / "skills/linear/SKILL.md"),
    Capability('notion', 'notion', "Access Notion through OMP's host-owned MCP transport.", 'await notion.list_tools()', _ROOT / "skills/notion/SKILL.md"),
    Capability('omp.session', 'omp.session', 'Inspect active-cell context and publish progress or artifacts.', 'await omp.session.info()'),
    Capability('omp.ast', 'omp.ast', 'Search and rewrite workspace syntax trees through the bundled native engine.', "await omp.ast.search(path='src', patterns=['log($A)'])"),
    Capability('omp.code', 'omp.code', 'Query host-owned language intelligence.', "await omp.code.diagnostics(path='src/app.ts')"),
    Capability('omp.lsp', 'omp.lsp', 'Query host-owned language-server intelligence.', 'await omp.lsp.status()'),
    Capability('omp.debug', 'omp.debug', 'Control one session-private Debug Adapter Protocol lifecycle.', 'await omp.debug.adapters()'),
    Capability('omp.web', 'omp.web', 'Search and extract web resources through host-owned providers.', "await omp.web.search('OMP')"),
    Capability('omp.github', 'omp.github', 'Use GitHub through host-owned command and cache services.', 'await omp.github.repo_view()'),
    Capability('omp.remote', 'omp.remote', 'Use host-owned SSH connections and file-transfer services.', 'await omp.remote.hosts()'),
    Capability('omp.harness', 'omp.harness', 'Access continual harness, todo, and checkpoint services.', 'await omp.harness.checkpoint_status()'),
    Capability('omp.memory', 'omp.memory', 'Manage continual-harness memory records, not backend long-term memory.', 'await omp.memory.list()'),
    Capability('omp.long_term_memory', 'omp.long_term_memory', 'Retain, recall, reflect, edit, and learn through the configured long-term memory backend.', "await omp.long_term_memory.recall('topic')"),
    Capability('omp.qa', 'omp.qa', 'Report bounded tool grievances through host-owned Auto-QA.', "await omp.qa.report_issue('tool', 'summary')"),
    Capability('omp.autoresearch', 'omp.autoresearch', 'Run bounded host-owned autoresearch operations.', 'await omp.autoresearch.notes()'),
    Capability('omp.vibe', 'omp.vibe', 'Drive addressable task-backed Vibe workers.', 'await omp.vibe.list()'),
    Capability('omp.rules', 'omp.rules', 'Manage host-owned OMP rule records.', 'await omp.rules.list()'),
    Capability('omp.skills', 'omp.skills', 'Manage host-owned OMP skill records.', 'await omp.skills.list()'),
    Capability('omp.mcp', 'omp.mcp', 'Call host-owned MCP tools, resources, prompts, reconnect, and notifications.', 'await omp.mcp.list_servers()'),
    Capability('omp.cron', 'omp.cron', 'Create, inspect, update, and delete scheduled session prompts.', 'await omp.cron.list()'),
    Capability('omp.process', 'omp.process', 'Run supervised argv commands and retain project-scoped long-lived processes.', "await omp.process.run('git', ['status', '--short'])"),
    Capability('omp.tts', 'omp.tts', 'Synthesize bounded local or xAI speech files without exposing credentials.', "await omp.tts.synthesize('Hello')"),
    Capability('omp.ask', 'omp.ask', 'Ask ordered structured questions through the interactive session UI.', 'await omp.ask.questions([])'),
    Capability('omp.browser', 'omp.browser', 'Drive session-owned browser tabs through opaque handles.', 'await omp.browser.tabs()'),
    Capability('omp.computer', 'omp.computer', 'Drive the session-owned desktop supervisor.', 'await omp.computer.capabilities()'),
    Capability('omp.images', 'omp.images', 'Generate images through host-owned providers and inspect attachment metadata.', 'await omp.images.attachments()'),
    Capability('omp.security', 'omp.security', 'Run native security scans and inspect public findings and provenance.', 'await omp.security.scans()'),
)


_MAX_CAPABILITY_CALLS = 16
_MAX_CAPABILITY_DOCUMENTATION_CHARS = 160
_MAX_CAPABILITY_SIGNATURE_CHARS = 384
_MAX_DISCOVERY_BYTES = 8 * 1024


def _bounded_text(value: str, maximum: int) -> str:
    if len(value) <= maximum:
        return value
    return f"{value[: maximum - 1]}…"


def _call_detail(name: str, value: object) -> CapabilityCall | None:
    try:
        signature = str(inspect.signature(value))
    except (TypeError, ValueError):
        return None
    documentation = inspect.getdoc(value)
    first_line = documentation.splitlines()[0] if documentation else ""
    return CapabilityCall(
        name=name,
        signature=_bounded_text(signature, _MAX_CAPABILITY_SIGNATURE_CHARS),
        documentation=_bounded_text(first_line, _MAX_CAPABILITY_DOCUMENTATION_CHARS),
        is_async=inspect.iscoroutinefunction(value)
        or inspect.iscoroutinefunction(getattr(value, "__call__", None)),
    )


def _public_calls(capability: Capability, module: ModuleType) -> tuple[CapabilityCall, ...]:
    calls: list[CapabilityCall] = []
    if callable(module):
        detail = _call_detail(capability.name, module)
        if detail is not None:
            calls.append(detail)
    exported = getattr(module, "__all__", None)
    names = exported if isinstance(exported, (list, tuple)) else tuple(vars(module))
    for name in names:
        if not isinstance(name, str) or name.startswith("_"):
            continue
        try:
            value = getattr(module, name)
        except AttributeError:
            continue
        if not inspect.isroutine(value):
            continue
        detail = _call_detail(name, value)
        if detail is not None:
            calls.append(detail)
    return tuple(calls)


def _host_operations(module: ModuleType) -> set[str]:
    operations: set[str] = set()
    visited: set[int] = set()

    def visit(code: CodeType) -> None:
        identity = id(code)
        if identity in visited:
            return
        visited.add(identity)
        for value in code.co_consts:
            if isinstance(value, CodeType):
                visit(value)
            elif isinstance(value, str) and "." in value and len(value) <= 128:
                operations.add(value)

    for value in vars(module).values():
        code = getattr(value, "__code__", None)
        if isinstance(code, CodeType):
            visit(code)
    return operations


def _parsed_census(value: object) -> frozenset[str] | None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return None
    return frozenset(value)


def _host_census() -> frozenset[str] | None:
    if host_request_sync is not None:
        try:
            response = host_request_sync("capability.census")
        except RuntimeError:
            pass
        else:
            census = _parsed_census(response.get("operations"))
            if census is not None:
                return census
    encoded = os.environ.get("OMP_HOST_CAPABILITY_CENSUS")
    if encoded is None:
        return None
    try:
        value = json.loads(encoded)
    except json.JSONDecodeError:
        return frozenset()
    return _parsed_census(value) or frozenset()


def _availability(
    capability: Capability, module: ModuleType, census: frozenset[str] | None
) -> bool | None:
    if census is None:
        return None
    operations = _host_operations(module)
    if operations:
        matches = operations & census
        if matches:
            return True
    prefix = capability.name.removeprefix("omp.").replace("long_term_memory", "long_term_memory")
    return any(operation.startswith(f"{prefix}.") for operation in census)


def _live_capability(
    capability: Capability, census: frozenset[str] | None
) -> Capability:
    if census is None:
        available = None
    else:
        try:
            module = importlib.import_module(capability.module)
        except ImportError:
            prefix = capability.name.removeprefix("omp.")
            available = any(operation.startswith(f"{prefix}.") for operation in census)
        else:
            available = _availability(capability, module, census)
    return Capability(
        name=capability.name,
        module=capability.module,
        summary=capability.summary,
        example=capability.example,
        skill_path=capability.skill_path,
        available=available,
    )


def search(query: str = "", *, category: str | None = None) -> tuple[Capability, ...]:
    """Search live capability metadata by casefolded text and optional category."""
    if not isinstance(query, str):
        raise TypeError("query must be str")
    if category is not None and not isinstance(category, str):
        raise TypeError("category must be str or None")
    needle = query.casefold().strip()
    wanted_category = category.casefold().strip() if category is not None else None
    if wanted_category and wanted_category not in {"agent", "host", "skill"}:
        raise ValueError("category must be 'agent', 'host', or 'skill'; use query=... to search capability names")
    results: list[Capability] = []
    census = _host_census()
    for declared in _RUNTIME_REGISTRY:
        capability = _live_capability(declared, census)
        if wanted_category and capability.category.casefold() != wanted_category:
            continue
        searchable = "\n".join(
            (
                capability.name,
                capability.module,
                capability.category,
                capability.summary,
                capability.example,
                str(capability.skill_path or ""),
            )
        ).casefold()
        if needle and needle not in searchable:
            continue
        candidate = (*results, capability)
        if len(repr(candidate).encode("utf-8")) > _MAX_DISCOVERY_BYTES:
            break
        results.append(capability)
    return tuple(results)


def capabilities(query: str | None = None, *, category: str | None = None) -> tuple[Capability, ...]:
    """Return live capabilities; the no-argument form retains tuple compatibility."""
    if query is not None and not isinstance(query, str):
        raise TypeError("query must be str or None")
    return search(query or "", category=category)


def describe(name: str) -> CapabilityDetail | None:
    """Return bounded live call detail for one exact registered capability name."""
    if not isinstance(name, str):
        raise TypeError("name must be str")
    declared = next((item for item in _RUNTIME_REGISTRY if item.name == name), None)
    if declared is None:
        return None
    capability = _live_capability(declared, _host_census())
    calls = _public_calls(capability, importlib.import_module(capability.module))
    included: list[CapabilityCall] = []
    for call in calls[:_MAX_CAPABILITY_CALLS]:
        candidate = CapabilityDetail(
            name=capability.name,
            module=capability.module,
            category=capability.category,
            summary=capability.summary,
            example=capability.example,
            available=capability.available,
            skill_path=capability.skill_path,
            calls=(*included, call),
            omitted_calls=max(0, len(calls) - len(included) - 1),
        )
        if len(repr(candidate).encode("utf-8")) > _MAX_DISCOVERY_BYTES:
            break
        included.append(call)
    return CapabilityDetail(
        name=capability.name,
        module=capability.module,
        category=capability.category,
        summary=capability.summary,
        example=capability.example,
        available=capability.available,
        skill_path=capability.skill_path,
        calls=tuple(included),
        omitted_calls=max(0, len(calls) - len(included)),
    )


def skill_path(name: str) -> Path:
    """Return one focused skill's adjacent SKILL.md path."""
    for capability in _RUNTIME_REGISTRY:
        if capability.name == name and capability.skill_path is not None:
            return capability.skill_path
    raise KeyError(name)


__all__ = [
    "Capability",
    "CapabilityCall",
    "CapabilityDetail",
    "ask",
    "ast",
    "autoresearch",
    "browser",
    "capabilities",
    "code",
    "computer",
    "cron",
    "debug",
    "describe",
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
    "search",
    "security",
    "session",
    "skill_path",
    "skills",
    "tts",
    "web",
    "vibe",
]

"""Prime-compatible harness records backed by OMP's host-owned stores."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

HarnessKind = Literal["prompt", "memory", "skill", "subagent"]
HarnessScope = Literal["local", "global"]
_KINDS = ("prompt", "memory", "skill", "subagent")


@dataclass
class HarnessEntry:
    """A reusable prompt, memory, skill, or subagent record."""

    id: str
    kind: HarnessKind
    title: str
    content: str
    path: str = "general"
    scope: HarnessScope = "local"
    reference: dict[str, Any] = field(default_factory=dict)
    arguments: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    source: str = "agent"
    created_at: str = ""
    updated_at: str = ""
    version: int = 1


@dataclass
class RefinementEvent:
    """A recorded online harness-refinement pass."""

    id: str
    trigger: str
    changes: list[str]
    evidence: str = ""
    outcome: str = ""
    created_at: str = ""


def _entry(payload: Any) -> HarnessEntry:
    if not isinstance(payload, dict):
        raise RuntimeError("OMP returned an invalid harness entry")
    return HarnessEntry(**{name: payload[name] for name in HarnessEntry.__dataclass_fields__ if name in payload})


def _event(payload: Any) -> RefinementEvent:
    if not isinstance(payload, dict):
        raise RuntimeError("OMP returned an invalid refinement event")
    return RefinementEvent(**{name: payload[name] for name in RefinementEvent.__dataclass_fields__ if name in payload})


def _global(global_: bool, kwargs: dict[str, Any]) -> bool:
    if "global" in kwargs:
        value = kwargs.pop("global")
        if not isinstance(value, bool):
            raise TypeError(f"global must be bool, got {type(value).__name__}")
        global_ = value
    if kwargs:
        raise TypeError(f"unexpected keyword argument {next(iter(kwargs))!r}")
    return global_


class HarnessState:
    """Prime-compatible synchronous CRUD view over OMP harness services."""

    def __init__(self, *, scope: HarnessScope = "local"):
        self.scope = scope
        self.entries: dict[HarnessKind, dict[str, HarnessEntry]] = {kind: {} for kind in _KINDS}
        self.refinements: list[RefinementEvent] = []

    @staticmethod
    def _request(operation: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        from . import host_request_sync

        return host_request_sync(operation, payload)

    def load(self) -> "HarnessState":
        data = self.snapshot(global_=self.scope == "global")
        entries = data.get("entries", {})
        self.entries = {
            kind: {
                str(item["id"]): _entry(item)
                for item in (entries.get(kind, []) if isinstance(entries, dict) else [])
                if isinstance(item, dict) and item.get("id")
            }
            for kind in _KINDS
        }
        self.refinements = [_event(item) for item in data.get("refinements", []) if isinstance(item, dict)]
        return self

    def save(self) -> "HarnessState":
        return self

    def _write(self, operation: str, payload: dict[str, Any], global_: bool, kwargs: dict[str, Any]) -> HarnessEntry:
        payload["global"] = _global(global_, kwargs)
        return _entry(self._request(operation, payload).get("entry"))

    def upsert(self, kind: HarnessKind, title: str, content: str, *, id: str | None = None,
               path: str = "general", reference: dict[str, Any] | None = None,
               arguments: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None,
               source: str = "agent", global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self._write("harness.upsert", {"kind": kind, "title": title, "content": content, "id": id,
            "path": path, "reference": reference, "arguments": arguments, "metadata": metadata, "source": source},
            global_, kwargs)

    def create(self, kind: HarnessKind, title: str, content: str, *, id: str | None = None,
               path: str = "general", reference: dict[str, Any] | None = None,
               arguments: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None,
               source: str = "agent", global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self._write("harness.create", {"kind": kind, "title": title, "content": content, "id": id,
            "path": path, "reference": reference, "arguments": arguments, "metadata": metadata, "source": source},
            global_, kwargs)

    def update(self, kind: HarnessKind, id: str, title: str, content: str, *, path: str | None = None,
               reference: dict[str, Any] | None = None, arguments: dict[str, Any] | None = None,
               metadata: dict[str, Any] | None = None, source: str = "agent", global_: bool = False,
               **kwargs: Any) -> HarnessEntry:
        return self._write("harness.update", {"kind": kind, "id": id, "title": title, "content": content,
            "path": path, "reference": reference, "arguments": arguments, "metadata": metadata, "source": source},
            global_, kwargs)

    def get(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> HarnessEntry | None:
        payload = self._request("harness.get", {"kind": kind, "id": id, "global": _global(global_, kwargs)})
        return _entry(payload["entry"]) if payload.get("entry") is not None else None

    def delete(self, kind: HarnessKind, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return bool(self._request("harness.delete", {"kind": kind, "id": id,
            "global": _global(global_, kwargs)}).get("deleted"))

    def list(self, kind: HarnessKind | None = None, *, global_: bool = False, **kwargs: Any) -> list[HarnessEntry]:
        result = self._request("harness.list", {"kind": kind, "global": _global(global_, kwargs)}).get("entries", [])
        if not isinstance(result, list):
            raise RuntimeError("OMP returned an invalid harness entry list")
        return [_entry(item) for item in result]

    def create_memory(self, title: str, content: str, *, id: str | None = None, path: str = "general",
                      metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.create("memory", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_memory(self, id: str, title: str, content: str, *, path: str | None = None,
                      metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.update("memory", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_memory(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("memory", id, global_=global_, **kwargs)

    def create_prompt_note(self, title: str, content: str, *, id: str | None = None, path: str = "policy",
                           metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.create("prompt", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_prompt_note(self, id: str, title: str, content: str, *, path: str | None = None,
                           metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.update("prompt", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_prompt_note(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("prompt", id, global_=global_, **kwargs)

    def create_skill(self, title: str, content: str, *, id: str | None = None, path: str = "general",
                     reference: dict[str, Any] | None = None, arguments: dict[str, Any] | None = None,
                     metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.create("skill", title, content, id=id, path=path, reference=reference, arguments=arguments,
                           metadata=metadata, global_=global_, **kwargs)

    def update_skill(self, id: str, title: str, content: str, *, path: str | None = None,
                     reference: dict[str, Any] | None = None, arguments: dict[str, Any] | None = None,
                     metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.update("skill", id, title, content, path=path, reference=reference, arguments=arguments,
                           metadata=metadata, global_=global_, **kwargs)

    def delete_skill(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("skill", id, global_=global_, **kwargs)

    def create_subagent(self, title: str, content: str, *, id: str | None = None, path: str = "general",
                        metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.create("subagent", title, content, id=id, path=path, metadata=metadata, global_=global_, **kwargs)

    def update_subagent(self, id: str, title: str, content: str, *, path: str | None = None,
                        metadata: dict[str, Any] | None = None, global_: bool = False, **kwargs: Any) -> HarnessEntry:
        return self.update("subagent", id, title, content, path=path, metadata=metadata, global_=global_, **kwargs)

    def delete_subagent(self, id: str, *, global_: bool = False, **kwargs: Any) -> bool:
        return self.delete("subagent", id, global_=global_, **kwargs)

    def record_refinement(self, trigger: str, changes: list[str] | str, *, evidence: str = "",
                          outcome: str = "", id: str | None = None, global_: bool = False,
                          **kwargs: Any) -> RefinementEvent:
        payload = self._request("harness.record_refinement", {"trigger": trigger, "changes": changes,
            "evidence": evidence, "outcome": outcome, "id": id, "global": _global(global_, kwargs)})
        return _event(payload.get("event"))

    def plan_refinement(self, observation: str, *, failing_component: str = "", next_step: str = "") -> dict[str, Any]:
        return self._request("harness.plan_refinement", {"observation": observation,
            "failing_component": failing_component, "next_step": next_step})

    def overview(self, *, max_entries_per_kind: int = 20, global_: bool = False, **kwargs: Any) -> str:
        result = self._request("harness.overview", {"max_entries_per_kind": max_entries_per_kind,
            "global": _global(global_, kwargs)}).get("overview")
        if not isinstance(result, str):
            raise RuntimeError("OMP returned an invalid harness overview")
        return result

    def snapshot(self, *, global_: bool = False, **kwargs: Any) -> dict[str, Any]:
        result = self._request("harness.snapshot", {"global": _global(global_, kwargs)}).get("snapshot")
        if not isinstance(result, dict):
            raise RuntimeError("OMP returned an invalid harness snapshot")
        return result


_local_state = HarnessState(scope="local")
_global_state = HarnessState(scope="global")


def get_harness_state(state_dir: str | None = None, *, global_: bool = False, **kwargs: Any) -> HarnessState:
    """Return the session-local or global OMP harness view.

    OMP owns storage paths; ``state_dir`` is rejected rather than creating a
    second Python-side state owner.
    """
    if state_dir is not None:
        raise ValueError("OMP owns harness storage; state_dir cannot be overridden")
    return _global_state if _global(global_, kwargs) else _local_state

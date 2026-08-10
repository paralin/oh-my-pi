"""Configured long-term memory through the session-owned backend."""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

from rlm import host_request


class RetainItem(TypedDict):
    """One durable fact queued or stored by :func:`retain`."""

    content: str
    context: NotRequired[str]


class ManagedSkill(TypedDict):
    """Optional managed-skill mutation paired with :func:`learn`."""

    action: Literal["create", "update"]
    name: str
    description: str
    body: str


async def retain(items: list[RetainItem]) -> dict[str, Any]:
    """Queue Hindsight facts or store Mnemopi facts in the configured bank."""
    return await host_request("long_term_memory.retain", {"items": items})


async def recall(query: str) -> dict[str, Any]:
    """Search the configured Hindsight or Mnemopi memory scope."""
    return await host_request("long_term_memory.recall", {"query": query})


async def reflect(query: str, *, context: str | None = None) -> dict[str, Any]:
    """Synthesize a bounded answer from configured long-term memory."""
    payload: dict[str, Any] = {"query": query}
    if context is not None:
        payload["context"] = context
    return await host_request("long_term_memory.reflect", payload)


async def edit(
    op: Literal["update", "forget", "invalidate"],
    memory_id: str,
    *,
    content: str | None = None,
    importance: float | None = None,
    replacement_id: str | None = None,
) -> dict[str, Any]:
    """Update, forget, or invalidate one Mnemopi memory returned by recall."""
    payload: dict[str, Any] = {"op": op, "id": memory_id}
    if content is not None:
        payload["content"] = content
    if importance is not None:
        payload["importance"] = importance
    if replacement_id is not None:
        payload["replacement_id"] = replacement_id
    return await host_request("long_term_memory.edit", payload)


async def update(
    memory_id: str,
    *,
    content: str | None = None,
    importance: float | None = None,
) -> dict[str, Any]:
    """Replace Mnemopi content or importance for a recalled memory."""
    return await edit("update", memory_id, content=content, importance=importance)


async def forget(memory_id: str) -> dict[str, Any]:
    """Delete one editable Mnemopi memory returned by recall."""
    return await edit("forget", memory_id)


async def invalidate(memory_id: str, *, replacement_id: str | None = None) -> dict[str, Any]:
    """Mark one Mnemopi memory stale, optionally naming its replacement."""
    return await edit("invalidate", memory_id, replacement_id=replacement_id)


async def learn(
    memory: str,
    *,
    context: str | None = None,
    skill: ManagedSkill | None = None,
) -> dict[str, Any]:
    """Persist a lesson and optionally create or update a managed skill.

    When the optional skill mutation fails after the lesson persisted, the
    result reports ``partial=True`` with the skill failure instead of claiming
    the skill was written.
    """
    payload: dict[str, Any] = {"memory": memory}
    if context is not None:
        payload["context"] = context
    if skill is not None:
        payload["skill"] = skill
    return await host_request("long_term_memory.learn", payload)


__all__ = [
    "ManagedSkill",
    "RetainItem",
    "edit",
    "forget",
    "invalidate",
    "learn",
    "recall",
    "reflect",
    "retain",
    "update",
]

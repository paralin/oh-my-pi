"""Host-owned OMP native security planning and provenance services."""

from __future__ import annotations

from typing import Literal

from rlm import host_request

TargetKind = Literal["repository", "scoped_path", "ref_diff", "working_tree"]
ValidationStatus = Literal["unvalidated", "validated", "rejected", "partial", "error"]


async def plan(
    *,
    target_kind: TargetKind = "repository",
    include_paths: list[str] | None = None,
    exclude_paths: list[str] | None = None,
    knowledge_base_paths: list[str] | None = None,
    base_revision: str | None = None,
    head_revision: str | None = None,
    output_root: str | None = None,
    archive_existing: bool | None = None,
    credential_id: int | None = None,
    thinking_level: str | None = None,
) -> dict[str, object]:
    """Preflight a bounded, provenance-preserving native security scan."""
    payload: dict[str, object] = {"target_kind": target_kind}
    if include_paths is not None:
        payload["include_paths"] = include_paths
    if exclude_paths is not None:
        payload["exclude_paths"] = exclude_paths
    if knowledge_base_paths is not None:
        payload["knowledge_base_paths"] = knowledge_base_paths
    if base_revision is not None:
        payload["base_revision"] = base_revision
    if head_revision is not None:
        payload["head_revision"] = head_revision
    if output_root is not None:
        payload["output_root"] = output_root
    if archive_existing is not None:
        payload["archive_existing"] = archive_existing
    if credential_id is not None:
        payload["credential_id"] = credential_id
    if thinking_level is not None:
        payload["thinking_level"] = thinking_level
    return await host_request("security.plan", payload)


async def start(plan_id: str) -> dict[str, object]:
    """Start an existing security plan without repeating preflight."""
    return await host_request("security.start", {"plan_id": plan_id})


async def status(operation_id: str) -> dict[str, object]:
    """Read one security operation snapshot, or a null operation."""
    return await host_request("security.status", {"operation_id": operation_id})


async def operations() -> dict[str, object]:
    """List bounded security operation snapshots."""
    return await host_request("security.operations", {})


async def cancel(operation_id: str) -> dict[str, object]:
    """Request cancellation of one security operation."""
    return await host_request("security.cancel", {"operation_id": operation_id})


async def publish(
    *,
    findings: list[dict[str, object]],
    coverage: dict[str, object],
    report: str,
) -> dict[str, object]:
    """Publish the canonical result for the active native security scan."""
    return await host_request(
        "security.publish",
        {"findings": findings, "coverage": coverage, "report": report},
    )


async def scans() -> dict[str, object]:
    """List persisted security scans."""
    return await host_request("security.scans", {})


async def scan(scan_id: str) -> dict[str, object]:
    """Read one persisted security scan."""
    return await host_request("security.scan", {"scan_id": scan_id})


async def findings(scan_id: str) -> dict[str, object]:
    """Read one scan's structured findings."""
    return await host_request("security.findings", {"scan_id": scan_id})


async def finding(scan_id: str, finding_id: str) -> dict[str, object]:
    """Read one structured finding, or a null finding."""
    return await host_request(
        "security.finding", {"scan_id": scan_id, "finding_id": finding_id}
    )


async def validate(
    scan_id: str,
    finding_id: str,
    *,
    status: ValidationStatus,
    summary: str,
    evidence_ids: list[str],
) -> dict[str, object]:
    """Persist a validation that cites existing finding evidence."""
    return await host_request(
        "security.validate",
        {
            "scan_id": scan_id,
            "finding_id": finding_id,
            "status": status,
            "summary": summary,
            "evidence_ids": evidence_ids,
        },
    )


async def compare(before_scan_id: str, after_scan_id: str) -> dict[str, object]:
    """Compare two completed security scan lineages."""
    return await host_request(
        "security.compare",
        {"before_scan_id": before_scan_id, "after_scan_id": after_scan_id},
    )


__all__ = [
    "cancel",
    "compare",
    "finding",
    "findings",
    "operations",
    "plan",
    "publish",
    "scan",
    "scans",
    "start",
    "status",
    "validate",
]

"""Active OMP IPython cell and namespace services."""

from __future__ import annotations

import ast
import re
from typing import Any

from rlm import host_request

_RESERVED_NAMES = frozenset(
    {
        "In",
        "Out",
        "get_ipython",
        "exit",
        "quit",
        "open",
        "rlm",
        "omp",
        "helpers",
        "show",
        "rg",
        "run",
        "asyncio",
        "agent_message",
        "agent_observe",
        "attach_image",
        "compact",
        "edit",
        "goal",
        "refine",
        "rlm_heartbeat",
        "websearch",
        "linear",
        "notion",
    }
)
_CREDENTIAL_NAME = re.compile(
    r"(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|session[_-]?key)",
    re.IGNORECASE,
)
_pins: set[str] = set()
_safe_scratch: set[str] = set()
_latest_scratch: tuple[str, ...] = ()
_before_namespace: dict[str, tuple[int, str]] | None = None
_before_scratch_candidates: frozenset[str] = frozenset()
_MAX_NAMESPACE_NAMES = 100


def _namespace() -> dict[str, Any]:
    from IPython import get_ipython

    shell = get_ipython()
    if shell is None:
        raise RuntimeError("omp.session namespace operations require IPython")
    return shell.user_ns


def _rejection(name: object, namespace: dict[str, Any], *, require_present: bool = True) -> str | None:
    if not isinstance(name, str) or not name:
        return "name must be a non-empty string"
    if name.startswith("_") or name in _RESERVED_NAMES:
        return f"{name!r} is reserved"
    if _CREDENTIAL_NAME.search(name):
        return f"{name!r} is credential-shaped"
    if require_present and name not in namespace:
        return f"{name!r} is unknown"
    return None


def _validated(names: tuple[str, ...], *, require_present: bool = True) -> tuple[str, ...]:
    namespace = _namespace()
    unique = tuple(dict.fromkeys(names))
    for name in unique:
        rejection = _rejection(name, namespace, require_present=require_present)
        if rejection is not None:
            raise ValueError(rejection)
    return unique


def _admitted_namespace() -> dict[str, tuple[int, str]]:
    namespace = _namespace()
    return {
        name: (id(value), type(value).__name__)
        for name, value in namespace.items()
        if _rejection(name, namespace, require_present=False) is None
    }


def _assignment_names(code: str) -> frozenset[str]:
    """Return names bound by explicit assignments in the executed module scope."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return frozenset()

    names: set[str] = set()

    def add_target(target: ast.expr) -> None:
        if isinstance(target, ast.Name):
            names.add(target.id)
        elif isinstance(target, (ast.List, ast.Tuple)):
            for element in target.elts:
                add_target(element)
        elif isinstance(target, ast.Starred):
            add_target(target.value)

    class AssignmentVisitor(ast.NodeVisitor):
        def visit_Assign(self, node: ast.Assign) -> None:
            for target in node.targets:
                add_target(target)
                self.visit(target)
            self.visit(node.value)

        def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
            add_target(node.target)
            self.visit(node.target)
            self.visit(node.annotation)
            if node.value is not None:
                self.visit(node.value)

        def visit_AugAssign(self, node: ast.AugAssign) -> None:
            self.visit(node.target)
            self.visit(node.value)

        def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
            add_target(node.target)
            self.visit(node.value)

        def _visit_function_signature(
            self, node: ast.FunctionDef | ast.AsyncFunctionDef
        ) -> None:
            for decorator in node.decorator_list:
                self.visit(decorator)
            for default in (*node.args.defaults, *node.args.kw_defaults):
                if default is not None:
                    self.visit(default)
            arguments = (*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs)
            if node.args.vararg is not None:
                arguments = (*arguments, node.args.vararg)
            if node.args.kwarg is not None:
                arguments = (*arguments, node.args.kwarg)
            for argument in arguments:
                if argument.annotation is not None:
                    self.visit(argument.annotation)
            if node.returns is not None:
                self.visit(node.returns)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            names.add(node.name)
            self._visit_function_signature(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            names.add(node.name)
            self._visit_function_signature(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            names.add(node.name)
            for expression in (*node.decorator_list, *node.bases):
                self.visit(expression)
            for keyword in node.keywords:
                self.visit(keyword.value)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            for default in (*node.args.defaults, *node.args.kw_defaults):
                if default is not None:
                    self.visit(default)

    AssignmentVisitor().visit(tree)
    return frozenset(names)


def _before_run_cell(info: Any) -> None:
    global _before_namespace, _before_scratch_candidates
    metadata = getattr(info, "cell_meta", None)
    tracked = isinstance(metadata, dict) and metadata.get("omp_track_namespace") is True
    _before_namespace = _admitted_namespace() if tracked else None
    raw_cell = getattr(info, "raw_cell", "")
    _before_scratch_candidates = _assignment_names(raw_cell) if tracked and isinstance(raw_cell, str) else frozenset()


def _namespace_group(names: list[str], namespace: dict[str, tuple[int, str]]) -> list[dict[str, str]]:
    return [{"name": name, "type": namespace[name][1]} for name in names]


def _after_run_cell(result: Any) -> None:
    global _before_namespace, _before_scratch_candidates
    before = _before_namespace
    scratch_candidates = _before_scratch_candidates
    _before_namespace = None
    _before_scratch_candidates = frozenset()
    if before is None:
        return
    try:
        after = _admitted_namespace()
        added_names = sorted(after.keys() - before.keys())
        rebound_names = sorted(
            name for name in after.keys() & before.keys() if after[name][0] != before[name][0]
        )
        deleted_names = sorted(before.keys() - after.keys())
        if getattr(result, "success", False) is True:
            _record_namespace_delta(tuple(added_names), tuple(deleted_names), scratch_candidates)
        else:
            _discard_namespace_delta(tuple(deleted_names))
        groups = (
            _namespace_group(added_names, after),
            _namespace_group(rebound_names, after),
            _namespace_group(deleted_names, before),
        )
        omitted = {
            key: max(0, len(group) - _MAX_NAMESPACE_NAMES)
            for key, group in zip(("added", "rebound", "deleted"), groups, strict=True)
        }
        shell = getattr(result, "shell", None) or __import__("IPython").get_ipython()
        kernel = getattr(shell, "kernel", None)
        if kernel is None:
            return
        execution_count = getattr(result, "execution_count", None)
        if not isinstance(execution_count, int):
            execution_count = max(0, shell.execution_count - 1)
        kernel.session.send(
            kernel.iopub_socket,
            "omp_namespace",
            content={
                "execution_count": execution_count,
                "added": groups[0][:_MAX_NAMESPACE_NAMES],
                "rebound": groups[1][:_MAX_NAMESPACE_NAMES],
                "deleted": groups[2][:_MAX_NAMESPACE_NAMES],
                "omitted": omitted,
            },
            parent=kernel.get_parent(),
        )
    except Exception:
        return


def _install_namespace_tracker() -> None:
    """Install the session-private namespace lifecycle hooks once per shell."""
    shell = __import__("IPython").get_ipython()
    if shell is None:
        raise RuntimeError("omp.session namespace tracking requires IPython")
    previous = getattr(shell, "_omp_namespace_tracker", None)
    if isinstance(previous, tuple) and len(previous) == 2:
        for event, callback in zip(("pre_run_cell", "post_run_cell"), previous, strict=True):
            try:
                shell.events.unregister(event, callback)
            except ValueError:
                pass
    shell.events.register("pre_run_cell", _before_run_cell)
    shell.events.register("post_run_cell", _after_run_cell)
    shell._omp_namespace_tracker = (_before_run_cell, _after_run_cell)


def pin(*names: str) -> tuple[str, ...]:
    """Pin admitted live names so scratch cleanup cannot remove them."""
    admitted = _validated(names)
    _pins.update(admitted)
    return tuple(sorted(_pins))


def unpin(*names: str) -> tuple[str, ...]:
    """Unpin names that are currently pinned."""
    admitted = _validated(names, require_present=False)
    unknown = [name for name in admitted if name not in _pins]
    if unknown:
        raise ValueError(f"{unknown[0]!r} is not pinned")
    _pins.difference_update(admitted)
    return tuple(sorted(_pins))


def list_pins() -> tuple[str, ...]:
    """Return pinned names in deterministic order."""
    namespace = _namespace()
    _pins.intersection_update(namespace)
    return tuple(sorted(_pins))


def cleanup_scratch(*names: str) -> tuple[str, ...]:
    """Delete requested known scratch names, or the latest unpinned additions."""
    namespace = _namespace()
    requested = _validated(names) if names else tuple(name for name in _latest_scratch if name not in _pins)
    removed: list[str] = []
    for name in requested:
        rejection = _rejection(name, namespace)
        if rejection is not None:
            raise ValueError(rejection)
        if name in _pins:
            raise ValueError(f"{name!r} is pinned")
        if name not in _safe_scratch:
            raise ValueError(f"{name!r} is not known scratch state")
    for name in requested:
        del namespace[name]
        _safe_scratch.discard(name)
        removed.append(name)
    return tuple(removed)


def _record_namespace_delta(
    added: tuple[str, ...], deleted: tuple[str, ...], scratch_candidates: frozenset[str]
) -> None:
    """Record admitted identity changes after one completed user cell."""
    global _latest_scratch
    _safe_scratch.update(added)
    _safe_scratch.difference_update(deleted)
    _latest_scratch = tuple(
        name for name in added if name in scratch_candidates and name in _safe_scratch
    )


def _discard_namespace_delta(deleted: tuple[str, ...]) -> None:
    """Reject failed-cell additions while reconciling names it removed."""
    global _latest_scratch
    _safe_scratch.difference_update(deleted)
    deleted_names = frozenset(deleted)
    _latest_scratch = tuple(name for name in _latest_scratch if name not in deleted_names)


def _recovery_metadata() -> dict[str, tuple[str, ...]]:
    """Return deterministic namespace metadata for snapshot persistence."""
    return {"pins": list_pins(), "latestScratch": _latest_scratch}


def _restore_namespace_metadata(pins: tuple[str, ...], latest_scratch: tuple[str, ...]) -> None:
    """Restore admitted pins and the latest cleanup cohort after snapshot restore."""
    global _latest_scratch
    namespace = _namespace()
    _pins.clear()
    _pins.update(name for name in pins if _rejection(name, namespace) is None)
    restored_scratch = tuple(
        name for name in latest_scratch if _rejection(name, namespace) is None
    )
    _safe_scratch.clear()
    _safe_scratch.update(restored_scratch)
    _latest_scratch = restored_scratch


def _restore_pins(names: tuple[str, ...]) -> None:
    """Restore pins from snapshots written before cleanup cohorts were persisted."""
    _restore_namespace_metadata(names, ())


async def info() -> dict[str, Any]:
    """Return bounded active session and cell identity without credentials."""
    return await host_request("session.info")


async def progress(message: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    """Publish progress into the current IPython cell update."""
    return await host_request("cell.progress", {"message": message, "data": data or {}})


async def allocate_artifact(
    label: str, *, mime_type: str = "application/octet-stream", suffix: str = ""
) -> dict[str, Any]:
    """Allocate one host-owned artifact path for the active cell."""
    return await host_request(
        "artifact.allocate", {"label": label, "mimeType": mime_type, "suffix": suffix}
    )

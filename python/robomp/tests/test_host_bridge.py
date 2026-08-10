from __future__ import annotations

import errno
import json
import os
import shutil
import socket
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest

from robomp.host_bridge import MAX_FRAME_BYTES, HostBridge, JsonValue, RobompOperation


@pytest.fixture
def bridge_root() -> Iterator[Path]:
    root = Path(tempfile.mkdtemp(prefix="robomp-host-test-", dir="/tmp"))
    try:
        yield root
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _exchange(path: Path, payload: bytes) -> dict[str, JsonValue]:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(path))
        client.sendall(payload)
        try:
            client.shutdown(socket.SHUT_WR)
        except OSError as error:
            if error.errno != errno.ENOTCONN:
                raise
        response = bytearray()
        while chunk := client.recv(64 * 1024):
            response.extend(chunk)
    return cast(dict[str, JsonValue], json.loads(response))


def _frame(operation: str, arguments: dict[str, JsonValue]) -> bytes:
    return json.dumps({"version": 1, "operation": operation, "arguments": arguments}).encode() + b"\n"


def test_bridge_dispatches_one_validated_operation_and_cleans_up(bridge_root: Path) -> None:
    calls: list[tuple[RobompOperation, dict[str, JsonValue]]] = []

    def dispatch(operation: RobompOperation, arguments: dict[str, JsonValue]) -> JsonValue:
        calls.append((operation, arguments))
        return {"comment_id": 42}

    bridge = HostBridge("task", dispatch, runtime_root=bridge_root)
    directory = bridge.directory
    with bridge:
        assert _exchange(bridge.socket_path, _frame("gh_post_comment", {"body": "ready"})) == {
            "ok": True,
            "result": {"comment_id": 42},
        }
        assert calls == [("gh_post_comment", {"body": "ready"})]
        assert directory.stat().st_mode & 0o777 == 0o700
        assert bridge.socket_path.stat().st_mode & 0o777 == 0o600

    assert not bridge.socket_path.exists()
    assert not directory.exists()


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (b'{"version":1,"operation":"missing","arguments":{}}\n', "unknown Robomp operation"),
        (b'{"version":1,"operation":"fetch_pr","arguments":{},"extra":1}\n', "unknown request fields"),
        (_frame("fetch_pr", {"extra": True}), "unknown fetch_pr arguments"),
        (_frame("gh_post_comment", {}), "missing gh_post_comment arguments"),
        (b'{"version":1,"version":1,"operation":"fetch_pr","arguments":{}}\n', "duplicate request field"),
        (_frame("fetch_pr", {}) + _frame("fetch_pr", {}), "exactly one request frame"),
    ],
)
def test_bridge_rejects_invalid_request_before_dispatch(bridge_root: Path, payload: bytes, message: str) -> None:
    called = False

    def dispatch(_operation: RobompOperation, _arguments: dict[str, JsonValue]) -> JsonValue:
        nonlocal called
        called = True
        return None

    with HostBridge("bridge", dispatch, runtime_root=bridge_root) as bridge:
        response = _exchange(bridge.socket_path, payload)

    assert response["ok"] is False
    assert message in cast(str, response["error"])
    assert not called


@pytest.mark.parametrize(
    ("operation", "arguments", "message"),
    [
        ("gh_post_comment", {"body": 7}, "body must be a string"),
        ("gh_post_comment", {"body": "ok", "number": True}, "number must be a integer"),
        ("gh_push_branch", {"skip_checks": "false"}, "skip_checks must be a boolean"),
        ("gh_request_review", {"reviewers": ["alice", 7]}, "reviewers must be a string list"),
        ("classify_issue", {"primary": "bug", "rationale": None}, "rationale must be a string"),
    ],
)
def test_bridge_rejects_wrong_argument_types_before_dispatch(
    bridge_root: Path,
    operation: str,
    arguments: dict[str, JsonValue],
    message: str,
) -> None:
    called = False

    def dispatch(_operation: RobompOperation, _arguments: dict[str, JsonValue]) -> JsonValue:
        nonlocal called
        called = True
        return None

    with HostBridge("typed", dispatch, runtime_root=bridge_root) as bridge:
        response = _exchange(bridge.socket_path, _frame(operation, arguments))

    assert response["ok"] is False
    assert message in cast(str, response["error"])
    assert not called


def test_bridge_accepts_null_for_optional_arguments(bridge_root: Path) -> None:
    calls: list[dict[str, JsonValue]] = []

    def dispatch(_operation: RobompOperation, arguments: dict[str, JsonValue]) -> JsonValue:
        calls.append(arguments)
        return None

    with HostBridge("nullable", dispatch, runtime_root=bridge_root) as bridge:
        response = _exchange(bridge.socket_path, _frame("gh_post_comment", {"body": "ok", "number": None}))

    assert response == {"ok": True, "result": None}
    assert calls == [{"body": "ok", "number": None}]


def test_bridge_bounds_request_and_response_frames(bridge_root: Path) -> None:
    def dispatch(_operation: RobompOperation, _arguments: dict[str, JsonValue]) -> JsonValue:
        return "x" * MAX_FRAME_BYTES

    with HostBridge("bridge-one", dispatch, runtime_root=bridge_root) as bridge:
        response = _exchange(bridge.socket_path, _frame("fetch_pr", {}))
        assert response == {"ok": False, "error": "response exceeds the bridge frame limit"}

    with HostBridge("bridge-two", dispatch, runtime_root=bridge_root) as bridge:
        response = _exchange(bridge.socket_path, b"x" * (MAX_FRAME_BYTES + 1))
        assert response == {"ok": False, "error": "request exceeds the bridge frame limit"}


def test_bridge_returns_dispatcher_failure_without_retaining_state(bridge_root: Path) -> None:
    def dispatch(_operation: RobompOperation, _arguments: dict[str, JsonValue]) -> JsonValue:
        raise RuntimeError("publication denied")

    with HostBridge("bridge", dispatch, runtime_root=bridge_root) as bridge:
        first = _exchange(bridge.socket_path, _frame("fetch_pr", {}))
        second = _exchange(bridge.socket_path, _frame("fetch_issue_thread", {}))

    assert first == {"ok": False, "error": "publication denied"}
    assert second == first


def test_bridge_rejects_reused_directory(bridge_root: Path) -> None:
    bridge = HostBridge("task", lambda _operation, _arguments: None, runtime_root=bridge_root)
    bridge.directory.mkdir()

    with pytest.raises(FileExistsError):
        bridge.start()
    assert bridge.directory.exists()


def test_bridge_path_is_bounded_for_long_task_identity(bridge_root: Path) -> None:
    bridge = HostBridge(
        "owner/repository#" + "x" * 4_096, lambda _operation, _arguments: None, runtime_root=bridge_root
    )
    with bridge:
        assert len(os.fsencode(bridge.socket_path)) < 104
        assert _exchange(bridge.socket_path, _frame("fetch_pr", {})) == {"ok": True, "result": None}


def test_bridge_close_drains_accepted_dispatch(bridge_root: Path) -> None:
    entered = threading.Event()
    release = threading.Event()
    result: list[dict[str, JsonValue]] = []

    def dispatch(_operation: RobompOperation, _arguments: dict[str, JsonValue]) -> JsonValue:
        entered.set()
        release.wait()
        return {"done": True}

    bridge = HostBridge("blocking", dispatch, runtime_root=bridge_root)
    bridge.start()
    client = threading.Thread(
        target=lambda: result.append(_exchange(bridge.socket_path, _frame("fetch_pr", {}))),
        daemon=True,
    )
    client.start()
    assert entered.wait(timeout=1)

    closed = threading.Event()
    closer = threading.Thread(target=lambda: (bridge.close(), closed.set()), daemon=True)
    closer.start()
    assert not closed.wait(timeout=0.05)
    assert bridge.directory.exists()

    release.set()
    closer.join(timeout=2)
    client.join(timeout=2)
    assert closed.is_set()
    assert result == [{"ok": True, "result": {"done": True}}]
    assert not bridge.directory.exists()


def test_bridge_close_is_idempotent_before_and_after_start(bridge_root: Path) -> None:
    bridge = HostBridge("task", lambda _operation, _arguments: None, runtime_root=bridge_root)
    bridge.close()
    bridge.start()
    bridge.close()
    bridge.close()

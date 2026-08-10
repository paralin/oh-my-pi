"""Task-local request/response bridge for Robomp agent operations."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import socketserver
import tempfile
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, Protocol, TypeAlias, cast

__all__ = ["HostBridge", "HostBridgeDispatcher", "RobompOperation"]

MAX_FRAME_BYTES = 256 * 1024
RobompOperation: TypeAlias = Literal[
    "abort_task",
    "classify_issue",
    "classify_pr",
    "fetch_issue_thread",
    "fetch_pr",
    "gh_open_pr",
    "gh_post_comment",
    "gh_push_branch",
    "gh_request_review",
    "gh_search_issues",
    "mark_unable_to_reproduce",
    "pr_review_comment",
    "repro_record",
    "search_commits",
    "set_issue_labels",
    "submit_pr_review",
]

FieldKind: TypeAlias = Literal["string", "integer", "boolean", "string_list"]
_STRING: Literal["string"] = "string"
_INTEGER: Literal["integer"] = "integer"
_BOOLEAN: Literal["boolean"] = "boolean"
_STRING_LIST: Literal["string_list"] = "string_list"
FieldRule: TypeAlias = tuple[FieldKind, bool]

_OPERATION_FIELDS: dict[str, dict[str, FieldRule]] = {
    "abort_task": {"reason": (_STRING, True)},
    "classify_issue": {
        "primary": (_STRING, True),
        "priority": (_STRING, False),
        "functional": (_STRING_LIST, False),
        "provider": (_STRING, False),
        "platform": (_STRING, False),
        "rationale": (_STRING, True),
        "branch_slug": (_STRING, False),
    },
    "classify_pr": {
        "rank": (_STRING, True),
        "type": (_STRING, True),
        "area": (_STRING, False),
        "provider": (_STRING, False),
        "rationale": (_STRING, True),
    },
    "fetch_issue_thread": {},
    "fetch_pr": {},
    "gh_open_pr": {
        "title": (_STRING, True),
        "body": (_STRING, True),
        "base": (_STRING, False),
        "draft": (_BOOLEAN, False),
        "skip_checks": (_BOOLEAN, False),
    },
    "gh_post_comment": {"body": (_STRING, True), "number": (_INTEGER, False)},
    "gh_push_branch": {"branch": (_STRING, False), "skip_checks": (_BOOLEAN, False)},
    "gh_request_review": {"reviewers": (_STRING_LIST, False), "assignees": (_STRING_LIST, False)},
    "gh_search_issues": {"query": (_STRING, True), "limit": (_INTEGER, False)},
    "mark_unable_to_reproduce": {"diagnosis": (_STRING, True), "info_needed": (_STRING, True)},
    "pr_review_comment": {
        "path": (_STRING, True),
        "line": (_INTEGER, True),
        "body": (_STRING, True),
        "side": (_STRING, False),
        "start_line": (_INTEGER, False),
        "start_side": (_STRING, False),
    },
    "repro_record": {
        "title": (_STRING, True),
        "command": (_STRING, True),
        "output": (_STRING, True),
        "exit_code": (_INTEGER, True),
        "reproduced": (_BOOLEAN, False),
    },
    "search_commits": {
        "query": (_STRING, True),
        "mode": (_STRING, False),
        "paths": (_STRING_LIST, False),
        "limit": (_INTEGER, False),
    },
    "set_issue_labels": {"labels": (_STRING_LIST, True), "number": (_INTEGER, False)},
    "submit_pr_review": {"body": (_STRING, True), "event": (_STRING, False)},
}

JsonValue: TypeAlias = None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]


class HostBridgeDispatcher(Protocol):
    """Dispatch one validated operation through task-bound Robomp authority."""

    def __call__(self, operation: RobompOperation, arguments: Mapping[str, JsonValue]) -> JsonValue: ...


def _decode_object(raw: bytes) -> dict[str, JsonValue]:
    def pairs(values: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
        result: dict[str, JsonValue] = {}
        for key, value in values:
            if key in result:
                raise ValueError(f"duplicate request field: {key}")
            result[key] = value
        return result

    def reject_constant(value: str) -> None:
        raise ValueError(f"invalid JSON number: {value}")

    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=reject_constant)
    if not isinstance(value, dict):
        raise ValueError("request must be a JSON object")
    return value


def _request(raw: bytes) -> tuple[RobompOperation, dict[str, JsonValue]]:
    request = _decode_object(raw)
    unknown = request.keys() - {"version", "operation", "arguments"}
    if unknown:
        raise ValueError(f"unknown request fields: {', '.join(sorted(unknown))}")
    version = request.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError("request version must be integer 1")
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in _OPERATION_FIELDS:
        raise ValueError(f"unknown Robomp operation: {operation}")
    arguments = request.get("arguments")
    if not isinstance(arguments, dict) or not all(isinstance(key, str) for key in arguments):
        raise ValueError("request arguments must be a JSON object")
    rules = _OPERATION_FIELDS[operation]
    argument_names = set(arguments)
    extra = argument_names - rules.keys()
    if extra:
        raise ValueError(f"unknown {operation} arguments: {', '.join(sorted(extra))}")
    missing = {name for name, (_kind, required) in rules.items() if required and name not in arguments}
    if missing:
        raise ValueError(f"missing {operation} arguments: {', '.join(sorted(missing))}")
    for name, value in arguments.items():
        kind, required = rules[name]
        if value is None and not required:
            continue
        valid = (
            (kind == _STRING and isinstance(value, str))
            or (kind == _INTEGER and isinstance(value, int) and not isinstance(value, bool))
            or (kind == _BOOLEAN and isinstance(value, bool))
            or (kind == _STRING_LIST and isinstance(value, list) and all(isinstance(item, str) for item in value))
        )
        if not valid:
            raise TypeError(f"{operation} argument {name} must be a {kind.replace('_', ' ')}")
    return cast(RobompOperation, operation), arguments


def _encode_response(value: JsonValue) -> bytes:
    encoded = json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    if len(encoded) > MAX_FRAME_BYTES:
        encoded = b'{"ok":false,"error":"response exceeds the bridge frame limit"}'
    return encoded + b"\n"


class _BridgeServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = False

    def __init__(self, path: str, dispatcher: HostBridgeDispatcher) -> None:
        self.dispatcher = dispatcher
        super().__init__(path, _BridgeHandler)


class _BridgeHandler(socketserver.BaseRequestHandler):
    server: _BridgeServer

    def handle(self) -> None:
        chunks = bytearray()
        while True:
            chunk = self.request.recv(min(64 * 1024, MAX_FRAME_BYTES + 1 - len(chunks)))
            if not chunk:
                break
            chunks.extend(chunk)
            if len(chunks) > MAX_FRAME_BYTES:
                self.request.sendall(_encode_response({"ok": False, "error": "request exceeds the bridge frame limit"}))
                return
            if b"\n" in chunks:
                break
        try:
            if not chunks.endswith(b"\n"):
                raise ValueError("request must end with a newline")
            lines = bytes(chunks).splitlines()
            if len(lines) != 1:
                raise ValueError("bridge accepts exactly one request frame per connection")
            operation, arguments = _request(lines[0])
            result = self.server.dispatcher(operation, arguments)
            response: JsonValue = {"ok": True, "result": result}
        except (ValueError, TypeError, json.JSONDecodeError) as error:
            response = {"ok": False, "error": str(error)}
        except Exception as error:  # noqa: BLE001 - dispatcher errors cross as bounded failures
            response = {"ok": False, "error": str(error)}
        try:
            encoded = _encode_response(response)
        except (TypeError, ValueError):
            encoded = _encode_response({"ok": False, "error": "dispatcher returned an invalid JSON result"})
        try:
            self.request.sendall(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass


class HostBridge:
    """Own one secure AF_UNIX listener and drain accepted work on close.

    A client disconnect cancels result delivery, not an already admitted dispatcher
    mutation. The dispatcher remains responsible for its operation's audit semantics.
    """

    def __init__(
        self,
        task_id: str,
        dispatcher: HostBridgeDispatcher,
        *,
        runtime_root: Path | None = None,
        client_uid: int | None = None,
        client_gid: int | None = None,
    ) -> None:
        if not task_id.strip():
            raise ValueError("Robomp host bridge task_id must not be empty")
        self._client_uid = os.geteuid() if client_uid is None else client_uid
        self._client_gid = os.getegid() if client_gid is None else client_gid
        digest = hashlib.sha256(task_id.encode()).hexdigest()[:12]
        root = Path(tempfile.gettempdir()) if runtime_root is None else runtime_root
        self.directory = root / f"robomp-{self._client_uid}-{digest}-{secrets.token_hex(4)}"
        self.socket_path = self.directory / "host.sock"
        self._dispatcher = dispatcher
        self._server: _BridgeServer | None = None
        self._thread: threading.Thread | None = None
        self._created = False

    def __enter__(self) -> HostBridge:
        self.start()
        return self

    def __exit__(self, _type: object, _value: object, _traceback: object) -> None:
        self.close()

    def start(self) -> None:
        """Create the private socket directory and start accepting requests."""
        if self._server is not None:
            raise RuntimeError("Robomp host bridge is already running")
        self.directory.mkdir(mode=0o700)
        self._created = True
        server: _BridgeServer | None = None
        try:
            os.chmod(self.directory, 0o700)
            if os.geteuid() == 0:
                os.chown(self.directory, self._client_uid, self._client_gid)
            server = _BridgeServer(str(self.socket_path), self._dispatcher)
            os.chmod(self.socket_path, 0o600)
            if os.geteuid() == 0:
                os.chown(self.socket_path, self._client_uid, self._client_gid)
            thread = threading.Thread(target=server.serve_forever, name="robomp-host-bridge", daemon=True)
            thread.start()
            self._server = server
            self._thread = thread
        except BaseException:
            server and server.server_close()
            self.socket_path.unlink(missing_ok=True)
            shutil.rmtree(self.directory, ignore_errors=True)
            self._created = False
            raise

    def close(self) -> None:
        """Stop accepting requests and remove all filesystem endpoints."""
        server = self._server
        thread = self._thread
        self._server = None
        self._thread = None
        if server is not None:
            server.shutdown()
            server.server_close()
        if thread is not None:
            thread.join()
        if self._created:
            self.socket_path.unlink(missing_ok=True)
            shutil.rmtree(self.directory, ignore_errors=True)
            self._created = False

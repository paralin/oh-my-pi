"""Bounded file, search, and supervised command helpers for OMP kernels."""

from __future__ import annotations

import codecs
import os
import re
import shlex
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from omp import process as _process

_MAX_SHOW_LINES = 500
_MAX_SHOW_BYTES = 64 * 1024
_MAX_SHOW_SCAN_BYTES = 8 * 1024 * 1024
_SHOW_CHUNK_BYTES = 16 * 1024
_MAX_RG_PATHS = 32
_MAX_RG_HITS = 200
_MAX_RG_BYTES = 64 * 1024
_MAX_RG_FILES = 20_000
_MAX_RG_SCAN_BYTES = 32 * 1024 * 1024
_MAX_COMMAND_ARGS = 256
_MAX_COMMAND_BYTES = 32 * 1024
_MAX_TAIL_BYTES = 32 * 1024
_SKIP_DIRECTORIES = frozenset({".git", ".hg", ".svn", ".venv", "node_modules", "__pycache__"})


def _roots() -> tuple[Path, ...]:
    project = Path(os.environ.get("OMP_SESSION_CWD", os.getcwd())).resolve()
    artifact = os.environ.get("OMP_SESSION_ARTIFACT_DIR")
    return (project,) if not artifact else (project, Path(artifact).resolve())


def _safe_path(value: str | os.PathLike[str]) -> Path:
    if not isinstance(value, (str, os.PathLike)):
        raise TypeError(f"path must be str or PathLike, got {type(value).__name__}")
    raw = os.fspath(value)
    if not isinstance(raw, str) or not raw or "\0" in raw:
        raise ValueError("path must be a non-empty path without NUL bytes")
    roots = _roots()
    target = Path(raw)
    resolved = (roots[0] / target).resolve() if not target.is_absolute() else target.resolve()
    if not any(resolved == root or resolved.is_relative_to(root) for root in roots):
        raise ValueError("path must stay inside the project or managed artifact directory")
    return resolved


def _bounded(value: str, maximum: int) -> tuple[str, bool]:
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum:
        return value, False
    marker = "\n… output truncated …"
    keep = maximum - len(marker.encode("utf-8"))
    return encoded[:keep].decode("utf-8", errors="ignore") + marker, True


def _show_marker(value: str, marker: str) -> str:
    marker_bytes = len(marker.encode("utf-8"))
    if marker_bytes > _MAX_SHOW_BYTES:
        raise RuntimeError("show marker exceeds its output bound")
    keep = _MAX_SHOW_BYTES - marker_bytes
    prefix = value.encode("utf-8")[:keep].decode("utf-8", errors="ignore")
    return prefix.rstrip("\n") + marker


def show(path: str | os.PathLike[str], start: int = 1, end: int = 200) -> str:
    """Return numbered lines ``start`` through ``end`` from one confined text file.

    Lines are one-based and inclusive. A call reads at most 500 requested lines,
    scans at most 8 MiB, and returns at most 64 KiB. Binary files containing NUL
    bytes are rejected. Example: ``show('src/app.py', 40, 90)``.
    """
    if not isinstance(start, int) or isinstance(start, bool):
        raise TypeError("start must be an int")
    if not isinstance(end, int) or isinstance(end, bool):
        raise TypeError("end must be an int")
    if start < 1 or end < start:
        raise ValueError("line range must satisfy 1 <= start <= end")
    if end - start + 1 > _MAX_SHOW_LINES:
        raise ValueError(f"line range may contain at most {_MAX_SHOW_LINES} lines")
    target = _safe_path(path)
    if not target.is_file():
        raise FileNotFoundError(f"not a regular file: {path}")

    output = ""
    line_number = 1
    scanned = 0
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    pending = ""

    def append(text: str) -> bool:
        nonlocal output
        output, _ = _bounded(output + text, _MAX_SHOW_BYTES)
        return False

    def consume(data: bytes, finish_line: bool) -> bool:
        nonlocal pending
        text = decoder.decode(data, final=finish_line)
        if line_number < start or line_number > end:
            if finish_line:
                pending = ""
            return False
        text = pending + text
        if not finish_line:
            if not text:
                return False
            pending = text[-1]
            text = text[:-1]
        else:
            pending = ""
            text = text.rstrip("\r") + "\n"
        return append(text)

    if line_number >= start and append(f"{line_number:>6}: "):
        return output

    with target.open("rb", buffering=0) as source:
        while scanned < _MAX_SHOW_SCAN_BYTES and line_number <= end:
            chunk = source.read(min(_SHOW_CHUNK_BYTES, _MAX_SHOW_SCAN_BYTES - scanned))
            if not chunk:
                if line_number >= start and consume(b"", True):
                    return output
                return output.rstrip("\n")
            scanned += len(chunk)
            if b"\0" in chunk:
                raise ValueError("show only accepts text files; NUL byte detected")
            offset = 0
            while offset < len(chunk) and line_number <= end:
                newline = chunk.find(b"\n", offset)
                if newline < 0:
                    if consume(chunk[offset:], False):
                        return output
                    break
                if consume(chunk[offset:newline], True):
                    return output
                line_number += 1
                decoder = codecs.getincrementaldecoder("utf-8")("replace")
                if line_number <= end and line_number >= start and append(f"{line_number:>6}: "):
                    return output
                offset = newline + 1

    if line_number > end:
        return output.rstrip("\n")
    if line_number < start:
        raise RuntimeError(
            f"show stopped after {_MAX_SHOW_SCAN_BYTES} scanned bytes before reaching start line {start}"
        )
    marker = f"\n… scan stopped after {_MAX_SHOW_SCAN_BYTES} bytes before completing line {line_number} …"
    return _show_marker(output, marker)


def _files(paths: Sequence[str | os.PathLike[str]]):
    seen: set[Path] = set()
    count = 0
    for value in paths:
        target = _safe_path(value)
        if target.is_file():
            candidates = (target,)
        elif target.is_dir():
            def walk():
                for directory, names, filenames in os.walk(target, followlinks=False):
                    names[:] = sorted(name for name in names if name not in _SKIP_DIRECTORIES)
                    for filename in sorted(filenames):
                        yield Path(directory, filename)
            candidates = walk()
        else:
            raise FileNotFoundError(f"path does not exist: {value}")
        for candidate in candidates:
            resolved = candidate.resolve()
            if resolved in seen or not resolved.is_file():
                continue
            _safe_path(resolved)
            seen.add(resolved)
            count += 1
            if count > _MAX_RG_FILES:
                raise RuntimeError(f"search exceeds {_MAX_RG_FILES} files")
            yield resolved


def rg(pattern: str, *paths: str | os.PathLike[str]) -> str:
    """Return bounded regex matches from confined workspace or artifact paths.

    The result contains at most 200 hits and 64 KiB after scanning at most
    20,000 files or 32 MiB. Paths default to the project root. Example:
    ``rg(r'TODO|FIXME', 'src', 'test')``.
    """
    if not isinstance(pattern, str):
        raise TypeError(f"pattern must be str, got {type(pattern).__name__}")
    if not pattern or len(pattern) > 1_024:
        raise ValueError("pattern must contain 1 through 1024 characters")
    if len(paths) > _MAX_RG_PATHS:
        raise ValueError(f"rg accepts at most {_MAX_RG_PATHS} paths")
    expression = re.compile(pattern)
    roots = _roots()
    requested = paths or (".",)
    matches: list[str] = []
    scanned = 0
    for target in _files(requested):
        try:
            size = target.stat().st_size
        except OSError:
            continue
        if scanned + size > _MAX_RG_SCAN_BYTES:
            matches.append(f"[search stopped after {_MAX_RG_SCAN_BYTES} scanned bytes]")
            break
        scanned += size
        try:
            with target.open("r", encoding="utf-8", errors="replace") as source:
                for line_number, line in enumerate(source, 1):
                    if "\0" in line:
                        break
                    if not expression.search(line):
                        continue
                    relative = next((target.relative_to(root) for root in roots if target.is_relative_to(root)), target)
                    matches.append(f"{relative}:{line_number}:{line.rstrip(chr(10)).rstrip(chr(13))}")
                    output, truncated = _bounded("\n".join(matches), _MAX_RG_BYTES)
                    if truncated:
                        return output
                    if len(matches) >= _MAX_RG_HITS:
                        matches.append(f"[search stopped after {_MAX_RG_HITS} hits]")
                        return "\n".join(matches)
        except (OSError, UnicodeError):
            continue
    return "\n".join(matches)


def _argv(command: str | Sequence[str]) -> tuple[str, list[str]]:
    if isinstance(command, str):
        try:
            values = shlex.split(command, posix=os.name != "nt")
        except ValueError as error:
            raise ValueError(f"invalid command string: {error}") from error
    elif isinstance(command, Sequence) and not isinstance(command, (bytes, bytearray)):
        values = list(command)
    else:
        raise TypeError("cmd must be a str or a sequence of str argv entries")
    if not values:
        raise ValueError("cmd must contain an application")
    if len(values) > _MAX_COMMAND_ARGS:
        raise ValueError(f"cmd may contain at most {_MAX_COMMAND_ARGS} argv entries")
    if any(not isinstance(value, str) for value in values):
        raise TypeError("every cmd argv entry must be a str")
    if any(not value or "\0" in value for value in values):
        raise ValueError("cmd argv entries must be non-empty and contain no NUL bytes")
    if sum(len(value.encode("utf-8")) for value in values) > _MAX_COMMAND_BYTES:
        raise ValueError(f"cmd argv exceeds {_MAX_COMMAND_BYTES} bytes")
    return values[0], values[1:]


def _process_output(head: str, tail: str, total: int) -> tuple[str, int]:
    head_bytes = head.encode("utf-8")
    tail_bytes = tail.encode("utf-8")
    if total <= max(len(head_bytes), len(tail_bytes)):
        value = tail if len(tail_bytes) >= len(head_bytes) else head
        return _bounded(value, _MAX_TAIL_BYTES)[0], 0
    if total <= len(head_bytes) + len(tail_bytes):
        missing_after_head = total - len(head_bytes)
        suffix = tail_bytes[len(tail_bytes) - missing_after_head :] if missing_after_head > 0 else b""
        value = (head_bytes + suffix).decode("utf-8", errors="ignore")
        return _bounded(value, _MAX_TAIL_BYTES)[0], 0
    omitted = total - len(head_bytes) - len(tail_bytes)
    while True:
        marker = f"\n… {omitted} bytes omitted; full output in transcript …\n".encode("utf-8")
        keep = max(0, _MAX_TAIL_BYTES - len(marker))
        head_keep = min(len(head_bytes), (keep + 1) // 2)
        tail_keep = min(len(tail_bytes), keep - head_keep)
        next_omitted = total - head_keep - tail_keep
        if next_omitted == omitted:
            break
        omitted = next_omitted
    prefix = head_bytes[:head_keep].decode("utf-8", errors="ignore")
    suffix = tail_bytes[len(tail_bytes) - tail_keep :].decode("utf-8", errors="ignore")
    rendered = prefix + marker.decode("utf-8") + suffix
    return rendered, omitted


async def run(
    cmd: str | Sequence[str],
    *,
    timeout: float | str | None = None,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    """Run finite argv through ``omp.process.run`` and return bounded head/tail previews.

    A string is split with ``shlex`` and never invokes a shell. The result names
    ``transcript_path`` for complete output. Example:
    ``await run(['git', 'status', '--short'])``.
    """
    application, args = _argv(cmd)
    result = await _process.run(application, args, timeout=timeout, cwd=cwd, env=env)
    artifact = result.get("transcript_artifact")
    transcript_path = artifact.get("path") if isinstance(artifact, dict) else None
    if not isinstance(transcript_path, str) or not transcript_path:
        raise RuntimeError("omp.process.run returned no transcript artifact path")
    stdout_head = str(result.get("stdout_head", ""))
    stderr_head = str(result.get("stderr_head", ""))
    stdout_tail, stdout_omitted = _process_output(
        stdout_head, str(result.get("stdout_tail", "")), int(result.get("stdout_bytes", 0))
    )
    stderr_tail, stderr_omitted = _process_output(
        stderr_head, str(result.get("stderr_tail", "")), int(result.get("stderr_bytes", 0))
    )
    return {
        "state": result.get("state"),
        "exit_code": result.get("exit_code"),
        "signal": result.get("signal"),
        "timed_out": result.get("timed_out", False),
        "cancelled": result.get("cancelled", False),
        "duration_ms": result.get("duration_ms"),
        "cwd": result.get("cwd"),
        "stdout_head": stdout_head,
        "stderr_head": stderr_head,
        "stdout_tail": stdout_tail,
        "stderr_tail": stderr_tail,
        "stdout_bytes": result.get("stdout_bytes", 0),
        "stderr_bytes": result.get("stderr_bytes", 0),
        "stdout_omitted_bytes": stdout_omitted,
        "stderr_omitted_bytes": stderr_omitted,
        "stdout_truncated": stdout_omitted > 0,
        "stderr_truncated": stderr_omitted > 0,
        "transcript_path": transcript_path,
    }


__all__ = ["rg", "run", "show"]

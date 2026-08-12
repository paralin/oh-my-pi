import * as path from "node:path";

/** Maximum combined size of independently serialized user values. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

const SNAPSHOT_MARKER = "__OMP_IPYTHON_SNAPSHOT__";

export interface IpythonSnapshotIssue {
	readonly name: string;
	readonly reason: string;
}

export interface IpythonSnapshotResult {
	readonly saved: readonly string[];
	readonly skipped: readonly IpythonSnapshotIssue[];
	readonly oversized: readonly IpythonSnapshotIssue[];
	readonly failed: readonly IpythonSnapshotIssue[];
	readonly bytes: number;
	readonly path: string;
	readonly manifestPath: string;
	readonly pins?: readonly string[];
	readonly latestScratch?: readonly string[];
}

export interface IpythonRestoreResult {
	readonly restored: readonly string[];
	readonly failed: readonly IpythonSnapshotIssue[];
	readonly missing: boolean;
	readonly path: string;
	readonly pins?: readonly string[];
	readonly latestScratch?: readonly string[];
}

/** JSON manifest beside a snapshot payload. */
export function snapshotManifestPath(snapshotPath: string): string {
	const extension = path.extname(snapshotPath);
	const candidate = extension ? `${snapshotPath.slice(0, -extension.length)}.json` : `${snapshotPath}.json`;
	return candidate === snapshotPath ? `${snapshotPath}.manifest.json` : candidate;
}

function pythonString(value: string): string {
	return JSON.stringify(value);
}

/** Python executed inside the user kernel to save each admitted name independently. */
export function buildSnapshotCode(outPath: string, manifestPath: string, maxBytes: number): string {
	return `
def _omp_snapshot_state():
    import asyncio as _asyncio
    import builtins as _b
    import datetime as _datetime
    import io as _io
    import json as _json
    import multiprocessing.process as _mp_process
    import os as _os
    import re as _re
    import socket as _socket
    import subprocess as _subprocess
    import sys as _sys
    import threading as _threading
    import types as _types
    import weakref as _weakref

    _marker = ${pythonString(SNAPSHOT_MARKER)}
    _reserved = {"In", "Out", "get_ipython", "exit", "quit", "open", "rlm", "omp", "helpers", "show", "rg", "run", "asyncio", "agent_message", "agent_observe", "attach_image", "compact", "edit", "goal", "refine", "rlm_heartbeat", "websearch", "linear", "notion"}
    _credential_name = _re.compile(
        r"(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|session[_-]?key)",
        _re.IGNORECASE,
    )
    _unsafe_types = (
        _types.ModuleType,
        _types.CodeType,
        _types.FrameType,
        _types.TracebackType,
        _types.GeneratorType,
        _types.CoroutineType,
        _types.AsyncGeneratorType,
        _types.MappingProxyType,
        _io.IOBase,
        _socket.socket,
        _subprocess.Popen,
        _mp_process.BaseProcess,
        _threading.Thread,
        _asyncio.Future,
        _weakref.ReferenceType,
        _weakref.ProxyType,
        _weakref.CallableProxyType,
    )

    try:
        _dill = _b.__import__("dill")
    except _b.Exception as _err:
        _b.print(
            _marker
            + _json.dumps(
                {
                    "saved": [],
                    "skipped": [],
                    "oversized": [],
                    "failed": [{"name": "<snapshot>", "reason": "dill unavailable: " + _b.str(_err)[:200]}],
                    "bytes": 0,
                }
            )
        )
        return

    try:
        _ip = _b.__import__("IPython").get_ipython()
        _ns = _ip.user_ns if _ip is not None else _b.globals()
        _hidden = _b.set(_b.getattr(_ip, "user_ns_hidden", {}) or {}) if _ip is not None else _b.set()
        _payload = {}
        _skipped = []
        _oversized = []
        _failed = []
        _total = 0
        for _name in _b.list(_ns.keys()):
            if not _b.isinstance(_name, _b.str) or _name.startswith("_") or _name in _hidden or _name in _reserved:
                continue
            if _credential_name.search(_name):
                _skipped.append({"name": _name, "reason": "credential-shaped name"})
                continue
            _value = _ns[_name]
            _value_type = _b.type(_value)
            _type_module = _b.getattr(_value_type, "__module__", "")
            if _b.isinstance(_value, _unsafe_types) or _type_module.startswith(
                ("comm.", "zmq.", "jupyter_client.", "ipykernel.", "multiprocessing.")
            ):
                _skipped.append({"name": _name, "reason": "unsafe runtime type: " + _value_type.__name__})
                continue
            try:
                _blob = _dill.dumps(_value, recurse=True)
            except _b.Exception as _err:
                _failed.append(
                    {"name": _name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}
                )
                continue
            if _b.len(_blob) > ${maxBytes} or _total + _b.len(_blob) > ${maxBytes}:
                _oversized.append({"name": _name, "reason": "exceeds snapshot size cap (${maxBytes} bytes)"})
                continue
            _payload[_name] = _blob
            _total += _b.len(_blob)

        _parent = _os.path.dirname(${pythonString(outPath)})
        if _parent:
            _os.makedirs(_parent, exist_ok=True)
        _payload_tmp = ${pythonString(outPath)} + ".tmp"
        try:
            with _b.open(_payload_tmp, "wb") as _file:
                _dill.dump(_payload, _file)
            _os.replace(_payload_tmp, ${pythonString(outPath)})
        except _b.Exception as _err:
            try:
                _os.remove(_payload_tmp)
            except _b.Exception:
                pass
            _b.print(
                _marker
                + _json.dumps(
                    {
                        "saved": [],
                        "skipped": _skipped,
                        "oversized": _oversized,
                        "failed": _failed + [{"name": "<snapshot>", "reason": "write failed: " + _b.str(_err)[:200]}],
                        "bytes": 0,
                    }
                )
            )
            return

        _bytes = _os.path.getsize(${pythonString(outPath)})
        _saved = _b.sorted(_payload.keys())
        try:
            _namespace_metadata = _b.__import__("omp").session._recovery_metadata()
            _pins = _b.list(_namespace_metadata.get("pins", ()))
            _latest_scratch = _b.list(_namespace_metadata.get("latestScratch", ()))
        except _b.Exception:
            _pins = []
            _latest_scratch = []
        _pins = _b.sorted(_name for _name in _pins if _name in _payload)
        _latest_scratch = _b.sorted(_name for _name in _latest_scratch if _name in _payload)
        _manifest = {
            "version": 2,
            "saved": _saved,
            "pins": _pins,
            "latestScratch": _latest_scratch,
            "skipped": _skipped,
            "oversized": _oversized,
            "failed": _failed,
            "bytes": _bytes,
            "pythonVersion": _sys.version.split()[0],
            "timestamp": _datetime.datetime.now(_datetime.timezone.utc).isoformat(),
        }
        _manifest_tmp = ${pythonString(manifestPath)} + ".tmp"
        try:
            with _b.open(_manifest_tmp, "w", encoding="utf-8") as _file:
                _json.dump(_manifest, _file, sort_keys=True)
            _os.replace(_manifest_tmp, ${pythonString(manifestPath)})
        except _b.Exception as _err:
            try:
                _os.remove(_manifest_tmp)
            except _b.Exception:
                pass
            _failed.append({"name": "<manifest>", "reason": "write failed: " + _b.str(_err)[:200]})

        _b.print(
            _marker
            + _json.dumps(
                {
                    "saved": _saved,
                    "pins": _pins,
                    "latestScratch": _latest_scratch,
                    "skipped": _skipped,
                    "oversized": _oversized,
                    "failed": _failed,
                    "bytes": _bytes,
                }
            )
        )
    except _b.Exception as _err:
        _b.print(
            _marker
            + _json.dumps(
                {
                    "saved": [],
                    "skipped": [],
                    "oversized": [],
                    "failed": [{"name": "<snapshot>", "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}],
                    "bytes": 0,
                }
            )
        )


try:
    _omp_snapshot_state()
finally:
    del _omp_snapshot_state
`.trim();
}

/** Python executed inside the user kernel to restore each payload entry independently. */
export function buildRestoreCode(inPath: string): string {
	return `
def _omp_restore_state():
    import builtins as _b
    import json as _json
    import os as _os
    import re as _re

    _marker = ${pythonString(SNAPSHOT_MARKER)}
    _reserved = {"In", "Out", "get_ipython", "exit", "quit", "open", "rlm", "omp", "helpers", "show", "rg", "run", "asyncio", "agent_message", "agent_observe", "attach_image", "compact", "edit", "goal", "refine", "rlm_heartbeat", "websearch", "linear", "notion"}
    _credential_name = _re.compile(
        r"(?:api[_-]?key|apikey|secret|token|password|passwd|credential|access[_-]?key|private[_-]?key|session[_-]?key)",
        _re.IGNORECASE,
    )
    if not _os.path.exists(${pythonString(inPath)}):
        _b.print(_marker + _json.dumps({"restored": [], "failed": [], "missing": True}))
        return
    try:
        _dill = _b.__import__("dill")
        with _b.open(${pythonString(inPath)}, "rb") as _file:
            _payload = _dill.load(_file)
        if not _b.isinstance(_payload, _b.dict):
            raise _b.ValueError("snapshot payload is not a dictionary")
    except _b.Exception as _err:
        _b.print(
            _marker
            + _json.dumps(
                {
                    "restored": [],
                    "failed": [{"name": "<snapshot>", "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]}],
                    "missing": False,
                }
            )
        )
        return

    _pins = []
    try:
        _manifest_path = ${pythonString(snapshotManifestPath(inPath))}
        with _b.open(_manifest_path, "r", encoding="utf-8") as _file:
            _manifest = _json.load(_file)
        if _b.isinstance(_manifest, _b.dict) and _manifest.get("version") == 2:
            _raw_pins = _manifest.get("pins", [])
            if _b.isinstance(_raw_pins, _b.list):
                _pins = [_name for _name in _raw_pins if _b.isinstance(_name, _b.str)]
    except (_b.OSError, _b.ValueError, _b.TypeError):
        pass

    _ip = _b.__import__("IPython").get_ipython()
    _ns = _ip.user_ns if _ip is not None else _b.globals()
    _restored = []
    _failed = []
    for _name, _blob in _payload.items():
        if not _b.isinstance(_name, _b.str):
            _failed.append({"name": "<invalid>", "reason": "snapshot name is not a string"})
            continue
        if _name.startswith("_") or _name in _reserved:
            _failed.append({"name": _name, "reason": "reserved runtime name was not restored"})
            continue
        if _credential_name.search(_name):
            _failed.append({"name": _name, "reason": "credential-shaped name was not restored"})
            continue
        try:
            _ns[_name] = _dill.loads(_blob)
            _restored.append(_name)
        except _b.Exception as _err:
            _failed.append({"name": _name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
    _b.print(
        _marker
        + _json.dumps({"restored": _b.sorted(_restored), "pins": _b.sorted(_name for _name in _pins if _name in _restored), "failed": _failed, "missing": False})
    )


try:
    _omp_restore_state()
finally:
    del _omp_restore_state
`.trim();
}

interface RawSnapshotResult {
	readonly saved?: unknown;
	readonly skipped?: unknown;
	readonly oversized?: unknown;
	readonly failed?: unknown;
	readonly bytes?: unknown;
	readonly pins?: unknown;
	readonly latestScratch?: unknown;
}

interface RawRestoreResult {
	readonly restored?: unknown;
	readonly failed?: unknown;
	readonly missing?: unknown;
	readonly pins?: unknown;
}

function parseMarker<T>(stdout: string): T | undefined {
	const index = stdout.lastIndexOf(SNAPSHOT_MARKER);
	if (index < 0) return undefined;
	const line = stdout
		.slice(index + SNAPSHOT_MARKER.length)
		.split("\n", 1)[0]
		?.trim();
	if (!line) return undefined;
	try {
		const parsed: unknown = JSON.parse(line);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : undefined;
	} catch {
		return undefined;
	}
}

function names(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
}

function issues(value: unknown): IpythonSnapshotIssue[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(entry => {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
		const candidate = entry as { readonly name?: unknown; readonly reason?: unknown };
		if (typeof candidate.name !== "string") return [];
		return [
			{ name: candidate.name, reason: typeof candidate.reason === "string" ? candidate.reason : "unknown reason" },
		];
	});
}

export function parseSnapshotResult(
	stdout: string,
	snapshotPath: string,
	manifestPath: string,
): IpythonSnapshotResult | undefined {
	const raw = parseMarker<RawSnapshotResult>(stdout);
	if (!raw) return undefined;
	return {
		saved: names(raw.saved),
		skipped: issues(raw.skipped),
		oversized: issues(raw.oversized),
		failed: issues(raw.failed),
		bytes: typeof raw.bytes === "number" && Number.isFinite(raw.bytes) && raw.bytes >= 0 ? raw.bytes : 0,
		path: snapshotPath,
		manifestPath,
		pins: names(raw.pins),
		latestScratch: names(raw.latestScratch),
	};
}

export function parseRestoreResult(stdout: string, snapshotPath: string): IpythonRestoreResult | undefined {
	const raw = parseMarker<RawRestoreResult>(stdout);
	if (!raw) return undefined;
	return {
		restored: names(raw.restored),
		failed: issues(raw.failed),
		missing: raw.missing === true,
		path: snapshotPath,
		pins: names(raw.pins),
	};
}

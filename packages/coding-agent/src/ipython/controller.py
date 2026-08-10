"""Translate framed host commands to one session-private Jupyter kernel."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import sys
import threading
from contextlib import suppress
from dataclasses import dataclass, field
from typing import TypeAlias

from jupyter_client import AsyncKernelClient, AsyncKernelManager

_MAX_STREAM_CHARS = 1_048_576
_MAX_FRAME_CHARS = 8 * 1024 * 1024
_SHUTDOWN_TIMEOUT_SECONDS = 3.0
_READY_TIMEOUT_SECONDS = 10.0
HOST_COMM_TARGET = "host.request"
_MAX_ACTIVE_COMMS = 256


@dataclass(frozen=True)
class ExecuteCommand:
    request_id: str
    code: str


@dataclass(frozen=True)
class InterruptCommand:
    request_id: str | None


@dataclass(frozen=True)
class CommReplyCommand:
    comm_id: str
    data: dict[str, object]


@dataclass(frozen=True)
class ShutdownCommand:
    pass


@dataclass(frozen=True)
class EofCommand:
    pass


@dataclass(frozen=True)
class ProtocolErrorCommand:
    error: str


Command: TypeAlias = ExecuteCommand | InterruptCommand | CommReplyCommand | ShutdownCommand | EofCommand | ProtocolErrorCommand


@dataclass(frozen=True)
class ReadyEvent:
    controller_pid: int
    kernel_pid: int


@dataclass(frozen=True)
class StreamEvent:
    request_id: str
    name: str
    text: str


@dataclass(frozen=True)
class ResultEvent:
    request_id: str
    data: dict[str, object]


@dataclass(frozen=True)
class DisplayEvent:
    request_id: str
    data: dict[str, object]
    metadata: dict[str, object]
    transient: dict[str, object]
    update: bool
    text: str


@dataclass(frozen=True)
class ErrorEvent:
    request_id: str
    ename: str
    evalue: str
    traceback: list[str]


@dataclass(frozen=True)
class CommEvent:
    request_id: str
    operation: str
    comm_id: str
    target_name: str | None
    data: dict[str, object] | None


@dataclass(frozen=True)
class DoneEvent:
    request_id: str
    status: str
    result: str | None


@dataclass(frozen=True)
class FailedEvent:
    request_id: str
    error: str


@dataclass(frozen=True)
class InterruptedEvent:
    request_id: str | None
    active: bool


@dataclass(frozen=True)
class ShutdownEvent:
    controller_pid: int
    kernel_pid: int


@dataclass(frozen=True)
class ProtocolErrorEvent:
    error: str


WireEvent: TypeAlias = (
    ReadyEvent
    | StreamEvent
    | ResultEvent
    | DisplayEvent
    | ErrorEvent
    | CommEvent
    | DoneEvent
    | FailedEvent
    | InterruptedEvent
    | ShutdownEvent
    | ProtocolErrorEvent
)


@dataclass
class ExecutionState:
    stdout_chars: int = 0
    stderr_chars: int = 0
    stdout_truncated: bool = False
    stderr_truncated: bool = False


@dataclass
class RuntimeState:
    kernel_pid: int
    kernel_exit: asyncio.Task[int | None] | None = None
    comm_parents: dict[str, dict[str, object]] = field(default_factory=dict)


def _event_payload(event: WireEvent) -> dict[str, object]:
    if isinstance(event, ReadyEvent):
        return {"event": "ready", "controller_pid": event.controller_pid, "kernel_pid": event.kernel_pid}
    if isinstance(event, StreamEvent):
        return {"event": "stream", "id": event.request_id, "name": event.name, "text": event.text}
    if isinstance(event, ResultEvent):
        return {"event": "result", "id": event.request_id, "data": event.data}
    if isinstance(event, DisplayEvent):
        return {
            "event": "display",
            "id": event.request_id,
            "data": event.data,
            "metadata": event.metadata,
            "transient": event.transient,
            "update": event.update,
            "text": event.text,
        }
    if isinstance(event, ErrorEvent):
        return {
            "event": "error",
            "id": event.request_id,
            "ename": event.ename,
            "evalue": event.evalue,
            "traceback": event.traceback,
        }
    if isinstance(event, CommEvent):
        payload: dict[str, object] = {
            "event": "comm",
            "id": event.request_id,
            "operation": event.operation,
            "comm_id": event.comm_id,
        }
        if event.target_name is not None:
            payload["target_name"] = event.target_name
        if event.data is not None:
            payload["data"] = event.data
        return payload
    if isinstance(event, DoneEvent):
        return {"event": "done", "id": event.request_id, "status": event.status, "result": event.result}
    if isinstance(event, FailedEvent):
        return {"event": "failed", "id": event.request_id, "error": event.error}
    if isinstance(event, InterruptedEvent):
        return {"event": "interrupted", "id": event.request_id, "active": event.active}
    if isinstance(event, ShutdownEvent):
        return {"event": "shutdown", "controller_pid": event.controller_pid, "kernel_pid": event.kernel_pid}
    if isinstance(event, ProtocolErrorEvent):
        return {"event": "protocol_error", "error": event.error}
    raise TypeError(f"unsupported controller event: {type(event).__name__}")


class EventWriter:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    async def write(self, event: WireEvent) -> None:
        payload = json.dumps(_event_payload(event), separators=(",", ":"), ensure_ascii=False)
        if len(payload) > _MAX_FRAME_CHARS:
            raise RuntimeError("controller frame exceeds the limit")
        async with self._lock:
            sys.stdout.write(payload + "\n")
            sys.stdout.flush()


def _queue_from_thread(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[Command], command: Command) -> None:
    loop.call_soon_threadsafe(queue.put_nowait, command)


def _read_commands(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue[Command]) -> None:
    while True:
        line = sys.stdin.readline()
        if not line:
            _queue_from_thread(loop, queue, EofCommand())
            return
        try:
            value = json.loads(line)
            command = _parse_command(value)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            command = ProtocolErrorCommand(f"invalid command: {exc}")
        _queue_from_thread(loop, queue, command)


def _parse_command(value: object) -> Command:
    if not isinstance(value, dict):
        return ProtocolErrorCommand("command must be an object")
    operation = value.get("op")
    if operation == "execute":
        request_id = value.get("id")
        code = value.get("code")
        if isinstance(request_id, str) and isinstance(code, str):
            return ExecuteCommand(request_id, code)
        return ProtocolErrorCommand("execute requires string id and code")
    if operation == "interrupt":
        request_id = value.get("id")
        if request_id is None or isinstance(request_id, str):
            return InterruptCommand(request_id)
        return ProtocolErrorCommand("interrupt id must be a string")
    if operation == "comm_reply":
        comm_id = value.get("comm_id")
        data = value.get("data")
        if isinstance(comm_id, str) and isinstance(data, dict):
            return CommReplyCommand(comm_id, {str(key): item for key, item in data.items()})
        return ProtocolErrorCommand("comm_reply requires string comm_id and object data")
    if operation == "shutdown":
        return ShutdownCommand()
    return ProtocolErrorCommand(f"unknown operation: {operation!r}")


def _bounded_stream(state: ExecutionState, name: str, text: str) -> str:
    if name == "stdout":
        used = state.stdout_chars
        truncated = state.stdout_truncated
    else:
        used = state.stderr_chars
        truncated = state.stderr_truncated
    if truncated:
        return ""
    remaining = _MAX_STREAM_CHARS - used
    if len(text) <= remaining:
        output = text
    else:
        marker = "\n[OMP output truncated]\n"
        content_chars = max(0, remaining - len(marker))
        output = text[:content_chars] + marker[: remaining - content_chars]
        if name == "stdout":
            state.stdout_truncated = True
        else:
            state.stderr_truncated = True
    if name == "stdout":
        state.stdout_chars += len(output)
    else:
        state.stderr_chars += len(output)
    return output


def _message_parent_id(message: object) -> str | None:
    if not isinstance(message, dict):
        return None
    parent = message.get("parent_header")
    if not isinstance(parent, dict):
        return None
    request_id = parent.get("msg_id")
    return request_id if isinstance(request_id, str) else None


def _message_content(message: object) -> dict[str, object]:
    if not isinstance(message, dict):
        return {}
    content = message.get("content")
    if not isinstance(content, dict):
        return {}
    return {str(key): value for key, value in content.items()}


def _message_type(message: object) -> str | None:
    if not isinstance(message, dict):
        return None
    header = message.get("header")
    if not isinstance(header, dict):
        return None
    message_type = header.get("msg_type")
    return message_type if isinstance(message_type, str) else None


def _display_text(data: dict[str, object]) -> str:
    plain = data.get("text/plain")
    if isinstance(plain, str):
        return plain
    mime_types = sorted(str(key) for key in data)
    return f"[displayed MIME types: {', '.join(mime_types)}]" if mime_types else "[displayed data]"


def _object_content(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items()}


async def _next_shell_reply(client: AsyncKernelClient, message_id: str) -> dict[str, object]:
    while True:
        message = await client.get_shell_msg()
        if _message_parent_id(message) == message_id and _message_type(message) == "execute_reply":
            return _message_content(message)


async def _restart_kernel(
    manager: AsyncKernelManager,
    client: AsyncKernelClient,
    writer: EventWriter,
    runtime: RuntimeState,
) -> None:
    await manager.restart_kernel(now=True)
    await client.wait_for_ready(timeout=_READY_TIMEOUT_SECONDS)
    provisioner = manager.provisioner
    if provisioner is None:
        raise RuntimeError("jupyter_client did not create a replacement kernel provisioner")
    provisioner_info = await provisioner.get_provisioner_info()
    kernel_pid = provisioner_info.get("pid")
    if not isinstance(kernel_pid, int):
        raise RuntimeError("jupyter_client did not expose the replacement kernel PID")
    runtime.kernel_pid = kernel_pid
    runtime.comm_parents.clear()
    await writer.write(ReadyEvent(os.getpid(), kernel_pid))
    runtime.kernel_exit = asyncio.create_task(_kernel_exit(manager))


async def _send_comm_reply(
    client: AsyncKernelClient,
    command: CommReplyCommand,
    parent: dict[str, object],
) -> None:
    message = client.session.msg(
        "comm_msg",
        content={"comm_id": command.comm_id, "data": command.data},
        parent=parent,
    )
    client.control_channel.send(message)


def _record_comm_parent(runtime: RuntimeState, comm_id: str, message: dict[str, object]) -> None:
    if comm_id not in runtime.comm_parents and len(runtime.comm_parents) >= _MAX_ACTIVE_COMMS:
        runtime.comm_parents.pop(next(iter(runtime.comm_parents)))
    runtime.comm_parents[comm_id] = message


async def _execute(
    manager: AsyncKernelManager,
    client: AsyncKernelClient,
    writer: EventWriter,
    command: ExecuteCommand,
    interrupted: set[str],
    stop_event: asyncio.Event,
    runtime: RuntimeState,
) -> None:
    message_id = client.execute(command.code, allow_stdin=False, stop_on_error=True)
    shell_reply = asyncio.create_task(_next_shell_reply(client, message_id))
    kernel_exit = runtime.kernel_exit
    if kernel_exit is None:
        kernel_exit = asyncio.create_task(_kernel_exit(manager))
        runtime.kernel_exit = kernel_exit
    iopub_message: asyncio.Task[object] | None = asyncio.create_task(client.get_iopub_msg())
    state = ExecutionState()
    result: str | None = None
    error_name: str | None = None
    try:
        while True:
            tasks = {task for task in (iopub_message, kernel_exit) if task is not None}
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            if kernel_exit in done:
                for task in (iopub_message, shell_reply):
                    if task is not None and not task.done():
                        task.cancel()
                await asyncio.gather(
                    *(task for task in (iopub_message, shell_reply) if task is not None),
                    return_exceptions=True,
                )
                iopub_message = None
                try:
                    await _restart_kernel(manager, client, writer, runtime)
                except Exception as exc:
                    await writer.write(FailedEvent(command.request_id, f"kernel exited and restart failed: {exc!r}"))
                    stop_event.set()
                    return
                await writer.write(FailedEvent(command.request_id, "IPython kernel exited unexpectedly; restarted"))
                return
            if iopub_message is None or iopub_message not in done:
                continue
            message = iopub_message.result()
            iopub_message = asyncio.create_task(client.get_iopub_msg())
            if _message_parent_id(message) != message_id:
                continue
            message_type = _message_type(message)
            content = _message_content(message)
            if message_type == "stream":
                name = content.get("name")
                text = content.get("text")
                if name in ("stdout", "stderr") and isinstance(text, str):
                    bounded = _bounded_stream(state, name, text)
                    if bounded:
                        await writer.write(StreamEvent(command.request_id, name, bounded))
            elif message_type == "execute_result":
                data = _object_content(content.get("data"))
                if data:
                    plain = data.get("text/plain")
                    if isinstance(plain, str):
                        result = plain
                    await writer.write(ResultEvent(command.request_id, data))
            elif message_type in ("display_data", "update_display_data"):
                data = _object_content(content.get("data"))
                await writer.write(
                    DisplayEvent(
                        command.request_id,
                        data,
                        _object_content(content.get("metadata")),
                        _object_content(content.get("transient")),
                        message_type == "update_display_data",
                        _display_text(data),
                    )
                )
            elif message_type == "comm_open":
                comm_id = content.get("comm_id")
                target_name = content.get("target_name")
                if isinstance(comm_id, str) and isinstance(target_name, str):
                    if isinstance(message, dict):
                        _record_comm_parent(runtime, comm_id, message)
                    await writer.write(
                        CommEvent(
                            command.request_id,
                            "open",
                            comm_id,
                            target_name,
                            _object_content(content.get("data")),
                        )
                    )
            elif message_type == "comm_msg":
                comm_id = content.get("comm_id")
                data = content.get("data")
                if isinstance(comm_id, str) and isinstance(data, dict):
                    if isinstance(message, dict):
                        _record_comm_parent(runtime, comm_id, message)
                    await writer.write(
                        CommEvent(command.request_id, "msg", comm_id, None, _object_content(data))
                    )
            elif message_type == "comm_close":
                comm_id = content.get("comm_id")
                if isinstance(comm_id, str):
                    runtime.comm_parents.pop(comm_id, None)
                    await writer.write(CommEvent(command.request_id, "close", comm_id, None, None))
            elif message_type == "error":
                ename = content.get("ename")
                evalue = content.get("evalue")
                traceback = content.get("traceback")
                error_name = ename if isinstance(ename, str) else "Error"
                await writer.write(
                    ErrorEvent(
                        command.request_id,
                        error_name,
                        evalue if isinstance(evalue, str) else "",
                        [line for line in traceback if isinstance(line, str)] if isinstance(traceback, list) else [],
                    )
                )
            elif message_type == "status" and content.get("execution_state") == "idle":
                break

        shell_done, _ = await asyncio.wait((shell_reply, kernel_exit), return_when=asyncio.FIRST_COMPLETED)
        if kernel_exit in shell_done:
            for task in (iopub_message, shell_reply):
                if task is not None and not task.done():
                    task.cancel()
            await asyncio.gather(
                *(task for task in (iopub_message, shell_reply) if task is not None),
                return_exceptions=True,
            )
            iopub_message = None
            try:
                await _restart_kernel(manager, client, writer, runtime)
            except Exception as exc:
                await writer.write(FailedEvent(command.request_id, f"kernel exited and restart failed: {exc!r}"))
                stop_event.set()
                return
            await writer.write(FailedEvent(command.request_id, "IPython kernel exited unexpectedly; restarted"))
            return
        reply = shell_reply.result()
        reply_status = reply.get("status")
        if reply_status == "error" and error_name is None:
            ename = reply.get("ename")
            evalue = reply.get("evalue")
            traceback = reply.get("traceback")
            error_name = ename if isinstance(ename, str) else "Error"
            await writer.write(
                ErrorEvent(
                    command.request_id,
                    error_name,
                    evalue if isinstance(evalue, str) else "",
                    [line for line in traceback if isinstance(line, str)] if isinstance(traceback, list) else [],
                )
            )
        if reply_status == "error" or error_name is not None:
            status = (
                "aborted"
                if command.request_id in interrupted
                and (
                    error_name in {"KeyboardInterrupt", "CancelledError"}
                    or evalue == "IPython cell interrupted"
                )
                else "error"
            )
        else:
            status = "ok"
        await writer.write(DoneEvent(command.request_id, status, result))
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await writer.write(FailedEvent(command.request_id, repr(exc)))
    finally:
        for task in (iopub_message, shell_reply):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(
            *(task for task in (iopub_message, shell_reply) if task is not None),
            return_exceptions=True,
        )
        interrupted.discard(command.request_id)


async def _kernel_exit(manager: AsyncKernelManager) -> int | None:
    provisioner = manager.provisioner
    if provisioner is None:
        raise RuntimeError("jupyter_client did not provide a kernel provisioner")
    return await provisioner.wait()


async def _interrupt_active(
    manager: AsyncKernelManager,
    active_task: asyncio.Task[None] | None,
    active_id: str | None,
    interrupted: set[str],
    writer: EventWriter,
    requested_id: str | None = None,
) -> None:
    if requested_id is not None and requested_id != active_id:
        await writer.write(InterruptedEvent(requested_id, False))
        return
    if active_task is None or active_task.done() or active_id is None:
        await writer.write(InterruptedEvent(requested_id, False))
        return
    interrupted.add(active_id)
    await manager.interrupt_kernel()
    await writer.write(InterruptedEvent(active_id, True))
    with suppress(asyncio.TimeoutError):
        await asyncio.wait_for(asyncio.shield(active_task), _SHUTDOWN_TIMEOUT_SECONDS)


async def _shutdown_kernel(manager: AsyncKernelManager, client: AsyncKernelClient) -> None:
    try:
        await asyncio.wait_for(manager.shutdown_kernel(now=False), _SHUTDOWN_TIMEOUT_SECONDS)
    except Exception:
        try:
            await asyncio.wait_for(manager.shutdown_kernel(now=True), _SHUTDOWN_TIMEOUT_SECONDS)
        except Exception as force_error:
            raise RuntimeError("IPython kernel shutdown failed") from force_error
    finally:
        client.stop_channels()


async def _run() -> None:
    writer = EventWriter()
    manager = AsyncKernelManager()
    client: AsyncKernelClient | None = None
    runtime: RuntimeState | None = None
    active_task: asyncio.Task[None] | None = None
    active_id: str | None = None
    interrupted: set[str] = set()
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        loop.call_soon_threadsafe(stop_event.set)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        kernel_spec = manager.kernel_spec
        if kernel_spec is None:
            raise RuntimeError("jupyter_client did not provide a Python kernelspec")
        kernel_spec.argv = [sys.executable, *kernel_spec.argv[1:]]
        kernel_env = dict(os.environ)
        kernel_env["PATH"] = os.path.dirname(sys.executable) + os.pathsep + kernel_env.get("PATH", "")
        kernel_env["PYTHONUNBUFFERED"] = "1"
        kernel_env["PYTHONIOENCODING"] = "utf-8"
        await manager.start_kernel(cwd=os.getcwd(), env=kernel_env)
        client = manager.client()
        client.start_channels()
        ready_task = asyncio.create_task(client.wait_for_ready(timeout=_READY_TIMEOUT_SECONDS))
        stop_task = asyncio.create_task(stop_event.wait())
        done, pending = await asyncio.wait((ready_task, stop_task), return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in pending:
            with suppress(asyncio.CancelledError):
                await task
        if stop_task in done:
            raise RuntimeError("controller shutdown requested during kernel startup")
        await ready_task
        provisioner = manager.provisioner
        if provisioner is None:
            raise RuntimeError("jupyter_client did not create a kernel provisioner")
        provisioner_info = await provisioner.get_provisioner_info()
        kernel_pid_value = provisioner_info.get("pid")
        if not isinstance(kernel_pid_value, int):
            raise RuntimeError("jupyter_client did not expose the kernel PID")
        runtime = RuntimeState(kernel_pid_value)
        await writer.write(ReadyEvent(os.getpid(), runtime.kernel_pid))

        queue: asyncio.Queue[Command] = asyncio.Queue()
        threading.Thread(target=_read_commands, args=(loop, queue), daemon=True).start()
        while True:
            command_task = asyncio.create_task(queue.get())
            stop_task = asyncio.create_task(stop_event.wait())
            done, pending = await asyncio.wait(
                (command_task, stop_task), return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in pending:
                with suppress(asyncio.CancelledError):
                    await task
            if stop_task in done:
                break
            command = command_task.result()
            if isinstance(command, ProtocolErrorCommand):
                await writer.write(ProtocolErrorEvent(command.error))
            elif isinstance(command, CommReplyCommand):
                if client is not None and runtime is not None:
                    parent = runtime.comm_parents.get(command.comm_id)
                    if parent is not None:
                        await _send_comm_reply(client, command, parent)
            elif isinstance(command, ExecuteCommand):
                if active_task is not None and not active_task.done():
                    await writer.write(FailedEvent(command.request_id, "controller is busy"))
                    continue
                if client is None or runtime is None:
                    raise RuntimeError("IPython controller is not ready")
                active_id = command.request_id
                active_task = asyncio.create_task(
                    _execute(manager, client, writer, command, interrupted, stop_event, runtime)
                )
            elif isinstance(command, InterruptCommand):
                await _interrupt_active(
                    manager, active_task, active_id, interrupted, writer, command.request_id
                )
            else:
                break
    finally:
        if client is not None:
            if active_task is not None and not active_task.done():
                await _interrupt_active(manager, active_task, active_id, interrupted, writer)
            if active_task is not None and not active_task.done():
                active_task.cancel()
                await asyncio.gather(active_task, return_exceptions=True)
            if runtime is not None and runtime.kernel_exit is not None and not runtime.kernel_exit.done():
                runtime.kernel_exit.cancel()
                with suppress(asyncio.CancelledError):
                    await runtime.kernel_exit
                runtime.kernel_exit = None
            await _shutdown_kernel(manager, client)
        else:
            with suppress(Exception):
                await asyncio.wait_for(manager.shutdown_kernel(now=True), _SHUTDOWN_TIMEOUT_SECONDS)
        if runtime is not None:
            await writer.write(ShutdownEvent(os.getpid(), runtime.kernel_pid))


async def main() -> None:
    try:
        await _run()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        print(f"ipython controller failed: {exc!r}", file=sys.stderr, flush=True)
        raise


if __name__ == "__main__":
    asyncio.run(main())

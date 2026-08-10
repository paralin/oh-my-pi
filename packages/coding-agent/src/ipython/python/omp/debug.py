"""Session-private Debug Adapter Protocol services."""

from __future__ import annotations

from typing import Any, Literal

from rlm import host_request


async def adapters() -> dict[str, Any]:
    """List available configured debug adapters."""
    return await host_request("debug.adapters", {})


async def sessions() -> dict[str, Any]:
    """Return the active debug session, session tree, and adapter capabilities."""
    return await host_request("debug.sessions", {})


async def launch(
    program: str,
    *,
    args: list[str] | None = None,
    adapter: str | None = None,
    cwd: str = ".",
    timeout: int = 30,
) -> dict[str, Any]:
    """Launch one workspace program through the selected DAP adapter."""
    return await host_request(
        "debug.launch",
        {"program": program, "args": args or [], "adapter": adapter or "", "cwd": cwd, "timeout": timeout},
    )


async def attach(
    *,
    adapter: str | None = None,
    cwd: str = ".",
    pid: int | None = None,
    port: int | None = None,
    host: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Attach one session-private DAP adapter to a process or endpoint."""
    payload: dict[str, Any] = {"adapter": adapter or "", "cwd": cwd, "host": host or "", "timeout": timeout}
    if pid is not None:
        payload["pid"] = pid
    if port is not None:
        payload["port"] = port
    return await host_request("debug.attach", payload)


async def set_breakpoint(file: str, line: int, *, condition: str | None = None, timeout: int = 30) -> dict[str, Any]:
    """Set or replace one source breakpoint."""
    return await host_request(
        "debug.set_breakpoint", {"file": file, "line": line, "condition": condition or "", "timeout": timeout}
    )


async def remove_breakpoint(file: str, line: int, *, timeout: int = 30) -> dict[str, Any]:
    """Remove one source breakpoint."""
    return await host_request("debug.remove_breakpoint", {"file": file, "line": line, "timeout": timeout})


async def set_function_breakpoint(name: str, *, condition: str | None = None, timeout: int = 30) -> dict[str, Any]:
    """Set or replace one function breakpoint."""
    return await host_request(
        "debug.set_function_breakpoint", {"name": name, "condition": condition or "", "timeout": timeout}
    )


async def remove_function_breakpoint(name: str, *, timeout: int = 30) -> dict[str, Any]:
    """Remove one function breakpoint."""
    return await host_request("debug.remove_function_breakpoint", {"name": name, "timeout": timeout})


async def set_instruction_breakpoint(
    instruction_reference: str,
    *,
    offset: int | None = None,
    condition: str | None = None,
    hit_condition: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Set or replace one instruction breakpoint."""
    payload: dict[str, Any] = {
        "instruction_reference": instruction_reference,
        "condition": condition or "",
        "hit_condition": hit_condition or "",
        "timeout": timeout,
    }
    if offset is not None:
        payload["offset"] = offset
    return await host_request("debug.set_instruction_breakpoint", payload)


async def remove_instruction_breakpoint(
    instruction_reference: str, *, offset: int | None = None, timeout: int = 30
) -> dict[str, Any]:
    """Remove one instruction breakpoint."""
    payload: dict[str, Any] = {"instruction_reference": instruction_reference, "timeout": timeout}
    if offset is not None:
        payload["offset"] = offset
    return await host_request("debug.remove_instruction_breakpoint", payload)


async def data_breakpoint_info(
    name: str, *, variable_ref: int | None = None, frame_id: int | None = None, timeout: int = 30
) -> dict[str, Any]:
    """Resolve one adapter data-breakpoint identifier."""
    payload: dict[str, Any] = {"name": name, "timeout": timeout}
    if variable_ref is not None:
        payload["variable_ref"] = variable_ref
    if frame_id is not None:
        payload["frame_id"] = frame_id
    return await host_request("debug.data_breakpoint_info", payload)


async def set_data_breakpoint(
    data_id: str,
    *,
    access_type: Literal["read", "write", "readWrite"] | None = None,
    condition: str | None = None,
    hit_condition: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Set or replace one data breakpoint."""
    return await host_request(
        "debug.set_data_breakpoint",
        {
            "data_id": data_id,
            "access_type": access_type or "",
            "condition": condition or "",
            "hit_condition": hit_condition or "",
            "timeout": timeout,
        },
    )


async def remove_data_breakpoint(data_id: str, *, timeout: int = 30) -> dict[str, Any]:
    """Remove one data breakpoint."""
    return await host_request("debug.remove_data_breakpoint", {"data_id": data_id, "timeout": timeout})


async def continue_(*, timeout: int = 30) -> dict[str, Any]:
    """Continue until the adapter stops, terminates, or reaches the timeout."""
    return await host_request("debug.continue", {"timeout": timeout})


async def pause(*, timeout: int = 30) -> dict[str, Any]:
    """Pause the active debug target."""
    return await host_request("debug.pause", {"timeout": timeout})


async def step_over(*, timeout: int = 30) -> dict[str, Any]:
    """Step over in the active frame."""
    return await host_request("debug.step_over", {"timeout": timeout})


async def step_in(*, timeout: int = 30) -> dict[str, Any]:
    """Step into from the active frame."""
    return await host_request("debug.step_in", {"timeout": timeout})


async def step_out(*, timeout: int = 30) -> dict[str, Any]:
    """Step out of the active frame."""
    return await host_request("debug.step_out", {"timeout": timeout})


async def threads(*, timeout: int = 30) -> dict[str, Any]:
    """Return bounded threads from the active debug-session tree."""
    return await host_request("debug.threads", {"timeout": timeout})


async def stack(*, levels: int | None = None, timeout: int = 30) -> dict[str, Any]:
    """Return bounded stack frames and select the top frame."""
    payload: dict[str, Any] = {"timeout": timeout}
    if levels is not None:
        payload["levels"] = levels
    return await host_request("debug.stack", payload)


async def scopes(*, frame_id: int | None = None, timeout: int = 30) -> dict[str, Any]:
    """Return scopes for an explicit or active frame."""
    payload: dict[str, Any] = {"timeout": timeout}
    if frame_id is not None:
        payload["frame_id"] = frame_id
    return await host_request("debug.scopes", payload)


async def variables(variable_ref: int, *, timeout: int = 30) -> dict[str, Any]:
    """Return bounded variables for one DAP variables reference."""
    return await host_request("debug.variables", {"variable_ref": variable_ref, "timeout": timeout})


async def evaluate(
    expression: str,
    *,
    context: Literal["watch", "repl", "hover", "clipboard", "variables"] = "repl",
    frame_id: int | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Evaluate an expression in an explicit or active debug frame."""
    payload: dict[str, Any] = {"expression": expression, "context": context, "timeout": timeout}
    if frame_id is not None:
        payload["frame_id"] = frame_id
    return await host_request("debug.evaluate", payload)


async def output(*, limit: int = 1024 * 1024) -> dict[str, Any]:
    """Return the bounded tail of adapter and debuggee output."""
    return await host_request("debug.output", {"limit": limit})


async def disassemble(
    instruction_count: int,
    *,
    memory_reference: str | None = None,
    offset: int | None = None,
    instruction_offset: int | None = None,
    resolve_symbols: bool | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Return bounded disassembly from the active debug session."""
    payload: dict[str, Any] = {
        "memory_reference": memory_reference or "",
        "instruction_count": instruction_count,
        "timeout": timeout,
    }
    if offset is not None:
        payload["offset"] = offset
    if instruction_offset is not None:
        payload["instruction_offset"] = instruction_offset
    if resolve_symbols is not None:
        payload["resolve_symbols"] = resolve_symbols
    return await host_request("debug.disassemble", payload)


async def read_memory(
    memory_reference: str, count: int, *, offset: int | None = None, timeout: int = 30
) -> dict[str, Any]:
    """Read bounded base64 memory from the active target."""
    payload: dict[str, Any] = {"memory_reference": memory_reference, "count": count, "timeout": timeout}
    if offset is not None:
        payload["offset"] = offset
    return await host_request("debug.read_memory", payload)


async def write_memory(
    memory_reference: str,
    data: str,
    *,
    offset: int | None = None,
    allow_partial: bool | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """Write bounded base64 memory to the active target."""
    payload: dict[str, Any] = {"memory_reference": memory_reference, "data": data, "timeout": timeout}
    if offset is not None:
        payload["offset"] = offset
    if allow_partial is not None:
        payload["allow_partial"] = allow_partial
    return await host_request("debug.write_memory", payload)


async def modules(*, start: int | None = None, count: int | None = None, timeout: int = 30) -> dict[str, Any]:
    """Return bounded loaded-module metadata."""
    payload: dict[str, Any] = {"timeout": timeout}
    if start is not None:
        payload["start"] = start
    if count is not None:
        payload["count"] = count
    return await host_request("debug.modules", payload)


async def loaded_sources(*, timeout: int = 30) -> dict[str, Any]:
    """Return bounded source metadata known to the active adapter."""
    return await host_request("debug.loaded_sources", {"timeout": timeout})


async def terminate(*, timeout: int = 30) -> dict[str, Any]:
    """Terminate and dispose the active debug-session tree."""
    return await host_request("debug.terminate", {"timeout": timeout})

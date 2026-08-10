# Persistent IPython runtime

OMP presents one fixed interface to every model: `ipython`. A call supplies one
complete `code` cell. The session executes cells one at a time in its retained
IPython process, so variables, imports, the current directory, and useful
Python objects remain available to later cells in the same session. A cell can
be Python or a `%%bash` cell.

The provider interface is deliberately small. It does not change with the
selected model, session configuration, installed extensions, or host
application. The model does not receive separate file, browser, shell,
subagent, or extension function definitions.

## Write a cell

Use ordinary Python for local computation and workspace changes. Keep results
that later cells need in clearly named variables. The host records each cell's
code, output, errors, and bounded presentation in the session journal.

```python
from pathlib import Path

readme = Path("README.md")
heading = readme.read_text().splitlines()[0]
print(heading)
```

A model-originated cell is one exec-level action. `tools.approvalMode` decides whether OMP runs, prompts for,
or rejects the whole cell. OMP does not split a cell into independently
approved operations. Direct cells remain operator actions.

## Use host capabilities through typed Python modules

The IPython process is not a second implementation of host services. OMP keeps
stateful or authority-sensitive operations in the host and exposes narrow,
typed Python modules for them. Import the module that names the service, call
its documented async function, and let the host validate the request and apply
its authority policy.

```python
import omp

status = await omp.code.lsp_status()
answers = await omp.ask.questions([
    {"question": "Continue?", "options": ["Yes", "No"]},
])
```

The `omp` package includes typed domains for session state and artifacts,
language intelligence, debugging, project-scoped long-lived processes, local and
xAI speech-file synthesis, web and GitHub access, remote connections, MCP,
memory, skills, rules, browser and computer control, cron, images, security,
Vibe workers, and World operations. `omp.capabilities()` returns the
runtime's bounded capability index. Each domain keeps its data and side effects
in the host; opaque handles such as browser tabs do not become provider-visible
implementation objects.

`rlm` supplies retained task and agent-family operations. Its companion modules
such as `agent_message`, `agent_observe`, `attach_image`, `compact`, `edit`,
`goal`, and `websearch` are focused Python packages. Read a package's
`SKILL.md` before calling it. Advanced integrations can use the cancellable
`rlm.host_request(type, payload)` primitive, but a typed `omp.*` or skill API is
preferred when one exists.

## Boundary and lifecycle

A typed Python call travels from the active cell to a host handler. The handler
checks the request shape, carries cancellation, applies the session's
permissions, and returns structured data or an error to the cell. The host,
not a provider-supplied callback, retains responsibility for credentials,
browser and computer sessions, MCP connections, persistence, and external
side effects.

The retained kernel ends when its agent session ends. OMP serializes provider
cells, records their results, and reports startup, progress, output, errors,
and cancellation through the same cell presentation. Do not depend on dynamic
provider capability registration or virtual tool-device URLs; neither is part
of the supported interface.

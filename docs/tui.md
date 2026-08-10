# TUI integration

The TUI renders persistent IPython cells and host-service progress. A cell card
shows source, startup and progress updates, bounded output, errors, and the
final status. The same presentation is available to RPC and ACP clients through
session events.

Extensions may request selection, confirmation, input, an editor, notifications,
status text, widgets, title changes, editor text, or a URL through the extension
UI context. The UI is optional. Extensions must tolerate a headless session and
must not make a provider call depend on an unacknowledged presentation update.

Model capabilities are not TUI components. The provider exposes only `ipython`;
typed `omp.*` calls cross into host handlers from the active cell. See
[Persistent IPython runtime](./ipython.md) and [RPC Protocol Reference](./rpc.md).

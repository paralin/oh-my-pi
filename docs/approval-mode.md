# IPython cell approval

OMP applies approval at the persistent IPython boundary. A model-originated
`ipython` request is one executable cell, so one policy decision covers the
whole cell. Direct cells are operator actions and do not enter this path.

## Policy

`tools.approvalMode` selects the session default. An explicit deny stops the cell before the kernel receives it. A prompt asks
once for the complete source. An explicit yolo or auto-approve configuration
runs the cell without a prompt.

In ACP, a client permission channel receives one `ipython` execute request.
An allow-always or reject-always decision is retained until the client changes.
Without an interactive UI or ACP permission channel, a cell that requires
approval fails closed.

## Scope

OMP does not inspect or split Python statements for separate approvals. Use the
host capability modules described in [Persistent IPython runtime](./ipython.md)
when an operation needs host authority. Those handlers validate their typed
requests and retain their own service-specific checks.

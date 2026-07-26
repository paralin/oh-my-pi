# @oh-my-pi/pi-flowgraph

Prototype. Drives one LLM session through an authored flow graph instead of
handing it an open toolbox.

Today an agent writes code in an unbounded action space: every turn it may read
anything, edit anything, run anything, in any order, and it carries the whole
discipline of software engineering in its head at once. This package inverts
that control. The system asks the session a question, the session answers, and
the system decides where to go next.

Entering a node appends that node's prompt as a user message and narrows the
tool surface to that node's allowlist plus two control tools. The node is left
only when the model calls `advance` with an option the graph drew, and only
after the node's deterministic gate has passed. The model still supplies
judgment; it supplies it among the edges we authored.

## Run

```bash
bun packages/flowgraph/src/cli.ts run \
  --graph packages/flowgraph/graphs/go-ladder.json \
  --dir  packages/flowgraph/testdata/scratchpkg \
  --task "Add a Budget type that tracks a spending limit in cents."
```

The walk writes a JSONL trajectory. `--model` takes `provider:model-id` and
resolves against the bundled catalog, defaulting to
`openrouter:anthropic/claude-sonnet-4.5`; the provider's environment key must be
present.

## Watch

```bash
bun packages/flowgraph/src/cli.ts view \
  --graph packages/flowgraph/graphs/go-ladder.json \
  --trajectory <trajectory.jsonl>
```

Renders the graph with the current node highlighted, streaming new records over
SSE off a filesystem watch. Open it before starting a walk to follow the session
live.

## Graph format

A graph is data, so improving agent behaviour is an edit to JSON rather than a
change to prose the model may or may not honour. Each node carries:

| Field | Meaning |
| --- | --- |
| `prompt` | Handlebars template injected as a user message on entry. `{{task}}` is the parent objective. |
| `tools` | Names from the workspace tool table. Everything else is invisible at this node. |
| `why` | Question answered as typed data on every exit, recorded beside the files the node touched. |
| `gate` | Command that must pass before the node may exit. `emptyOutput` also requires empty output, for reporters like `gofmt -l` that exit zero while complaining. |
| `edges` | The options the model chooses between. The chosen option selects the edge, so flow out of a node differs by answer. |

Every node also offers `escape_graph`: the legal exit when the graph is wrong
for the work, which ends the walk with a recorded reason instead of forcing a
bad trajectory.

## Trajectory

The trajectory is the product, not a debugging aid. `walk_start`, `node_enter`,
`gate_result`, `why_answer`, `node_exit`, `escape`, and `walk_end` records make
the walk a causal trace: every line in the final diff was produced at a known
node, in answer to a known question, with a recorded rationale.

## Sample graph

`graphs/go-ladder.json` encodes the Go ladder: read the package's godoc, add one
struct, iterate its fields until confirmed, add stubs with no bodies, pseudocode
each body as comments, fill the bodies one function at a time, then pass a
`go vet` gate. The why-question is asked at struct, field-set, and function
grain. `fill_bodies` carries a back edge to `add_struct` for when implementation
reveals a second type is genuinely needed.

# @oh-my-pi/pi-flowgraph

Prototype. Drives one LLM session through an authored flow graph instead of
handing it an open toolbox.

Today an agent writes code in an unbounded action space: every turn it may read
anything, edit anything, run anything, in any order, and it carries the whole
discipline of software engineering in its head at once. This package inverts
that control. The system asks the session a question, the session answers, and
the system decides where to go next.

A node is a form, not a session state. It shows the observations the engine
gathered on the model's behalf, states what to decide, names the typed blank it
collects, and lists the options it will accept. The model has exactly one tool,
`answer`, for the whole walk. It calls that tool once with the option it chose,
why it chose it, and the payload the step asked for; the engine validates the
option against the node's edges, applies the payload to the artifact itself, and
runs the node's gate before moving on.

Two consequences follow. Off-graph actions stop being expressible, because there
is no tool that writes a file, so a fill-body step cannot quietly re-emit the
type it was not asked about. And the cached prompt prefix stops moving: system
prompt, orientation, and the `answer` schema are identical from the first node to
the last, so per-node variation rides in appended user messages rather than in a
swapped tool set.

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

`--context` selects how much of the walk's past each request carries: `session`
(default) keeps one growing conversation, `ledger` replaces each finished node's
turn with its typed answer, and `stateless` sends the constant prefix plus this
node's question alone. See Cost before reaching for the last two.

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
| `context` | Observations the engine gathers for this question: package docs, existing sources, the artifact so far, a build, a vet, the unimplemented list. |
| `payload` | The typed blank this node collects. The engine applies it, so the grain of an edit belongs to the graph rather than to the model's restraint. |
| `why` | Question the answer's `why` must address, recorded beside the payload it explains. |
| `gate` | Command that must pass before the node may exit. A failed gate rolls the payload back and keeps the model in the node. `emptyOutput` also requires empty output, for reporters like `gofmt -l` that exit zero while complaining. |
| `edges` | The options the model chooses between. The chosen option selects the edge, so flow out of a node differs by answer. |

Every node also offers `escape`: the legal answer when the graph is wrong for the
work, which ends the walk with a recorded reason instead of forcing a bad
trajectory.

## Trajectory

The trajectory is the product, not a debugging aid, and it is no longer
reconstructed from tool events. Each `answer` record is the model's own call:
node, option, `why`, and typed payload, beside what the engine did with it. With
`walk_start`, `node_enter`, `gate_result`, `request`, and `walk_end` around it,
every line in the final diff is traceable to the question that produced it.

## Cost

```bash
bun packages/flowgraph/src/cli.ts report --trajectory <trajectory.jsonl>
```

Prints one row per provider request. The headline total hides the question that
decides whether the design works, which is where the tokens land: a walk whose
prefix stays stable pays cache-read rates for nearly all of its traffic, and a
walk that rewrites its own history pays cache-write rates instead. The recorded
trials are in `testdata/runs/`.

## Sample graph

`graphs/go-ladder.json` encodes the Go ladder: read the package, declare one
struct, settle its fields, declare stubs with final signatures, plan every body,
fill the bodies one at a time, then pass a `go vet` gate. The why-question is
asked at struct, field-set, signature, plan, and body grain. `fill_body` carries
a self edge for the next body and a back edge to `declare_struct` for when
implementation reveals a second type is genuinely needed.

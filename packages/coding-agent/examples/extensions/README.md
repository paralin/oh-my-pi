# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/chalk-logger.ts

# Or copy to extensions directory for auto-discovery
cp examples/extensions/chalk-logger.ts ~/.omp/agent/extensions/
```

## Examples

| Extension | Description |
| --- | --- |
| `chalk-logger.ts` | Uses chalk from parent node_modules. |
| `pirate.ts` | Adds a system-prompt suffix. |
| `thinking-note.ts` | Adds display-only UI below assistant thinking blocks. |

## Writing Extensions

```typescript
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.input.code.includes("rm -rf")) {
			const ok = await ctx.ui.confirm("Dangerous!", "Allow this IPython cell?");
			if (!ok) return { block: true, reason: "Blocked by user" };
		}
	});

	pi.registerCommand("hello", {
		description: "Say hello",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Hello!", "info");
		},
	});
}
```

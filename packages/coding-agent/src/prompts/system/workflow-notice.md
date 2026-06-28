<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic multi-subagent workflow. Use the `task` tool for batched fan-out — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before you commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). This overrides any default tendency to do the whole task inline when fanning out would be more thorough.

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline FIRST (list the files, scope the diff, find the call sites) to discover the work-list, then fan out over it — you don't need to know the shape before the *task*, only before the *fan-out*. Common shapes:
- **Understand** — parallel readers over subsystems → structured map
- **Design** — judge panel of N independent approaches → scored synthesis
- **Review** — split into dimensions → find per dimension → adversarially verify each finding
- **Research** — multi-modal sweep → deep-read the hits → synthesize
- **Migrate** — discover sites → transform each → verify
</when>

<execution>
- Decompose the surface first; capture it in `todo` when it spans phases.
- Batch independent subagents in one `task` call when the available `task` schema supports batching; otherwise issue independent task calls in the same assistant turn.
- Give every subagent a narrow target, explicit non-goals, and a concrete return packet. Shared background goes in a `local://` file referenced from each prompt, not pasted repeatedly.
- After fan-out returns, YOU own correctness: read the artifacts, run the gate, verify before acting. Subagents do the legwork; they don't get the last word.
- Keep going until the task is closed — a returned fan-out is a step, not a stopping point.
</execution>
</system-notice>

# Authoring an extension

An extension adds host-side prompt context, commands, rules, skills, and UI
behavior. It does not add a provider function. Models always execute through
the fixed persistent IPython interface.

Put reusable model workflows in a Python skill package with a `SKILL.md` beside
its importable module. Put resource-owning or authority-sensitive behavior in a
typed host handler and export a narrow async function under `omp.*`. The handler
validates arguments, carries cancellation, and keeps credentials and host
handles outside the provider boundary.

Extensions may use the extension UI context for optional interaction and may
observe session lifecycle events. They must work without a UI, keep persisted
state in namespaced session entries, and avoid storing secrets in prompt or
transcript text. See [Persistent IPython runtime](../ipython.md) and
[Skills](../skills.md).

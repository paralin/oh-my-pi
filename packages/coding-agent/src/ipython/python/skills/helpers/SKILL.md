---
name: helpers
description: Read bounded file ranges, search bounded workspace text, and run finite commands through OMP process custody from the persistent IPython kernel.
type: python
python_import: helpers
python_callable: run
---

# Helpers

OMP preloads the three public functions directly in every managed kernel:

    show("src/app.py", 40, 90)
    rg(r"TODO|FIXME", "src", "test")
    await run(["git", "status", "--short"])

`show()` reads a bounded one-based inclusive line range. `rg()` searches a
bounded number of workspace files and returns bounded matching lines. Both
confine paths to the project or managed artifact directory. `run()` accepts an
argv sequence or a shell-like string that is split into argv without invoking a
shell. It delegates to `omp.process.run()` and returns bounded stdout and stderr
tails plus the complete transcript path.

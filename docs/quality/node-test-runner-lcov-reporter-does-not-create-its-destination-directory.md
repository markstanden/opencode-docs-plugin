---
Area: quality
Keywords: node:test, lcov reporter, test-reporter-destination, ENOENT, mkdir, coverage directory, CI failure
Summary: The Node test runner's lcov reporter does not create its destination directory — a fresh checkout fails with ENOENT exit 7 until something mkdir -p's it first.
---

# Node test-runner lcov reporter does not create its destination directory

Discovered 2026-11-05 on opencode-docs-plugin PR #10: the SonarQube pipeline's
`Test with coverage` step failed in CI while the identical command passed
locally.

## Facts

- `node --test --experimental-test-coverage --test-reporter=lcov
--test-reporter-destination=coverage/lcov.info` opens the destination file
  directly and does **not** create intermediate directories (observed on Node
  v26.13.0).
- On a machine where `coverage/` already exists from a previous run, the
  command passes — masking the bug locally. On a fresh CI checkout it fails
  with `Error: ENOENT: no such file or directory, open 'coverage/lcov.info'`,
  `Process completed with exit code 7`.

## Tested

- Root-cause fix in the shared script, not in the workflow caller:
  `"test:coverage": "mkdir -p coverage && node --test …"`. Proven by
  `rm -rf coverage` locally (reproducing CI exactly), then rerunning — exit 0
  and `coverage/lcov.info` written; `defined comply` still compliant.
  Shipped as 4afa599, merged in opencode-docs-plugin #10.

## Inferred

- Any `--test-reporter-destination=<path-in-subdir>` has the same trap; a
  destination in the repo root would not need the mkdir.
- The same applies to the v8/JSON coverage reporters' destination handling —
  untested, but the reporter layer appears to do no filesystem setup.

## Failed approaches

- None needed: putting `mkdir -p` in the workflow step would also work but
  duplicates the guard per caller; the script is the one place every caller
  gets the fix.

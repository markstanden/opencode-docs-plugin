---
Area: Testing
Keywords: defined, gate, eslint, repair, snapshot, materialise, coverage, lcov, prod014
Summary: The defined gate's eslint repair reformats prod014/campaign/active sources, which invalidates active/snapshot.json; materialised tests then fail and the lcov-only reporter shows the gate only 'node-coverage: exit 1: no output'. Commit the repaired formatting and regenerate the snapshot with materialise.mts --snapshot.
---

# The gate's repair invalidates the materialised campaign snapshot

Recorded 2026-11-14 while gating the judge-output recovery branch of
`opencode-docs-plugin` (base `2870d90`).

## Facts

- `defined comply` runs an eslint repair pass (`eslint --fix`). On a tree whose
  `prod014/campaign/active/*` sources are not already in the gate's format, the
  repair rewrites `run.mts`, `close-campaign.mts`, `contracts.mts` and other
  active sources.
- `active/snapshot.json` pins the SHA-256 of every active source, and
  `materialise.mts` refuses to publish a campaign whose sources no longer match
  it (`active source changed: run.mts`). Every materialised test then fails.
- With the coverage command's single `--test-reporter=lcov`, those failures are
  invisible on the console: the gate reports only
  `node-coverage: coverage command failed: exit 1: no output`. The lcov file is
  still written, which is the tell that the suite ran and a test failed.
- Reproduced by running the suite on the gate's repaired tree: the materialised
  tests fail with `active source changed`, while the same commit on a clean
  checkout passes `npm test`.
- Reproduction used `active/snapshot.json` hash checking directly; `podman`
  was not needed beyond the gate itself.

## Inferred

- The gate is not wrong to format the sources: the committed formatting was
  simply not the gate's. The failure is self-inflicted by a snapshot that
  describes pre-repair bytes.
- Any commit that changes `active/` without regenerating the snapshot will be
  repaired by the gate and then fail its own tests. The same trap applies to
  the pinned runner modules (`runner.json`) when `analysis/` changes.

## Tested

- Adopting the gate's repaired formatting into the working tree, regenerating
  the snapshot and pins with `materialise.mts <root> --snapshot`, and committing
  both made the repair pass a no-op; the next gate run had no eslint or coverage
  finding.
- Focused suites (`judge-recovery-policy`, `judge-recovery-driver`,
  `judge-output-taxonomy`, `campaign-judge-path`, `campaign-status`) passed on
  the adopted tree before the gate re-run.

## Failed approaches

- Treating `node-coverage: exit 1: no output` as a coverage/tooling fault: the
  real message was a stale snapshot.
- Re-running the unchanged gate command: repairs are deterministic, so it fails
  identically until the repaired bytes are committed.

## Open questions

- Whether `defined` could regenerate a consumer-declared derived snapshot after
  repair, or at least name the repaired files when a later step fails.

---
Area: testing
Keywords: mutation, snapshot, policy, symlink, git-state, minwrites, recording, invalid
Summary: Write detection snapshots work/lakes/config-home with symlinks, reports git state separately, and policy-bearing cases fail on out-of-policy writes or unmet recording minimums.
---

# Mutation snapshots, policies and the recording minimum

### Facts

- The write-detection snapshot walks `work`, `lakes` and `config-home` with
  lstat: file content hashes, directory presence, permission bits, symlink
  targets and kind changes (file replaced by link, retargeting). A
  permission-only change (chmod without content change) is a modification
  recorded as `(mode)`; a chmod-only write invalidates a decision-only run.
  An unreadable directory is recorded as an explicit `dir-unreadable`
  entry — never documented as an empty, successful inventory. Git-state
  changes (`.git/HEAD`, index, refs) are reported separately as `git:` from
  a separately-hashed state map and never counted as trial writes.
- The snapshot proves final-state changes only; a transient write that
  reverts between snapshots is invisible without execution instrumentation.
  The run also stores a digest of the recorded final state in meta.json,
  so judging re-verifies the live tree — mutation evidence edited after the
  run is refused, not graded.
- Cases may declare a `mutationPolicy`: `allowed` path globs and optional
  `runtimeAllow` for genuine CLI-owned state. A policy-bearing case with
  out-of-policy writes is invalid to judge regardless of `--allow-writes`
  (the flag widens only the legacy decision-only baseline); `minWrites`
  makes a recording case whose session wrote nothing (whatever it claimed)
  deterministically invalid before any semantic judge.
- Container trials leave `config-home` empty; no blanket runtime allowance
  is configured.

### Tested

- `tests/harness.test.ts` F04 + M08 groups: symlink addition, file→link
  replacement, retargeting, config-home addition, git-state separation,
  in-policy and out-of-policy writes, legacy `--allow-writes` semantics,
  chmod-only mutations (mode change on the fixture config), an unreadable
  directory recorded as evidence, structured writes reporting (counts from
  mutation evidence, plus violation counts, not report-line counting), and
  (live) a workhorse trial that claimed a write it never made being caught
  by the recording minimum.

### Inferred

- "The model says it wrote" stays insufficient evidence; only the snapshot,
  the policy, the recording minimum and — for recording cases — the
  `expectedDocs` artefact gate make a recording case judgeable.

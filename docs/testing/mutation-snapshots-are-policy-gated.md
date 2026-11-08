---
Area: testing
Keywords: mutation, snapshot, policy, symlink, git-state, minwrites, recording, invalid
Summary: Write detection snapshots work/lakes/config-home with symlinks, reports git state separately, and policy-bearing cases fail on out-of-policy writes or unmet recording minimums.
---

# Mutation snapshots, policies and the recording minimum

### Facts

- The write-detection snapshot walks `work`, `lakes` and `config-home` with
  lstat: file content hashes, directory presence, symlink targets, kind
  changes (file replaced by link, retargeting) and mode changes. Git-state
  changes (`.git/HEAD`, index, refs) are reported separately as `git:` lines
  and never counted as trial writes.
- The snapshot proves final-state changes only; a transient write that
  reverts between snapshots is invisible without execution instrumentation.
- Cases may declare a `mutationPolicy`: `allowed` path globs and optional
  `runtimeAllow` for genuine CLI-owned state. A policy-bearing case with
  out-of-policy writes is invalid to judge regardless of `--allow-writes`
  (the flag widens only the legacy decision-only baseline); `minWrites`
  makes a recording case whose session wrote nothing (whatever it claimed)
  deterministically invalid before any semantic judge.
- Container trials leave `config-home` empty; no blanket runtime allowance
  is configured.

### Tested

- `tests/harness.test.ts` F04 group and the live smoke: symlink addition,
  file→link replacement, retargeting, config-home addition, git-state
  separation, in-policy and out-of-policy writes, legacy `--allow-writes`
  semantics, and (live) a workhorse trial that claimed a write it never made
  being caught by the recording minimum.

### Inferred

- "The model says it wrote" stays insufficient evidence; only the snapshot,
  the policy and the recording minimum make a recording case judgeable.

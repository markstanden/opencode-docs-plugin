---
Area: testing
Keywords: provenance, run.json, stamp, resolve, legacy, relabel, freeze, dossier
Summary: Stamp provenance and selection come from a frozen run.json; legacy stamps render as visibly unknown, and latest resolves by creation order.
---

# Reports render frozen stamp descriptions, never current inputs

### Facts

- Every run (and the wrapper's host-side `describe`) freezes
  `results/<stamp>/run.json`: schema-versioned, containing the selected case
  ids and definitions, model/variant, timeout, plugin content identity
  (package.json + src/index.ts + src/SKILL.md + CONVENTION.md + lockfile
  hash), CLI version, the actual execution boundary (container vs host,
  image id) and the harness version.
- `summary` and `export` read that description plus per-case artefacts only:
  a later reporting invocation, a changed model/corpus/guidance, or unrelated
  report flags cannot relabel an old stamp. Per-case metadata that
  contradicts the stamp renders an explicit `[model: …]` suffix.
- A stamp without `run.json` (legacy) renders `unknown (legacy)` labels and
  `(legacy run)` expectations; it never adopts current reporting inputs.
- `judge`/`summary`/`export` either take an explicit `--stamp` or resolve the
  most recently created stamp from run.json createdAt (_mtime only for
  legacy); name-friendly orderings like "zebra" before "alpha" cannot win
  on name order.

### Tested

- `tests/harness.test.ts` F02/F06 groups: paired experiments across model,
  corpus and plugin changes render original labels; legacy stamps label
  unknown; creation-order latest beats lexicographic order; absent roots and
  unknown stamp names fail with the path.
- Live smoke: re-exporting three real stamps after mutating (editing
  expectations and appending a case to) the smoke corpus left every stamped
  label intact, each dossier carrying one case only.

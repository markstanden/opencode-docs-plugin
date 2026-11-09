---
Area: testing
Keywords: docs-lock, housekeeping, mutation gate, recording trials, lock lifecycle, create, replace
Summary: A successful plugin write leaves an empty .docs-lock directory beside its target; the recording gate permits exactly that shape at an ancestor of the expected document, and nothing else.
---

# The plugin leaves an empty .docs-lock directory

### Facts

- The docs plugin coordinates publication with a lock file inside a hidden
  `.docs-lock` directory sited beside the target's deepest existing
  ancestor. Release removes the lock file but not the directory, so a
  successful create or replace can leave an empty `…/.docs-lock` behind.
- The recording gate's unrelated-surface check previously treated that
  directory as an unrelated change, invalidating an otherwise valid
  authorised write (observed on a Crouton W01 creation:
  `added lakes/docs/.docs-lock (dir)`).
- The gate now permits only this narrow shape, taken from the recorded
  final tree: an ADDED, empty, readable directory whose basename is exactly
  `.docs-lock`, inside the documentation surface, whose parent is an
  ancestor directory of an expected document (the target's own directory
  for a replace; the target's directory or a higher existing ancestor for a
  create).
- Everything else still fails: a directory holding any child (including a
  stale `.lock` file), a symlink or unreadable directory, a `.docs-lock`
  whose parent is not an ancestor of the expected document, and any other
  path. A lock directory alone is not a write: a case with no created
  knowledge doc still refuses with "no created knowledge doc".

### Tested

- `tests/harness.test.ts` L01 group: an empty lock directory beside a valid
  creation and beside a valid replacement passes; a stale lock file, a
  symlinked lock directory, a lock directory away from the expected
  document and a lock directory with no document all fail with the
  appropriate gate reason.
- The earlier C01/M05 groups still refuse unrelated directories and extra
  edits beside valid writes.

### Open questions

- None. Directory-only cleanup by the plugin would remove the artefact, but
  that is plugin behaviour and not needed for correct measurement.

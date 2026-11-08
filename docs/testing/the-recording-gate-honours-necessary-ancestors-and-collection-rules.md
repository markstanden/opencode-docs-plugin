---
Area: testing
Keywords: recording-gate, expected-docs, ancestor-directories, uncollected-segment, hidden-doc, excluded-area, mutation-policy, knowledge-lake
Summary: The trial's artefact gate permits the newly created ancestor directories of an expected doc and refuses created docs the plugin's collector never indexes, mirroring uncollectedSegment.
---

# The recording gate honours necessary ancestors and the collection rules

### Facts

- Creating `lakes/docs/decisions/record.md` must also create
  `lakes/docs/decisions`, so the gate's unrelated-change check permits
  newly added directories that are plain ancestors of an expected
  document (`necessaryAncestorDirs`). The permitted case is the parent-of
  chain only: an extra empty directory, a symlinked directory, a mode
  change or an extra file beside the expected write still counts as an
  unrelated change, and a directory-only write still cannot satisfy a
  required knowledge write. The refusal names each unrelated change with
  its recorded kind — a symlinked ancestor is reported as
  `added ... (symlink)`, never tolerated as a necessary plain directory.
  Recorded mutation evidence carries those kinds: `meta.json`'s
  `writeKinds.kinds` is written in object form (a bare `Map` serialised
  to `{}` — every recorded change label used to be lost) and restored to
  a Map before the gate reduces over it.
- A created document the plugin would never collect is refused before
  any semantic judging. The gate mirrors the plugin's
  `uncollectedSegment` rule (`uncollectableDocReason`): a dot directory
  or `node_modules` segment at any depth, or a knowledge-lake excluded
  area (`plans/`, `requirements/`, `wiki/`) at the lake root, is
  uncollectable, so a hidden `.hidden.md` or a doc under a scratch area
  is not discoverable knowledge and cannot satisfy a recording case.
  Lake-relative resolution uses the anchors the case's own mutation
  policy implies (`x/**` pattern → tree at `x`) instead of recomputing
  the trial's lake config.
- Structural validity, required/absent content, link references,
  preserved paths, wrong-target, deletion and digest-verification checks
  are unchanged by this correction.

### Tested

- `tests/harness.test.ts` C01 group on the real W01 corpus case: a valid
  creation in a new subdirectory (rejected as "unrelated change" before
  the fix), a valid creation in the existing area, an extra unrelated
  directory beside a valid creation, a symlinked ancestor whose kind is
  reported in the refusal (tolerated as a plain ancestor before the
  fix), a hidden `.hidden.md` target (admitted and semantically judged
  before the fix), a `node_modules`-nested doc, a deeper `kb/plans/`
  creation that stays collectable (the exclusion is lake-root only),
  and a doc under an excluded area. The M05 counterexamples — including
  two valid creations refusing as "several docs" — keep their recorded
  reasons.

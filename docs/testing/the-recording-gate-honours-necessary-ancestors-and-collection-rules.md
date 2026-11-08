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
  required knowledge write.
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
  directory beside a valid creation, a hidden `.hidden.md` target
  (admitted and semantically judged before the fix), and a doc under an
  excluded area. The M05 counterexamples keep their recorded reasons.

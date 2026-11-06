---
Area: quality
Keywords: symlink publication, exclusive temp, O_EXCL, publication redirect, temp file safety
Summary: Publication temps must be exclusively created and written through their own descriptor: predictable writeFileSync names followed pre-existing symlinks outside the lake.
---

# An exclusive temp create closes the publication symlink redirect

### Facts

- The reviewed replacement published through a predictable pathname
  (`${target}.${pid}.${counter}.tmp`) written with plain `writeFileSync`, and
  the lock directory creation accepted symlinks. A pre-existing symlink at a
  temp name is followed: an external fixture was overwritten, the target
  became the symlink, and the call reported success — no live race required.
- The fix creates the temp with an exclusive open (`openSync(path, "wx")`,
  `defaultTempFactory`), writes the whole sequence **through the returned
  descriptor** (never reopening the pathname), and renames atomically. An
  `EEXIST` on a candidate name — a seeded symlink, foreign file or directory
  — neither follows, truncates, nor removes the foreign object; the retry
  loop is bounded (`MAX_TEMP_ATTEMPTS`) over fresh counter names.
- Operational paths get the same containment as document paths: a lock
  directory that is a symlink or non-directory is refused before any writing
  (`ensureLockDirectory`), and the configured root's symlink allowance still
  works (S09).
- Full bytes are mandatory: `writeFullBytes` loops over short writes and
  throws on a stall, so a revision is never reported for bytes not fully
  stored (S12).
- Cleanup is ownership-scoped: on ordinary failure only the temp this
  operation exclusively created is unlinked (a failed create unlinks only its
  own `wx`-created target); the outer `finally` releases the held lock.

### Tested

- S01/S02: pre-existing symlinked and regular-file temp names survive intact.
- S03/S04: root-adjacent and target-adjacent `.docs-lock` symlinks, foreign
  files and directories all refuse without external writes.
- S07/S08: injected mid-write and rename failures keep the original bytes,
  clean only owned artifacts, and leave a foreign `.tmp` file untouched.
- S05/S06/S09/S10/S11/S12 in tests/publication.test.ts: exclusive ownership,
  correct bytes with an external `sha256sum` revision, symlinked comfortable
  root writes, document guards retained, artifacts never indexed as docs.

### Tested - threat boundary

- The guarantee covers pre-existing operational-path symlinks and cooperating
  writers, including interrupted operations. A local attacker who can swap
  directories between individual syscalls is outside the model — closing that
  would need per-component `O_NOFOLLOW` opens (documented, not built).

### Open questions

- The temp-name selection seam (`TempFactory`) is injectable behind
  `createLakes(specs, { seams })` so collision tests are deterministic even
  after the names become counter-based.

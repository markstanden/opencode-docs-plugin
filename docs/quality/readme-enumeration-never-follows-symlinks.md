---
Area: quality
Keywords: readme, git, symlink, lstat, ls-files, containment, enumeration
Summary: README enumeration filters with lstat regular-file checks, so symlinked READMEs and links through directories never index outside content.
---

# README enumeration must not follow symlinks

### Facts

- Inside a git work tree, `git ls-files --others` lists even a symlinked
  README.md; the historical filter used `existsSync`, which follows links,
  so a symlink pointing outside the tree could be indexed as the project's
  own documentation. `readmePaths` filters candidates through an lstat
  regular-file check: file symlinks and broken links drop, tracked files
  deleted from disk drop, and the fallback walker keeps its existing
  Dirent.isFile() rule.
- The leaf lstat alone was not containment: a tracked path whose
  intermediate directory had been replaced by a symlink (an ancestor link
  planted over a committed directory) still resolved through the link, and
  the outside file was indexed. Every intermediate component below the
  project root is now lstat-checked as a real directory.

### Tested

- `tests/lakes.test.ts` `readmePaths symlink filtering` block (real git
  repositories): untracked symlinked README excluded via both `readmePaths`
  and `collectReadmes`, broken symlink excluded, untracked and tracked
  regular READMEs included, tracked-then-deleted excluded, the tracked
  nested `docs/README.md` still supported, a README behind a symlinked
  intermediate directory excluded even though git lists the tracked path,
  and the fallback walk filtering a symlink README outside git.

### Open questions

- The containment rule drops a symlinked README even if its target lives in
  the same tree; deliberate (the file is not the repo's own content). If
  linked-README indexing is ever wanted, it needs an allow-list and an
  explicit containment proof, not follow-the-link.
- The project directory itself is the trusted root: when it resolves
  through a symlink, containment is validated from it downward. Components
  above the root are outside the plugin's knowledge scope.

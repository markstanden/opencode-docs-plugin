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
  own documentation. `readmePaths` now filters candidates through an
  lstat regular-file check: file symlinks and broken links drop, tracked
  files deleted from disk drop, and the fallback walker keeps its existing
  Dirent.isFile() rule.

### Tested

- `tests/lakes.test.ts` `readmePaths symlink filtering` block (real git
  repositories): untracked symlinked README excluded via both `readmePaths`
  and `collectReadmes`, broken symlink excluded, untracked and tracked
  regular READMEs included, tracked-then-deleted excluded, the tracked
  nested `docs/README.md` still supported, and the fallback walk filtering a
  symlink README outside git.

### Open questions

- The containment rule drops a symlinked README even if its target lives in
  the same tree; deliberate (the file is not the repo's own content). If
  linked-README indexing is ever wanted, it needs an allow-list and an
  explicit containment proof, not follow-the-link.
